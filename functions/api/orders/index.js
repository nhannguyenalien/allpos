import { isValidInvoiceDate } from "../../../public/js/invoice-date.js";
import { isGoldConversionValid, isOrderSettled, normalizeGoldConversion99, roundGold99 } from "../../../public/js/wholesale-math.js";
import { getDb, json, errorJson, handleOptions } from "../../_db.js";
import { requireAuth, requirePermission } from "../../_auth.js";
import {
  parseDateRange, parsePagination, pageMeta, validateDecimalString,
  validateInteger, validationError,
} from "../../_validation.js";
import { syncCustomerSupportContext } from "../../_support-chat.js";
import {
  findIdempotency,
  isIdempotencyUniqueViolation,
  parseIdempotency,
} from "../../_idempotency.js";

export { isOrderSettled };

export async function onRequest(context) {
  const preflight = handleOptions(context.request);
  if (preflight) return preflight;

  const auth = await requireAuth(context);
  if (auth instanceof Response) return auth;
  const allowed = await requirePermission(context, auth, context.request.method === "GET" ? "orders.read" : "orders.write");
  if (allowed instanceof Response) return allowed;

  if (context.request.method === "GET") return getOrders(context, auth);
  if (context.request.method === "POST") return createOrder(context, auth);
  return errorJson("Method not allowed", 405);
}

async function getOrders({ request, env }, { tenantId }) {
  const url = new URL(request.url);
  const status      = url.searchParams.get("status") || "";
  const date        = url.searchParams.get("date") || "";
  const orderType   = url.searchParams.get("order_type") || "";
  const search      = url.searchParams.get("search") || "";
  const from        = url.searchParams.get("from") || "";
  const to          = url.searchParams.get("to") || "";
  const includeQuick= url.searchParams.get("include_quick") === "1";
  const pagination = parsePagination(url);
  if (pagination.errors.length) return errorJson("Phân trang không hợp lệ", 422, "VALIDATION_ERROR", pagination.errors);
  const dateRange = parseDateRange(url);
  if (dateRange.errors.length) return errorJson("Khoảng ngày không hợp lệ", 422, "VALIDATION_ERROR", dateRange.errors);
  const { limit, offset } = pagination;
  const fromTs = from ? `${from}T00:00:00.000Z` : "";
  const toTs   = to   ? `${to}T23:59:59.999Z`   : "";
  const searchLike = search ? `%${search}%` : "";
  const sql = getDb(env);

  const countRows = await sql`
    SELECT COUNT(*) AS total FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
    WHERE o.tenant_id = ${tenantId}
      AND (${status} = '' OR o.status = ${status})
      AND (${orderType} = '' OR o.order_type = ${orderType})
      AND (${includeQuick} OR o.is_quick = false)
      AND (${date !== 'today'} OR DATE(o.created_at) = CURRENT_DATE)
      AND (${fromTs} = '' OR o.created_at >= ${fromTs})
      AND (${toTs} = '' OR o.created_at <= ${toTs})
      AND (${searchLike} = '' OR o.order_number ILIKE ${searchLike} OR c.name ILIKE ${searchLike} OR c.phone ILIKE ${searchLike})
  `;

  // Hoá đơn nháp (is_quick) mặc định KHÔNG hiện trong danh sách chính thức — chỉ
  // truy cập được qua ID trực tiếp (chi tiết/in lại), trừ khi chủ động bật include_quick.
  const rows = await sql`
    SELECT o.id, o.order_number, o.status, o.order_type, o.is_quick, o.subtotal, o.discount, o.total,
           o.gold_debt_99, o.old_money_debt, o.old_gold_debt_99, o.created_at,
           c.name AS customer_name, c.phone AS customer_phone,
           COALESCE(SUM(p.amount), 0) AS paid_amount
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN payments p ON p.order_id = o.id AND p.status = 'completed'
    WHERE o.tenant_id = ${tenantId}
      AND (${status} = '' OR o.status = ${status})
      AND (${orderType} = '' OR o.order_type = ${orderType})
      AND (${includeQuick} OR o.is_quick = false)
      AND (${date !== 'today'} OR DATE(o.created_at) = CURRENT_DATE)
      AND (${fromTs} = '' OR o.created_at >= ${fromTs})
      AND (${toTs} = '' OR o.created_at <= ${toTs})
      AND (${searchLike} = '' OR o.order_number ILIKE ${searchLike}
           OR c.name ILIKE ${searchLike} OR c.phone ILIKE ${searchLike})
    GROUP BY o.id, o.order_number, o.status, o.order_type, o.is_quick, o.subtotal, o.discount, o.total,
             o.gold_debt_99, o.old_money_debt, o.old_gold_debt_99, o.created_at, c.name, c.phone
    ORDER BY o.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return json({ orders: rows, pagination: pageMeta({ limit, offset, returned: rows.length, total: countRows[0].total }) });
}

async function createOrder({ request, env }, { tenantId, userId }) {
  let body;
  try { body = await request.json(); } catch { return errorJson("Body không hợp lệ", 400); }

  const {
    customer_id, channel_id, items = [], discount = 0, notes = null,
    order_type = "retail",
    // Hoá đơn nháp: ẩn khỏi danh sách chính thức (getOrders), thêm mặt hàng gõ tay
    // được (không cần có trong kho), KHÔNG trừ tồn kho — nhưng vẫn lưu công nợ khách
    // hàng bình thường qua total/payments như đơn thật.
    is_quick = false,
    trade_in_total = 0, trade_in_details = null,
    // Mô hình "quy về vàng 99" cho bán sỉ — mọi TL vàng bán ra/mua vào đều quy về
    // chỉ 99 trước, phần còn lại mới chọn quy ra tiền (có thể để một phần làm nợ vàng).
    gold_price_99 = 0, gold_sold_99 = 0, gold_bought_99 = 0,
    gold_to_money_99: requestedGoldConversion = 0, making_fee_total = 0,
    // Nợ cũ của khách TẠI THỜI ĐIỂM lập đơn (snapshot, lấy từ /api/customers/:id/debt lúc
    // chọn khách) — chỉ để hiển thị lại đúng lịch sử trên hoá đơn in, KHÔNG cộng vào
    // total/gold_debt_99 của đơn này để tránh tính trùng nợ (xem migrate_order_old_debt.sql).
    old_money_debt = 0, old_gold_debt_99 = 0,
    // Khoản thu/trả ngay lúc chốt toa. Ghi cùng transaction với order để không thể có
    // trạng thái "toa đã tạo nhưng payment bị lỗi" rồi vô tình biến thành công nợ.
    initial_payment = null,
    invoice_date,
  } = body;
  if (invoice_date !== undefined && !isValidInvoiceDate(invoice_date)) return errorJson("Ngày hóa đơn không hợp lệ", 422);

  let gold_to_money_99 = requestedGoldConversion;
  const validationErrors = [];
  if (!Array.isArray(items)) {
    validationErrors.push({ field: "items", rule: "array", message: "items phải là danh sách" });
  } else {
    items.forEach((item, index) => {
      const quantityError = validateInteger(item?.quantity, `items[${index}].quantity`, { min: 1 });
      const priceError = validateInteger(item?.unit_price, `items[${index}].unit_price`, { min: 0 });
      const itemDiscountError = validateInteger(item?.discount ?? 0, `items[${index}].discount`, { min: 0 });
      if (quantityError) validationErrors.push(quantityError);
      if (priceError) validationErrors.push(priceError);
      if (itemDiscountError) validationErrors.push(itemDiscountError);
    });
  }
  for (const [field, value, min] of [
    ["gold_price_99", gold_price_99, 0], ["gold_sold_99", gold_sold_99, 0],
    ["gold_bought_99", gold_bought_99, 0], ["gold_to_money_99", gold_to_money_99, null],
    ["old_gold_debt_99", old_gold_debt_99, null],
  ]) {
    const fieldError = validateDecimalString(value, field, { min, scale: 6 });
    if (fieldError) validationErrors.push(fieldError);
  }
  for (const [field, value, min] of [
    ["discount", discount, 0], ["trade_in_total", trade_in_total, 0],
    ["making_fee_total", making_fee_total, 0], ["old_money_debt", old_money_debt, undefined],
  ]) {
    const fieldError = validateInteger(value, field, min === undefined ? {} : { min });
    if (fieldError) validationErrors.push(fieldError);
  }
  if (validationErrors.length) return validationError(validationErrors);
  // Toa chỉ có hàng cũ khách trả (mua vào), không bán gì mới — vẫn là 1 giao dịch hợp lệ
  // (mua vàng cũ của khách), nên chỉ chặn khi CẢ items lẫn trade_in_details đều trống.
  if (!items.length && !(trade_in_details && trade_in_details.length)) {
    return errorJson("Đơn hàng phải có ít nhất 1 sản phẩm hoặc 1 hàng cũ khách trả", 422);
  }
  if (is_quick && !customer_id) return errorJson("Hoá đơn nháp cần chọn khách hàng để lưu công nợ", 422);

  const idempotency = await parseIdempotency(request, "orders.create", body);
  if (idempotency.response) return idempotency.response;

  const sql = getDb(env);
  const replay = await findIdempotency(sql, tenantId, "orders.create", idempotency.key, idempotency.hash);
  if (replay) return replay;

  if (is_quick) {
    for (const item of items) {
      if (!item.product_variant_id && !item.item_name) {
        return errorJson("Mỗi mặt hàng trong hoá đơn nháp cần có tên hoặc chọn từ kho", 422);
      }
    }
  } else {
    // Kiểm tra tồn kho tất cả items trước khi tạo đơn
    for (const item of items) {
      const stock = await sql`
        SELECT COALESCE(ss.qty, 0) AS qty
        FROM product_variants pv
        LEFT JOIN stock_snapshots ss ON ss.product_variant_id = pv.id
        WHERE pv.id = ${item.product_variant_id} AND pv.tenant_id = ${tenantId}
        LIMIT 1
      `;
      if (!stock.length) return errorJson(`Không tìm thấy sản phẩm: ${item.product_variant_id}`, 404);
      if (parseInt(stock[0].qty) < item.quantity) {
        return errorJson(
          `Không đủ tồn kho. Variant ${item.product_variant_id} chỉ còn ${stock[0].qty}`,
          409,
          "INSUFFICIENT_STOCK",
        );
      }
    }
  }

  const subtotal = items.reduce((sum, i) => sum + i.unit_price * i.quantity - (i.discount || 0), 0);

  // Bán sỉ vàng dùng mô hình "quy về vàng 99": mọi TL bán ra/mua vào được quy đổi
  // theo tuổi về chỉ-99 rồi mới trừ ròng cho nhau; phần chỉ-99 còn lại mới chọn quy
  // ra tiền (gold_to_money_99), phần không quy thì để lại thành nợ vàng (gold_debt_99).
  // Khi đó unit_price của mỗi item vàng trong `items` chỉ còn là tiền công (không gồm
  // giá vàng), nên `subtotal` ở trên không bị trùng với tiền vàng cộng thêm dưới đây.
  // Đơn không phải bán sỉ vàng (không có hoạt động vàng nào) giữ nguyên công thức cũ.
  // Lưu ý: dùng gold_sold_99/gold_bought_99 để nhận diện toa vàng — KHÔNG dùng
  // gold_price_99>0, vì giá vàng có thể để trống nếu nhân viên để nguyên hết thành nợ
  // vàng (không quy đồng nào ra tiền) — nếu không, nợ vàng sẽ bị bỏ sót hoàn toàn.
  let total, goldDebt99 = 0, goldMoneyValue = 0;
  const goldEpsilon = 0.000001;
  if (gold_sold_99 > 0 || gold_bought_99 > 0 || Number(gold_to_money_99) !== 0) {
    const goldRemaining99 = gold_sold_99 - gold_bought_99;
    gold_to_money_99 = [gold_sold_99, gold_bought_99, gold_to_money_99, old_gold_debt_99].every(v => Number.isFinite(Number(v)))
      ? normalizeGoldConversion99(gold_sold_99, gold_bought_99, gold_to_money_99, old_gold_debt_99) : NaN;
    const goldConversion = Number(gold_to_money_99);
    if (!isGoldConversionValid(gold_sold_99, gold_bought_99, goldConversion, old_gold_debt_99)) {
      return errorJson("Số vàng quy ra tiền phải cùng chiều và không vượt phần vàng còn lại sau khi bù nợ cũ", 422, "INVALID_GOLD_CONVERSION");
    }
    if (goldConversion !== 0 && Number(gold_price_99) <= 0) {
      return errorJson("Cần nhập giá vàng 99/chỉ để quy ra tiền", 422, "INVALID_GOLD_PRICE");
    }
    goldDebt99 = roundGold99(goldRemaining99 - goldConversion);
    goldMoneyValue = Math.round(gold_to_money_99 * gold_price_99);
    total = subtotal + goldMoneyValue - discount;
  } else {
    total = subtotal - discount - trade_in_total;
  }
  if (![subtotal, goldMoneyValue, total].every(Number.isSafeInteger)) {
    return errorJson("Giá trị tiền của toa vượt giới hạn an toàn", 422, "UNSAFE_ORDER_TOTAL");
  }

  let initialPaymentAmount = 0;
  let initialPaymentMethod = null;
  let initialPaymentReference = null;
  if (initial_payment !== null && initial_payment !== undefined) {
    initialPaymentAmount = initial_payment?.amount;
    initialPaymentMethod = initial_payment?.method;
    initialPaymentReference = initial_payment?.reference_no || null;
    if (!Number.isSafeInteger(initialPaymentAmount) || initialPaymentAmount === 0) {
      return errorJson("Số tiền thanh toán ban đầu phải là số nguyên VND khác 0", 422, "INVALID_PAYMENT_AMOUNT");
    }
    if (typeof initialPaymentMethod !== "string" || !initialPaymentMethod.trim()) {
      return errorJson("Phương thức thanh toán ban đầu là bắt buộc", 422, "INVALID_PAYMENT_METHOD");
    }
    if ((total >= 0 && initialPaymentAmount < 0) || (total < 0 && initialPaymentAmount > 0)) {
      return errorJson("Chiều thu/trả tiền không khớp với tổng toa", 422, "INVALID_PAYMENT_DIRECTION");
    }
  }

  // Toa 0đ và không còn nợ vàng là đã tất toán dù không cần tạo payment 0đ.
  // Ngược lại, còn nợ vàng thì vẫn phải để pending dù tiền đã thu đủ.
  const isPaid = isOrderSettled(total, initialPaymentAmount, goldDebt99, goldEpsilon);

  const orderId = crypto.randomUUID();
  const now = new Date().toISOString();
  // Existing lists, reports and invoice prints use created_at as the invoice date.
  const invoiceCreatedAt = invoice_date ? `${invoice_date}T12:00:00.000Z` : now;
  const orderNumber = "DH" + Date.now().toString(36).toUpperCase() + orderId.slice(0, 8).toUpperCase();
  const responseBody = {
    order_id: orderId, order_number: orderNumber, total, gold_debt_99: goldDebt99,
    paid_total: initialPaymentAmount, remaining: total - initialPaymentAmount,
    status: isPaid ? "completed" : "pending",
  };
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const queries = [
    sql`
      INSERT INTO api_idempotency_keys
        (id, tenant_id, operation, idempotency_key, request_hash, created_at, expires_at)
      VALUES
        (${crypto.randomUUID()}, ${tenantId}, 'orders.create', ${idempotency.key},
         ${idempotency.hash}, ${now}, ${expiresAt})
    `,
    sql`
      INSERT INTO orders (id, tenant_id, customer_id, channel_id, order_number, status, order_type, is_quick,
                          subtotal, discount, total, trade_in_total, trade_in_details,
                          gold_price_99, gold_sold_99, gold_bought_99, gold_to_money_99,
                          gold_debt_99, making_fee_total, notes, old_money_debt, old_gold_debt_99,
                          created_by, created_at, updated_at)
      VALUES (${orderId}, ${tenantId}, ${customer_id || null}, ${channel_id || null},
              ${orderNumber}, ${isPaid ? "completed" : "pending"}, ${order_type}, ${is_quick}, ${subtotal}, ${discount}, ${total},
              ${trade_in_total}, ${trade_in_details ? JSON.stringify(trade_in_details) : null},
              ${gold_price_99}, ${gold_sold_99}, ${gold_bought_99}, ${gold_to_money_99},
              ${goldDebt99}, ${making_fee_total}, ${notes || null}, ${old_money_debt}, ${old_gold_debt_99},
              ${userId}, ${invoiceCreatedAt}, ${now})
    `,
  ];

  for (const item of items) {
    const itemId = crypto.randomUUID();
    const itemTotal = item.unit_price * item.quantity - (item.discount || 0);
    if (!is_quick) {
      queries.push(sql`SELECT decrement_stock_or_fail(${item.product_variant_id}, ${tenantId}, ${item.quantity}, ${now})`);
    }
    queries.push(sql`
      INSERT INTO order_items (id, order_id, product_variant_id, item_name, quantity, unit_price, discount, total, metal_details, created_at)
      VALUES (${itemId}, ${orderId}, ${item.product_variant_id || null}, ${item.item_name || null},
              ${item.quantity}, ${item.unit_price}, ${item.discount || 0}, ${itemTotal},
              ${item.metal_details ? JSON.stringify(item.metal_details) : null}, ${now})
    `);
    if (!is_quick) {
      queries.push(sql`
        INSERT INTO inventory_transactions
          (id, tenant_id, product_variant_id, type, quantity, reference_type, reference_id, created_by, created_at)
        VALUES (${crypto.randomUUID()}, ${tenantId}, ${item.product_variant_id}, 'OUT', ${item.quantity},
                'order', ${orderId}, ${userId}, ${now})
      `);
    }
  }
  if (initialPaymentAmount !== 0) {
    queries.push(sql`
      INSERT INTO payments
        (id, tenant_id, order_id, method, amount, status, payment_date, reference_no, created_at)
      VALUES
        (${crypto.randomUUID()}, ${tenantId}, ${orderId}, ${initialPaymentMethod.trim()},
         ${initialPaymentAmount}, 'completed', ${now}, ${initialPaymentReference}, ${now})
    `);
  }
  queries.push(sql`
    UPDATE api_idempotency_keys
    SET response_status = 201, response_body = ${JSON.stringify(responseBody)}::jsonb
    WHERE tenant_id = ${tenantId} AND operation = 'orders.create' AND idempotency_key = ${idempotency.key}
  `);

  try {
    await sql.transaction(queries, { isolationLevel: "ReadCommitted" });
  } catch (err) {
    if (isIdempotencyUniqueViolation(err)) {
      return await findIdempotency(sql, tenantId, "orders.create", idempotency.key, idempotency.hash);
    }
    if (err?.message?.includes("INSUFFICIENT_STOCK")) {
      return errorJson("Tồn kho vừa thay đổi hoặc không còn đủ. Vui lòng thử lại.", 409, "INSUFFICIENT_STOCK");
    }
    console.error("Không thể tạo order transaction:", err);
    return errorJson("Không thể tạo đơn hàng, vui lòng thử lại", 500, "ORDER_CREATE_FAILED");
  }

  if (customer_id) {
    try { await syncCustomerSupportContext(sql, env, tenantId, customer_id); }
    catch (err) { console.error("Không đồng bộ được dữ liệu khách sau khi tạo đơn:", err.message); }
  }
  return json(responseBody, 201, { "Idempotency-Key": idempotency.key });
}
