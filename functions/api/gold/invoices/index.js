import { isValidInvoiceDate } from "../../../../public/js/invoice-date.js";
// GET  /api/gold/invoices  — danh sách hoá đơn
// POST /api/gold/invoices  — tạo hoá đơn mới
import { getDb, json, errorJson, handleOptions } from "../../../_db.js";
import { requireAuth } from "../../../_auth.js";

export async function onRequest(context) {
  const preflight = handleOptions(context.request);
  if (preflight) return preflight;
  const auth = await requireAuth(context);
  if (auth instanceof Response) return auth;

  if (context.request.method === "GET")  return listInvoices(context, auth);
  if (context.request.method === "POST") return createInvoice(context, auth);
  return errorJson("Method not allowed", 405);
}

async function listInvoices({ request, env }, { tenantId }) {
  const url    = new URL(request.url);
  const search = url.searchParams.get("search") || "";
  const status = url.searchParams.get("status") || "";
  const from   = url.searchParams.get("from")   || "";
  const to     = url.searchParams.get("to")     || "";
  const sql    = getDb(env);

  const rows = await sql`
    SELECT gi.id, gi.invoice_number, gi.invoice_date, gi.status,
           gi.customer_name, gi.customer_phone,
           gi.gold_delivered, gi.gold_customer_debt,
           gi.total_money, gi.customer_money_debt,
           gi.gold_price_per_chi
    FROM gold_invoices gi
    WHERE gi.tenant_id = ${tenantId}
      AND (${status} = '' OR gi.status = ${status})
      AND (${from}   = '' OR gi.invoice_date >= ${from})
      AND (${to}     = '' OR gi.invoice_date <= ${to})
      AND (${search} = ''
           OR gi.invoice_number ILIKE ${'%' + search + '%'}
           OR gi.customer_name  ILIKE ${'%' + search + '%'}
           OR gi.customer_phone LIKE  ${'%' + search + '%'})
    ORDER BY gi.invoice_date DESC, gi.created_at DESC
    LIMIT 100
  `;
  return json({ invoices: rows });
}

async function createInvoice({ request, env }, { tenantId, userId }) {
  let body;
  try { body = await request.json(); } catch { return errorJson("Body không hợp lệ", 400); }

  const {
    customer_id, customer_name, customer_phone, customer_address,
    customer_tax_code, customer_company,
    // Thông tin người bán (cá nhân) — dùng cho chứng từ mua vào, đều tuỳ chọn
    customer_id_card, customer_dob, customer_id_issue_date,
    customer_bank_name, customer_bank_account,
    receive_transfer_amount = 0, receive_cash_amount = 0,
    invoice_date, gold_price_per_chi,
    items = [],      // hàng bán ra
    returns = [],    // dê khách trả
    // Thống kê vàng
    gold_prev_debt = 0, gold_transferred = 0,
    gold_customer_paid = 0,
    // Thống kê tiền
    discount_percent = 0, money_prev_debt = 0,
    making_fee_paid_back = 0, invoice_discount = 0,
    customer_paid_money = 0,
    notes,
  } = body;

  if (invoice_date !== undefined && !isValidInvoiceDate(invoice_date)) return errorJson("Ngày hóa đơn không hợp lệ", 422);

  if (!gold_price_per_chi) return errorJson("Cần nhập giá vàng 99/chỉ", 422);
  if (!items.length && !returns.length) return errorJson("Cần ít nhất 1 hàng bán ra hoặc 1 hàng dê thu mua", 422);

  // ── Tính toán thống kê vàng ──────────────────────────
  let gold_delivered = 0, total_making_fee = 0;
  const processedItems = items.map((item, i) => {
    const qty         = item.quantity || 1;
    const unit_gross  = item.unit_gross_weight || 0;
    const unit_stone  = item.unit_stone_weight || 0;
    const purity      = item.gold_purity || 99;
    const unit_fee    = item.unit_making_fee || 0;

    const unit_net      = Math.max(0, unit_gross - unit_stone);
    const unit_conv     = unit_net * (purity / 99);

    const total_gross   = unit_gross * qty;
    const total_stone   = unit_stone * qty;
    const total_net     = unit_net   * qty;
    const total_conv    = unit_conv  * qty;
    const total_fee     = unit_fee   * qty; // giá cố định/món × SL (theo loại món, không theo chỉ)

    gold_delivered  += total_conv;
    total_making_fee += total_fee;

    return {
      id: crypto.randomUUID(),
      sort_order: i,
      product_name:      item.product_name || "Sản phẩm",
      quantity:          qty,
      unit_gross_weight: unit_gross,
      unit_stone_weight: unit_stone,
      unit_net_weight:   unit_net,
      unit_converted:    unit_conv,
      unit_making_fee:   unit_fee,
      gold_purity:       purity,
      total_gross, total_stone, total_net,
      total_converted: total_conv,
      total_making_fee: total_fee,
    };
  });

  // ── Tính toán dê khách trả ──────────────────────────
  let gold_returned = 0;
  const processedReturns = returns.map((r, i) => {
    const gross = r.gross_weight || 0;
    const stone = r.stone_weight || 0;
    const net   = Math.max(0, gross - stone);
    const conv_text = r.conversion_text || "99/99";
    let ratio = 1;
    if (conv_text.includes("/")) {
      const [tu, mau] = conv_text.split("/").map(Number);
      if (mau > 0) ratio = tu / mau;
    } else {
      ratio = (parseFloat(conv_text) || 99) / 99;
    }
    const converted = net * ratio;
    gold_returned += converted;
    const unit_price = r.unit_price || 0;
    return {
      id: crypto.randomUUID(),
      sort_order: i,
      gold_type_name:   r.gold_type_name || "Vàng cũ",
      gross_weight:     gross,
      stone_weight:     stone,
      net_weight:       net,
      conversion_text:  conv_text,
      converted_weight: converted,
      unit_price,
      line_total: Math.round(net * unit_price), // thành tiền mua vào của dòng (TL vàng thực tế × đơn giá)
    };
  });

  // ── Thống kê vàng ──────────────────────────────────
  // TL quy tiền của hoá đơn này = vàng giao mới - dê khách trả (tự động, server tự tính lại)
  const gold_to_money      = gold_delivered - gold_returned;
  const gold_remaining     = (gold_delivered + gold_prev_debt) - (gold_returned + gold_transferred);
  const gold_customer_debt = gold_remaining - gold_customer_paid - gold_to_money;

  // ── Thống kê tiền ──────────────────────────────────
  const tien_cong_ck    = total_making_fee * (1 - discount_percent / 100);
  const gold_money_value = gold_to_money * gold_price_per_chi;
  const total_money      = tien_cong_ck + money_prev_debt + gold_money_value - making_fee_paid_back - invoice_discount;
  const customer_money_debt = total_money - customer_paid_money;

  const sql    = getDb(env);
  const id     = crypto.randomUUID();
  const now    = new Date().toISOString();
  const date   = invoice_date || now.slice(0, 10);

  // Sinh số hoá đơn: HV + ngày + sequence
  const countRow = await sql`
    SELECT COUNT(*)+1 AS seq FROM gold_invoices WHERE tenant_id = ${tenantId}
  `;
  const seq           = String(countRow[0].seq).padStart(4, "0");
  const invoice_number = `HV${date.replace(/-/g, "")}${seq}`;

  // Insert header
  await sql`
    INSERT INTO gold_invoices (
      id, tenant_id, invoice_number, customer_id, customer_name,
      customer_phone, customer_address, customer_tax_code, customer_company,
      customer_id_card, customer_dob, customer_id_issue_date,
      customer_bank_name, customer_bank_account,
      receive_transfer_amount, receive_cash_amount,
      invoice_date, gold_price_per_chi,
      gold_delivered, gold_prev_debt, gold_transferred, gold_returned,
      gold_to_money, gold_remaining, gold_customer_paid, gold_customer_debt,
      total_making_fee, discount_percent, money_prev_debt, making_fee_paid_back,
      gold_money_value, invoice_discount, total_money,
      customer_paid_money, customer_money_debt,
      status, notes, created_by, created_at, updated_at
    ) VALUES (
      ${id}, ${tenantId}, ${invoice_number},
      ${customer_id || null}, ${customer_name || null},
      ${customer_phone || null}, ${customer_address || null},
      ${customer_tax_code || null}, ${customer_company || null},
      ${customer_id_card || null}, ${customer_dob || null}, ${customer_id_issue_date || null},
      ${customer_bank_name || null}, ${customer_bank_account || null},
      ${receive_transfer_amount || 0}, ${receive_cash_amount || 0},
      ${date}, ${gold_price_per_chi},
      ${gold_delivered}, ${gold_prev_debt}, ${gold_transferred}, ${gold_returned},
      ${gold_to_money}, ${gold_remaining}, ${gold_customer_paid}, ${gold_customer_debt},
      ${total_making_fee}, ${discount_percent}, ${money_prev_debt}, ${making_fee_paid_back},
      ${gold_money_value}, ${invoice_discount}, ${total_money},
      ${customer_paid_money}, ${customer_money_debt},
      'completed', ${notes || null}, ${userId}, ${now}, ${now}
    )
  `;

  // Insert items
  for (const item of processedItems) {
    await sql`
      INSERT INTO gold_invoice_items (
        id, invoice_id, sort_order, product_name, quantity,
        unit_gross_weight, unit_stone_weight, unit_net_weight, unit_converted, unit_making_fee,
        gold_purity, total_gross, total_stone, total_net, total_converted, total_making_fee,
        created_at
      ) VALUES (
        ${item.id}, ${id}, ${item.sort_order}, ${item.product_name}, ${item.quantity},
        ${item.unit_gross_weight}, ${item.unit_stone_weight}, ${item.unit_net_weight},
        ${item.unit_converted}, ${item.unit_making_fee},
        ${item.gold_purity}, ${item.total_gross}, ${item.total_stone},
        ${item.total_net}, ${item.total_converted}, ${item.total_making_fee},
        ${now}
      )
    `;
  }

  // Insert returns
  for (const ret of processedReturns) {
    await sql`
      INSERT INTO gold_invoice_returns (
        id, invoice_id, sort_order, gold_type_name,
        gross_weight, stone_weight, net_weight, conversion_text, converted_weight,
        unit_price, line_total,
        created_at
      ) VALUES (
        ${ret.id}, ${id}, ${ret.sort_order}, ${ret.gold_type_name},
        ${ret.gross_weight}, ${ret.stone_weight}, ${ret.net_weight},
        ${ret.conversion_text}, ${ret.converted_weight},
        ${ret.unit_price}, ${ret.line_total},
        ${now}
      )
    `;
  }

  return json({ invoice_id: id, invoice_number }, 201);
}
