import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as math from '../public/js/wholesale-math.js';
import { localInvoiceDate } from '../public/js/invoice-date.js';

const html = readFileSync(new URL('../public/orders-wholesale.html', import.meta.url), 'utf8');
function checkout({ sold = 1, bought = 0, conversion = '0', purity = 99 } = {}) {
  const fields = new Map();
  const element = id => {
    if (!fields.has(id)) fields.set(id, { value: '', style: {}, classList: { toggle() {}, add() {}, remove() {} }, focus() {} });
    return fields.get(id);
  };
  element('gold-to-money-99').value = conversion;
  element('gold-price-99').value = '10000000';
  element('cust-id').value = 'customer';
  element('inv-date').value = '2026-10-01';
  element('inv-date').reportValidity = () => true;
  const alerts = [];
  const context = vm.createContext({ ...math, localInvoiceDate, document: { getElementById: element },
    cart: [], customItems: sold ? [{ name: 'Gold', weight: sold, purity, qty: 1, price: 0 }] : [],
    tradeIns: bought ? [{ weight: bought, purity: 99 }] : [],
    goldToMoneyDirty: true, payAmountDirty: false, lastDebtData: null,
    editOrderId: null, isQuickMode: true, fmtVND: String, alert: message => alerts.push(message),
  });
  context.window = context;
  vm.runInContext(html.slice(html.indexOf('function currentGoldTotals()'), html.indexOf('// ── KHÁCH HÀNG AUTOCOMPLETE')), context);
  vm.runInContext(html.slice(html.indexOf('function buildWholesalePayload()'), html.indexOf('window.createWholesaleOrder =')), context);
  return { context, element, alerts };
}

test('checkout preview and saved conversion match for rounded full settlement', () => {
  const { context, element } = checkout({ purity: 68, conversion: '0,687' });
  context.calcTotal();
  const result = context.buildWholesalePayload();
  assert.equal(result.payload.gold_to_money_99, 0.686869);
  assert.equal(element('gold-money-show').textContent, String(result.goldMoneyValue));
  assert.equal(Number(element('pay-amount').value), result.goldMoneyValue);
});

test('buy-only checkout rejects positive conversion and Quy hết selects negative balance', () => {
  const { context, alerts } = checkout({ sold: 0, bought: 1.5, conversion: '1,5' });
  assert.equal(context.buildWholesalePayload(), null);
  assert.match(alerts[0], /-1.5/);
  context.convertAllGold();
  const result = context.buildWholesalePayload();
  assert.equal(result.payload.gold_to_money_99, -1.5);
  assert.equal(result.goldMoneyValue, -15000000);
});

test('changing items cannot submit a stale excessive conversion', () => {
  const { context } = checkout({ sold: 2, conversion: '2' });
  assert.ok(context.buildWholesalePayload());
  context.customItems[0].weight = 1;
  assert.equal(context.buildWholesalePayload(), null);
});

test('malformed conversion is blocked and blank retains gold debt', () => {
  const { context, element } = checkout({ conversion: '1abc' });
  assert.equal(context.buildWholesalePayload(), null);
  element('gold-to-money-99').value = '';
  assert.equal(context.buildWholesalePayload().payload.gold_to_money_99, 0);
});

test('zero conversion never silently converts a small gold debt', () => {
  assert.equal(math.normalizeGoldConversion99(0.0004, 0, 0), 0);
  assert.equal(math.normalizeGoldConversion99(0, 0.0004, 0), 0);
  assert.equal(math.normalizeGoldConversion99(0.0001, 0, -0.0001), -0.0001);
});

test('partial, equal and opposite-direction conversions obey the remaining balance', () => {
  for (const [sold, bought, conversion, valid] of [
    [2, 1, 0.5, true], [1, 2, -0.5, true], [1, 1, 0, true],
    [1, 1, 0.001, false], [1, 0, -0.1, false], [0, 1, 0.1, false],
    [1, 0, 1.001, false], [0, 1, -1.001, false],
  ]) assert.equal(math.isGoldConversionValid(sold, bought, conversion), valid);
});

test('cash preview, full payment and payload use the same rounded prices and discount', () => {
  const { context, element } = checkout({ purity: 68, conversion: '0.687' });
  context.customItems[0].price = 123456.789;
  context.customItems[0].qty = 7;
  element('gold-to-money-99').value = '4.808';
  element('discount-pct').value = '1.234';
  context.calcTotal();
  const { payload, rawPayAmt } = context.buildWholesalePayload();
  const total = payload.items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0)
    + Math.round(payload.gold_to_money_99 * payload.gold_price_99) - payload.discount;
  assert.equal(Number(element('total-show').textContent), total);
  assert.equal(rawPayAmt, total);
  assert.equal(Number(element('debt-show').textContent), 0);
});

test('reopening a draft preserves its exact discount and supports JSON objects and strings', async () => {
  for (const asString of [false, true]) {
    const { context, element } = checkout();
    const encode = value => asString ? JSON.stringify(value) : value;
    Object.assign(context, {
      api: { get: async () => ({
        order: { is_quick: true, status: 'pending', customer_id: 'customer', created_at: '2026-09-15T12:00:00.000Z',
          subtotal: 6633000, discount: 12345, gold_price_99: 13180000,
          gold_to_money_99: 0, trade_in_details: encode([{ weight: 19, purity: 97.5 }]) },
        items: [{ item_name: 'Gold', quantity: 1, unit_price: 6633000,
          metal_details: encode({ metalType: 'gold', purity: 98, netWeight: 22 }) }],
      }) },
      custSearch: {}, onQuickModeToggle() {}, renderCart() {}, renderCustomItems() {}, renderTradeIns() {},
    });
    vm.runInContext(html.slice(html.indexOf('async function loadOrderForEdit('), html.indexOf('// Init\n')), context);
    await context.loadOrderForEdit('draft');
    assert.equal(element('inv-date').value, '2026-09-15');
    assert.equal(element('inv-date').disabled, true);
    const { payload } = context.buildWholesalePayload();
    assert.equal(payload.discount, 12345);
    assert.equal(payload.gold_sold_99, 21.777778);
    assert.equal(payload.gold_bought_99, 18.712121);
    assert.equal(Number(element('total-show').textContent), 6620655);
  }
});

test('Anh Bang: conversion follows net gold after old debt, including a reversed direction', () => {
  const { context, element } = checkout({ sold: 21.777778, bought: 18.712121, conversion: '-1.722' });
  // Representative old balance at the precision stored by the database.
  context.lastDebtData = { gold_debt_99: -4.788, money_debt: 15611157 };
  element('gold-price-99').value = '13180000';
  context.calcTotal();
  const { payload } = context.buildWholesalePayload();
  assert.equal(payload.gold_to_money_99, -1.722343);
  assert.equal(math.roundGold99(payload.gold_sold_99 - payload.gold_bought_99 - payload.gold_to_money_99 + payload.old_gold_debt_99), 0);
  assert.equal(math.isGoldConversionValid(payload.gold_sold_99, payload.gold_bought_99, payload.gold_to_money_99, payload.old_gold_debt_99), true);
  element('gold-to-money-99').value = '1.722';
  assert.equal(context.buildWholesalePayload(), null);
  element('gold-to-money-99').value = '-2';
  assert.equal(context.buildWholesalePayload(), null);
  context.convertAllGold();
  assert.equal(Number(element('gold-to-money-99').value), -1.722343);
});

test('old gold debt is converted once and zero or partial conversion keeps the balance', () => {
  for (const [sold, bought, old, conversion, valid] of [
    [3, 0, -5, -1, true], [3, 0, -5, 0, true], [3, 0, -5, 1, false],
    [3, 0, -3, 0, true], [3, 0, -3, 0.001, false],
    [0, 0, 2, 2, true], [0, 3, 5, 2, true], [0, 3, 5, -1, false],
  ]) assert.equal(math.isGoldConversionValid(sold, bought, conversion, old), valid);
});

test('editing a draft offers to collect only the remaining balance on top of recorded payments', () => {
  const { context, element } = checkout({ conversion: '0' });
  context.editOrderId = 'draft';
  context.editingPaidAmount = 200000;
  context.customItems[0].price = 1000000;
  context.calcTotal();
  assert.equal(Number(element('pay-amount').value), 800000);
  assert.equal(Number(element('debt-show').textContent), 0);
  element('pay-amount').value = '';
  context.payAmountDirty = true;
  context.calcTotal();
  assert.equal(Number(element('debt-show').textContent), 800000);
});

// Run the real draft handler with a database double; never touch customer data.
test('server draft checkout normalizes rounded signed gold and persists matching money/debt', async () => {
  const source = readFileSync(new URL('../functions/api/orders/[id].js', import.meta.url), 'utf8');
  for (const [old, entered, expected] of [[-4.788, -1.722, -1.722343], [0, 3.066, 3.065657], [-4.788, -1, -1]]) {
    let saved;
    const sql = async (parts, ...values) => {
      const query = parts.join('?');
      if (query.includes('SELECT * FROM orders')) return [{ is_quick: true, status: 'pending', customer_id: 'customer', old_gold_debt_99: old }];
      if (query.includes('SUM(amount)')) return [{ paid: 0 }];
      if (query.includes('UPDATE orders SET')) { saved = values; return [{ id: 'draft' }]; }
      return [];
    };
    sql.transaction = queries => Promise.all(queries);
    const ctx = vm.createContext({ ...math, getDb: () => sql, crypto: { randomUUID: () => 'item' },
      syncCustomerSupportContext: async () => {}, json: value => value, errorJson: (message, status) => ({ message, status }) });
    vm.runInContext(source.slice(source.indexOf('export async function editDraftOrder')).replace('export async', 'async'), ctx);
    const result = await ctx.editDraftOrder({ env: {} }, { tenantId: 'tenant' }, 'draft', {
      customer_id: 'customer', items: [{ item_name: 'Gold', unit_price: 6633000, quantity: 1 }],
      gold_sold_99: 21.777778, gold_bought_99: 18.712121, gold_price_99: 13180000,
      gold_to_money_99: entered, old_gold_debt_99: 999,
    });
    assert.equal(result.id, 'draft', JSON.stringify(result));
    assert.equal(saved[9], expected);
    assert.equal(saved[3], 6633000 + Math.round(expected * 13180000));
    assert.equal(saved[10], math.roundGold99(3.065657 - expected));
  }
});

test('server draft rejects wrong sign, excess and malformed gold before any write', async () => {
  const source = readFileSync(new URL('../functions/api/orders/[id].js', import.meta.url), 'utf8');
  for (const entered of [1.722, -1.723, 'invalid', Infinity]) {
    const sql = async (parts) => {
      assert.match(parts.join(''), /SELECT \* FROM orders/);
      return [{ is_quick: true, status: 'pending', customer_id: 'customer', old_gold_debt_99: -4.788 }];
    };
    const ctx = vm.createContext({ ...math, getDb: () => sql, errorJson: (message, status) => ({ message, status }) });
    vm.runInContext(source.slice(source.indexOf('export async function editDraftOrder')).replace('export async', 'async'), ctx);
    const result = await ctx.editDraftOrder({ env: {} }, { tenantId: 'tenant' }, 'draft', {
      customer_id: 'customer', items: [{ item_name: 'Gold' }], gold_sold_99: 21.777778,
      gold_bought_99: 18.712121, gold_to_money_99: entered, gold_price_99: 13180000,
    });
    assert.equal(result.status, 422);
  }
});

function runDraftEdit({ paidBefore = 0, body }) {
  const source = readFileSync(new URL('../functions/api/orders/[id].js', import.meta.url), 'utf8');
  const writes = { payments: [] };
  const sql = async (parts, ...values) => {
    const query = parts.join('?');
    if (query.includes('SELECT * FROM orders')) return [{ is_quick: true, status: 'pending', customer_id: 'customer', old_gold_debt_99: 0 }];
    if (query.includes('SUM(amount)')) return [{ paid: paidBefore }];
    if (query.includes('INSERT INTO payments')) writes.payments.push(values);
    if (query.includes('UPDATE orders SET')) return [{ id: 'draft', status: values.at(-4) }];
    return [];
  };
  sql.transaction = queries => Promise.all(queries);
  const ctx = vm.createContext({ ...math, getDb: () => sql, crypto: { randomUUID: () => 'id' },
    syncCustomerSupportContext: async () => {}, json: value => value, errorJson: (message, status) => ({ message, status }) });
  vm.runInContext(source.slice(source.indexOf('export async function editDraftOrder')).replace('export async', 'async'), ctx);
  return ctx.editDraftOrder({ env: {} }, { tenantId: 'tenant' }, 'draft', {
    customer_id: 'customer', items: [{ item_name: 'Ring', unit_price: 1000000, quantity: 1 }], ...body,
  }).then(result => ({ result, writes }));
}

test('updating a draft with full payment records it and completes the order', async () => {
  const { result, writes } = await runDraftEdit({ paidBefore: 200000, body: { additional_payment: { method: 'cash', amount: 800000 } } });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(writes.payments.length, 1);
  assert.ok(writes.payments[0].includes(800000));
});

test('updating a draft without enough payment keeps it pending', async () => {
  const { result, writes } = await runDraftEdit({ body: { additional_payment: { method: 'cash', amount: 500000 } } });
  assert.equal(result.status, 'pending');
  assert.equal(writes.payments.length, 1);
  const none = await runDraftEdit({ body: {} });
  assert.equal(none.result.status, 'pending');
  assert.equal(none.writes.payments.length, 0);
});

test('updating a draft rejects a payment in the wrong direction', async () => {
  const { result, writes } = await runDraftEdit({ body: { additional_payment: { method: 'cash', amount: -1000000 } } });
  assert.equal(result.status, 422);
  assert.equal(writes.payments.length, 0);
});

test('new invoice submits the chosen calendar date', () => {
  const { context, element } = checkout();
  element('inv-date').value = '2026-09-15';
  assert.equal(context.buildWholesalePayload().payload.invoice_date, '2026-09-15');
  element('inv-date').value = '';
  assert.equal(context.buildWholesalePayload(), null);
});
