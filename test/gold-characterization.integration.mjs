// Characterization ("freeze behaviour") tests for the order / payment / debt core.
//
// Purpose: lock the CURRENT observable behaviour of the gold-aware order flow before the
// gold module is split out of the POS core (see the modular refactor plan). Every refactor
// step must keep this file green. It exercises the real Pages Function handlers against a
// real Neon database inside a throw-away tenant that is deleted afterwards.
//
// Run:  DATABASE_URL=<non-production neon url> npm run test:integration
// (falls back to .dev.vars, exactly like atomic.integration.mjs — point that at a test DB.)
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { neon } from "@neondatabase/serverless";
import { createToken } from "../functions/_auth.js";
import { onRequest as ordersHandler } from "../functions/api/orders/index.js";
import { onRequest as orderHandler } from "../functions/api/orders/[id].js";
import { onRequest as paymentsHandler } from "../functions/api/payments/index.js";
import { onRequest as debtHandler } from "../functions/api/customers/[id]/debt.js";

async function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const vars = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
  return vars.match(/^DATABASE_URL=(.+)$/m)?.[1];
}

const id = () => crypto.randomUUID();

test("gold-aware order, payment and debt behaviour is frozen", async (t) => {
  const url = await databaseUrl();
  assert.ok(url, "DATABASE_URL is required");
  const sql = neon(url);
  const now = new Date().toISOString();
  const tenantId = id(), roleId = id(), userId = id(), productId = id(), variantId = id();
  const secret = `characterization-${id()}`;
  const env = { DATABASE_URL: url, JWT_SECRET: secret };
  const token = await createToken({ userId, tenantId, email: "char@test.local" }, secret);

  const newCustomer = async (name) => {
    const customerId = id();
    await sql`INSERT INTO customers (id, tenant_id, name, created_at, updated_at)
              VALUES (${customerId}, ${tenantId}, ${name}, ${now}, ${now})`;
    return customerId;
  };

  await sql.transaction([
    sql`INSERT INTO tenants (id, name, slug, status, created_at, updated_at)
        VALUES (${tenantId}, 'Characterization', ${`char-${tenantId}`}, 'active', ${now}, ${now})`,
    sql`INSERT INTO roles (id, tenant_id, name, permissions, created_at)
        VALUES (${roleId}, ${tenantId}, 'Tester', '["*"]', ${now})`,
    sql`INSERT INTO users (id, tenant_id, role_id, name, email, status, created_at, updated_at)
        VALUES (${userId}, ${tenantId}, ${roleId}, 'Tester', ${`char-${userId}@test.local`}, 'active', ${now}, ${now})`,
    sql`INSERT INTO products (id, tenant_id, sku, name, base_price, status, created_at, updated_at)
        VALUES (${productId}, ${tenantId}, ${`P-${productId}`}, 'Char product', 1000, 'active', ${now}, ${now})`,
    sql`INSERT INTO product_variants (id, product_id, tenant_id, sku, attributes, price, created_at)
        VALUES (${variantId}, ${productId}, ${tenantId}, ${`V-${variantId}`}, '{}', 1000, ${now})`,
    sql`INSERT INTO stock_snapshots (product_variant_id, tenant_id, qty, updated_at)
        VALUES (${variantId}, ${tenantId}, 10, ${now})`,
  ]);

  t.after(async () => {
    await sql`DELETE FROM api_idempotency_keys WHERE tenant_id = ${tenantId}`;
    await sql`DELETE FROM payments WHERE tenant_id = ${tenantId}`;
    await sql`DELETE FROM inventory_transactions WHERE tenant_id = ${tenantId}`;
    await sql`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE tenant_id = ${tenantId})`;
    await sql`DELETE FROM orders WHERE tenant_id = ${tenantId}`;
    await sql`DELETE FROM customer_debt_adjustments WHERE tenant_id = ${tenantId}`;
    await sql`DELETE FROM customers WHERE tenant_id = ${tenantId}`;
    await sql`DELETE FROM stock_snapshots WHERE tenant_id = ${tenantId}`;
    await sql`DELETE FROM product_variants WHERE tenant_id = ${tenantId}`;
    await sql`DELETE FROM products WHERE tenant_id = ${tenantId}`;
    await sql`DELETE FROM users WHERE tenant_id = ${tenantId}`;
    await sql`DELETE FROM roles WHERE tenant_id = ${tenantId}`;
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`;
  });

  const call = (handler, method, body, { params, key } = {}) => handler({
    env, params,
    request: new Request("https://characterization.test/api", {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key || `char-${id()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  });
  const createOrder = (body) => call(ordersHandler, "POST", body);
  const orderRow = async (orderId) => (await sql`SELECT * FROM orders WHERE id = ${orderId}`)[0];
  const stockQty = async () => (await sql`SELECT qty FROM stock_snapshots WHERE product_variant_id = ${variantId}`)[0].qty;
  const goldItem = (fee) => ({ item_name: "Nhan 99", quantity: 1, unit_price: fee });
  const PRICE = 10_000_000;

  await t.test("retail: total = subtotal - discount - trade_in, stock decremented, paid in full completes", async () => {
    const before = await stockQty();
    const res = await createOrder({
      items: [{ product_variant_id: variantId, quantity: 2, unit_price: 1000 }],
      discount: 100, trade_in_total: 200,
      initial_payment: { amount: 1700, method: "cash" },
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.total, 1700);
    assert.equal(body.gold_debt_99, 0);
    assert.equal(body.paid_total, 1700);
    assert.equal(body.remaining, 0);
    assert.equal(body.status, "completed");
    assert.equal(await stockQty(), before - 2);
    const row = await orderRow(body.order_id);
    assert.equal(row.order_type, "retail");
    assert.equal(Number(row.gold_sold_99), 0);
  });

  await t.test("retail: partial payment stays pending", async () => {
    const res = await createOrder({
      items: [{ product_variant_id: variantId, quantity: 1, unit_price: 1000 }],
      initial_payment: { amount: 400, method: "cash" },
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.status, "pending");
    assert.equal(body.remaining, 600);
  });

  await t.test("retail: insufficient stock is rejected with 409 and nothing is written", async () => {
    const before = await stockQty();
    const res = await createOrder({ items: [{ product_variant_id: variantId, quantity: before + 1, unit_price: 1000 }] });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "INSUFFICIENT_STOCK");
    assert.equal(await stockQty(), before);
  });

  await t.test("wholesale gold: total = fees + converted gold, unconverted gold stays as gold debt", async () => {
    // sold 3 chi, bought back 1 chi => 2 chi remaining; convert 1.5 chi to money, 0.5 chi becomes debt.
    const res = await createOrder({
      order_type: "wholesale", is_quick: true, customer_id: await newCustomer("Gold A"),
      items: [goldItem(200_000)],
      gold_price_99: PRICE, gold_sold_99: 3, gold_bought_99: 1, gold_to_money_99: 1.5,
      making_fee_total: 200_000,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.total, 200_000 + 15_000_000);
    assert.equal(body.gold_debt_99, 0.5);
    const row = await orderRow(body.order_id);
    assert.equal(row.order_type, "wholesale");
    assert.equal(Number(row.gold_debt_99), 0.5);
    assert.equal(Number(row.gold_to_money_99), 1.5);
    assert.equal(Number(row.gold_price_99), PRICE);
    assert.equal(Number(row.making_fee_total), 200_000);
  });

  await t.test("wholesale gold: money paid in full but gold debt left keeps the order pending", async () => {
    const res = await createOrder({
      order_type: "wholesale", is_quick: true, customer_id: await newCustomer("Gold B"),
      items: [goldItem(0)],
      gold_price_99: PRICE, gold_sold_99: 2, gold_to_money_99: 1,
      initial_payment: { amount: PRICE, method: "cash" },
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.total, PRICE);
    assert.equal(body.gold_debt_99, 1);
    assert.equal(body.remaining, 0);
    assert.equal(body.status, "pending");
  });

  await t.test("wholesale gold: all gold left as debt with no gold price still records the debt", async () => {
    const res = await createOrder({
      order_type: "wholesale", is_quick: true, customer_id: await newCustomer("Gold C"),
      items: [goldItem(50_000)], gold_sold_99: 4,
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.total, 50_000);
    assert.equal(body.gold_debt_99, 4);
    assert.equal(body.status, "pending");
  });

  await t.test("wholesale gold: zero balance and no payment settles immediately", async () => {
    const res = await createOrder({
      order_type: "wholesale", is_quick: true, customer_id: await newCustomer("Gold D"),
      items: [goldItem(0)], gold_sold_99: 1, gold_bought_99: 1,
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.total, 0);
    assert.equal(body.gold_debt_99, 0);
    assert.equal(body.status, "completed");
  });

  await t.test("wholesale gold: buy-only order is a negative total and must be refunded, not collected", async () => {
    const customerId = await newCustomer("Gold E");
    const base = {
      order_type: "wholesale", is_quick: true, customer_id: customerId,
      items: [goldItem(0)], gold_price_99: PRICE, gold_bought_99: 1.5, gold_to_money_99: -1.5,
    };
    const wrongWay = await createOrder({ ...base, initial_payment: { amount: 1000, method: "cash" } });
    assert.equal(wrongWay.status, 422);
    assert.equal((await wrongWay.json()).code, "INVALID_PAYMENT_DIRECTION");
    const refund = await createOrder({ ...base, initial_payment: { amount: -15_000_000, method: "cash" } });
    const body = await refund.json();
    assert.equal(refund.status, 201);
    assert.equal(body.total, -15_000_000);
    assert.equal(body.gold_debt_99, 0);
    assert.equal(body.status, "completed");
  });

  await t.test("wholesale gold: invalid conversion and missing price are rejected", async () => {
    const customer_id = await newCustomer("Gold F");
    const tooMuch = await createOrder({
      is_quick: true, customer_id, items: [goldItem(0)],
      gold_price_99: PRICE, gold_sold_99: 1, gold_to_money_99: 2,
    });
    assert.equal(tooMuch.status, 422);
    assert.equal((await tooMuch.json()).code, "INVALID_GOLD_CONVERSION");
    const noPrice = await createOrder({
      is_quick: true, customer_id, items: [goldItem(0)], gold_sold_99: 1, gold_to_money_99: 1,
    });
    assert.equal(noPrice.status, 422);
    assert.equal((await noPrice.json()).code, "INVALID_GOLD_PRICE");
  });

  await t.test("quick (draft) invoice: needs a customer and never touches stock", async () => {
    const before = await stockQty();
    const noCustomer = await createOrder({ is_quick: true, items: [goldItem(1000)] });
    assert.equal(noCustomer.status, 422);
    const ok = await createOrder({ is_quick: true, customer_id: await newCustomer("Quick"), items: [goldItem(1000)] });
    assert.equal(ok.status, 201);
    assert.equal(await stockQty(), before);
  });

  await t.test("idempotent replay returns the same order", async () => {
    const body = { is_quick: true, customer_id: await newCustomer("Replay"), items: [goldItem(1000)] };
    const key = `char-replay-${id()}`;
    const first = await call(ordersHandler, "POST", body, { key });
    const replay = await call(ordersHandler, "POST", body, { key });
    assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
    assert.deepEqual(await replay.json(), await first.json());
  });

  await t.test("payments settle a pending gold order only once the gold debt is also gone", async () => {
    const created = await (await createOrder({
      order_type: "wholesale", is_quick: true, customer_id: await newCustomer("Pay"),
      items: [goldItem(0)], gold_price_99: PRICE, gold_sold_99: 1, gold_to_money_99: 1,
    })).json();
    assert.equal(created.total, PRICE);
    const pay = await call(paymentsHandler, "POST", { order_id: created.order_id, method: "cash", amount: PRICE });
    assert.equal(pay.status, 201);
    const payBody = await pay.json();
    assert.equal(payBody.paid_total, PRICE);
    assert.equal(payBody.remaining, 0);
    assert.equal(payBody.order_completed, true);
  });

  await t.test("editing a pending draft recomputes totals and gold debt from the same formula", async () => {
    const customer_id = await newCustomer("Edit");
    const created = await (await createOrder({
      order_type: "wholesale", is_quick: true, customer_id, items: [goldItem(100_000)],
      gold_price_99: PRICE, gold_sold_99: 2, gold_to_money_99: 1,
    })).json();
    assert.equal(created.gold_debt_99, 1);
    const res = await call(orderHandler, "PUT", {
      customer_id, items: [goldItem(300_000)],
      gold_price_99: PRICE, gold_sold_99: 2, gold_to_money_99: 2,
      additional_payment: { amount: 300_000 + 2 * PRICE, method: "cash" },
    }, { params: { id: created.order_id } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(Number(body.total), 300_000 + 2 * PRICE);
    assert.equal(Number(body.gold_debt_99), 0);
    assert.equal(body.status, "completed");
  });

  await t.test("cancelling an order via DELETE keeps the row and marks it cancelled", async () => {
    const created = await (await createOrder({
      order_type: "wholesale", is_quick: true, customer_id: await newCustomer("Cancel"),
      items: [goldItem(0)], gold_sold_99: 1,
    })).json();
    const res = await call(orderHandler, "DELETE", undefined, { params: { id: created.order_id } });
    assert.equal(res.status, 200);
    assert.equal((await orderRow(created.order_id)).status, "cancelled");
  });

  await t.test("customer debt sums signed money and gold across orders and adjustments", async () => {
    const customerId = await newCustomer("Debt");
    // Order 1: customer owes 600 money and 1 chi gold.
    await createOrder({
      order_type: "wholesale", is_quick: true, customer_id: customerId, items: [goldItem(1000)],
      gold_sold_99: 1, initial_payment: { amount: 400, method: "cash" },
    });
    // Order 2: sold 0.25 / bought back 0.5 => -0.25 chi left; convert -0.1 to money (shop pays 100),
    // so the shop owes the customer 0.15 chi of gold (negative gold debt) and 100 of money.
    await createOrder({
      order_type: "wholesale", is_quick: true, customer_id: customerId, items: [goldItem(0)],
      gold_price_99: 1000, gold_sold_99: 0.25, gold_bought_99: 0.5, gold_to_money_99: -0.1,
    }).then(async res => assert.equal(res.status, 201, await res.clone().text()));
    const adjust = await call(debtHandler, "POST", { money_amount: 100, gold_amount_99: "0.5", note: "no cu" },
      { params: { id: customerId } });
    assert.equal(adjust.status, 201);

    const res = await call(debtHandler, "GET", undefined, { params: { id: customerId } });
    assert.equal(res.status, 200);
    const debt = await res.json();
    // money: (1000-400) + (-100) + 100 = 600 ; gold: 1 + (-0.15) + 0.5 = 1.35
    assert.equal(debt.money_debt, 600);
    assert.equal(debt.gold_debt_99, "1.35");
    assert.equal(debt.orders.length, 2);
    assert.equal(debt.adjustments.length, 1);
  });

  await t.test("cancelled orders drop out of customer debt", async () => {
    const customerId = await newCustomer("DebtCancel");
    const created = await (await createOrder({
      order_type: "wholesale", is_quick: true, customer_id: customerId, items: [goldItem(5000)], gold_sold_99: 2,
    })).json();
    let debt = await (await call(debtHandler, "GET", undefined, { params: { id: customerId } })).json();
    assert.equal(debt.money_debt, 5000);
    assert.equal(debt.gold_debt_99, "2");
    await call(orderHandler, "DELETE", undefined, { params: { id: created.order_id } });
    debt = await (await call(debtHandler, "GET", undefined, { params: { id: customerId } })).json();
    assert.equal(debt.money_debt, 0);
    assert.equal(debt.gold_debt_99, "0");
  });
});
