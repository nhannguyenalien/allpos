import { isGoldConversionValid, isOrderSettled, normalizeGoldConversion99, roundGold99 } from "../../../public/js/wholesale-math.js";
import { getDb, json, errorJson, handleOptions } from "../../_db.js";
import { requireAuth, requirePermission } from "../../_auth.js";
import { ensureCustomerSupportLink, syncCustomerSupportContext } from "../../_support-chat.js";

export async function onRequest(context) {
  const preflight = handleOptions(context.request);
  if (preflight) return preflight;

  const auth = await requireAuth(context);
  if (auth instanceof Response) return auth;

  const permission = context.request.method === "GET"
    ? "orders.read"
    : context.request.method === "DELETE" ? "orders.status" : "orders.write";
  const allowed = await requirePermission(context, auth, permission);
  if (allowed instanceof Response) return allowed;

  const { id } = context.params;
  if (context.request.method === "GET") return getOrder(context, auth, id);
  if (context.request.method === "PUT") return updateOrder(context, auth, id);
  // Không xóa vật lý chứng từ kế toán. DELETE là thao tác hủy có hoàn kho, đồng bộ
  // công nợ và vẫn giữ nguyên audit trail để bot/operator có thể tra soát.
  if (context.request.method === "DELETE") return changeOrderStatus(context, auth, id, { status: "cancelled" });
  return errorJson("Method not allowed", 405);
}

async function getOrder({ env }, { tenantId }, id) {
  const sql = getDb(env);

  const orders = await sql`
    SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
           c.address AS customer_address, c.id_card AS customer_id_card,
           c.dob AS customer_dob, c.id_issue_date AS customer_id_issue_date,
           c.bank_name AS customer_bank_name, c.bank_account AS customer_bank_account,
           c.support_chat_url, c.support_chat_session
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE o.id = ${id} AND o.tenant_id = ${tenantId}
    LIMIT 1
  `;
  if (!orders.length) return errorJson("Không tìm thấy đơn hàng", 404);

  if (orders[0].customer_id && !orders[0].support_chat_url) {
    try {
      orders[0] = await ensureCustomerSupportLink(sql, env, tenantId, {
        ...orders[0], id: orders[0].customer_id, name: orders[0].customer_name,
      });
    } catch (err) {
      console.error("Không tạo được link hỗ trợ khi mở đơn:", err.message);
    }
  }
  // LEFT JOIN (không INNER) vì hoá đơn nháp cho phép mặt hàng gõ tay không gắn với
  // product_variant nào — product_name/sku khi đó rơi về item_name / rỗng.
  const items = await sql`
    SELECT oi.*, pv.sku, COALESCE(p.name, oi.item_name, 'Hàng tuỳ ý') AS product_name
    FROM order_items oi
    LEFT JOIN product_variants pv ON pv.id = oi.product_variant_id
    LEFT JOIN products p ON p.id = pv.product_id
    WHERE oi.order_id = ${id}
  `;

  const payments = await sql`
    SELECT * FROM payments WHERE order_id = ${id} ORDER BY created_at ASC
  `;

  const paidAmount = payments.reduce((s, p) => s + parseInt(p.amount), 0);

  return json({
    order: orders[0],
    items,
    payments,
    paid_amount: paidAmount,
    remaining: parseInt(orders[0].total) - paidAmount,
  });
}

async function updateOrder(context, auth, id) {
  let body;
  try { body = await context.request.json(); } catch { return errorJson("Body không hợp lệ", 400); }

  // 2 kiểu PUT khác nhau trên cùng route: đổi trạng thái (status) hoặc sửa toàn bộ nội
  // dung hoá đơn nháp (items) — tách nhánh theo shape của body.
  if (body.items) return editDraftOrder(context, auth, id, body);
  return changeOrderStatus(context, auth, id, body);
}

export async function changeOrderStatus({ env }, { tenantId }, id, body) {
  const { status } = body;
  if (!["completed", "cancelled", "refunded"].includes(status)) {
    return errorJson("Status không hợp lệ", 422);
  }

  const sql = getDb(env);
  const now = new Date().toISOString();

  const orders = await sql`
    SELECT * FROM orders WHERE id = ${id} AND tenant_id = ${tenantId} LIMIT 1
  `;
  if (!orders.length) return errorJson("Không tìm thấy đơn hàng", 404);

  // Hoàn kho khi đơn chuyển sang cancelled/refunded — hàng đã bị trừ kho ngay lúc
  // tạo đơn (dù đang pending hay đã completed) nên bất kỳ đơn nào chưa từng được
  // hoàn kho trước đó đều cần cộng trả lại, không chỉ riêng trường hợp pending→cancelled.
  // Hoá đơn nháp (is_quick) chưa bao giờ đụng tới kho lúc tạo nên bỏ qua bước này —
  // hoàn kho ở đây sẽ tạo tồn kho ảo không có thật.
  const alreadyReturned = ["cancelled", "refunded"].includes(orders[0].status);
  if (!orders[0].is_quick && ["cancelled", "refunded"].includes(status) && !alreadyReturned) {
    const items = await sql`SELECT * FROM order_items WHERE order_id = ${id}`;
    const refType = status === "refunded" ? "order_refund" : "order_cancel";

    for (const item of items) {
      const txId = crypto.randomUUID();
      await sql`
        INSERT INTO inventory_transactions
          (id, tenant_id, product_variant_id, type, quantity, reference_type, reference_id, created_at)
        VALUES
          (${txId}, ${tenantId}, ${item.product_variant_id}, 'IN', ${item.quantity},
           ${refType}, ${id}, ${now})
      `;
      await sql`
        INSERT INTO stock_snapshots (product_variant_id, tenant_id, qty, updated_at)
        VALUES (${item.product_variant_id}, ${tenantId}, ${item.quantity}, ${now})
        ON CONFLICT (product_variant_id)
        DO UPDATE SET qty = stock_snapshots.qty + ${item.quantity}, updated_at = ${now}
      `;
    }
  }

  const rows = await sql`
    UPDATE orders SET status = ${status}, updated_at = ${now}
    WHERE id = ${id} AND tenant_id = ${tenantId}
    RETURNING id, order_number, status, total
  `;

  if (orders[0].customer_id) {
    try { await syncCustomerSupportContext(sql, env, tenantId, orders[0].customer_id); }
    catch (err) { console.error("Không đồng bộ được dữ liệu khách sau khi đổi trạng thái:", err.message); }
  }

  return json(rows[0]);
}

// Sửa toàn bộ nội dung 1 hoá đơn NHÁP đang pending: thay hết order_items, tính lại
// subtotal/total/gold_debt_99 y hệt công thức createOrder. Chỉ cho phép với hoá đơn
// nháp (is_quick) còn pending — hoá đơn nháp chưa bao giờ đụng tới kho lúc tạo nên
// sửa lại không làm lệch tồn kho; đơn thật/đã đóng thì KHÔNG cho sửa để không phá vỡ
// lịch sử giao dịch đã chốt (payments đã ghi nhận dựa trên total cũ).
export async function editDraftOrder({ env }, { tenantId }, id, body) {
  const sql = getDb(env);

  const existingRows = await sql`SELECT * FROM orders WHERE id = ${id} AND tenant_id = ${tenantId} LIMIT 1`;
  if (!existingRows.length) return errorJson("Không tìm thấy đơn hàng", 404);
  const existing = existingRows[0];
  if (!existing.is_quick) return errorJson("Chỉ có thể sửa hoá đơn nháp", 403);
  if (existing.status !== "pending") return errorJson("Hoá đơn đã đóng, không thể sửa", 403);

  const {
    customer_id, items = [], discount = 0, notes = null,
    trade_in_total = 0, trade_in_details = null,
    gold_price_99 = 0, gold_sold_99 = 0, gold_bought_99 = 0,
    gold_to_money_99: requestedGoldConversion = 0, making_fee_total = 0,
    // Khoản thu/hoàn thêm lúc bấm "Cập nhật" để hoàn tất toa nháp — ghi cùng transaction
    // với nội dung toa, giống initial_payment của createOrder.
    additional_payment = null,
  } = body;
  let gold_to_money_99 = requestedGoldConversion;
  let { old_money_debt = 0, old_gold_debt_99 = 0 } = body;
  // Hoá đơn nháp LUÔN cần khách hàng để lưu công nợ (giống điều kiện lúc tạo mới) — thiếu
  // check này thì 1 request thiếu customer_id sẽ âm thầm gỡ đơn ra khỏi công nợ của khách.
  if (!customer_id) return errorJson("Hoá đơn nháp cần chọn khách hàng để lưu công nợ", 422);
  // Toa chỉ có hàng cũ khách trả (mua vào), không bán gì mới, vẫn hợp lệ — chỉ chặn khi
  // CẢ items lẫn trade_in_details đều trống.
  if (!items.length && !(trade_in_details && trade_in_details.length)) {
    return errorJson("Đơn hàng phải có ít nhất 1 sản phẩm hoặc 1 hàng cũ khách trả", 422);
  }
  for (const item of items) {
    if (!item.product_variant_id && !item.item_name) {
      return errorJson("Mỗi mặt hàng trong hoá đơn nháp cần có tên hoặc chọn từ kho", 422);
    }
  }

  // Nếu đổi khách, không tin snapshot client vì có thể chưa tải xong hoặc đã cũ. Chốt lại
  // công nợ HIỆN TẠI của khách mới ngay tại backend. Toa đang sửa vẫn thuộc khách cũ ở
  // thời điểm query nên không bị cộng chính nó vào snapshot của khách mới.
  if (customer_id !== existing.customer_id) {
    const debtRows = await sql`
      WITH payment_totals AS (
        SELECT order_id, SUM(amount) AS paid
        FROM payments
        WHERE tenant_id = ${tenantId} AND status = 'completed'
        GROUP BY order_id
      ), order_debt AS (
        SELECT COALESCE(SUM(o.total - COALESCE(p.paid, 0)), 0) AS money_debt,
               COALESCE(SUM(o.gold_debt_99), 0) AS gold_debt_99
        FROM orders o
        LEFT JOIN payment_totals p ON p.order_id = o.id
        WHERE o.tenant_id = ${tenantId} AND o.customer_id = ${customer_id}
          AND o.status NOT IN ('cancelled', 'refunded')
      ), adjustment_debt AS (
        SELECT COALESCE(SUM(money_amount), 0) AS money_debt,
               COALESCE(SUM(gold_amount_99), 0) AS gold_debt_99
        FROM customer_debt_adjustments
        WHERE tenant_id = ${tenantId} AND customer_id = ${customer_id}
      )
      SELECT o.money_debt + a.money_debt AS money_debt,
             o.gold_debt_99 + a.gold_debt_99 AS gold_debt_99
      FROM order_debt o CROSS JOIN adjustment_debt a
    `;
    old_money_debt = parseInt(debtRows[0]?.money_debt) || 0;
    old_gold_debt_99 = debtRows[0]?.gold_debt_99 || 0;
  }

  // Khi giữ nguyên khách, dùng snapshot đã lưu, không để request sửa nợ cũ.
  if (customer_id === existing.customer_id) old_gold_debt_99 = existing.old_gold_debt_99 || 0;
  gold_to_money_99 = [gold_sold_99, gold_bought_99, gold_to_money_99, old_gold_debt_99].every(v => Number.isFinite(Number(v)))
      ? normalizeGoldConversion99(gold_sold_99, gold_bought_99, gold_to_money_99, old_gold_debt_99) : NaN;
  if (!isGoldConversionValid(gold_sold_99, gold_bought_99, gold_to_money_99, old_gold_debt_99)) {
    return errorJson("Số vàng quy ra tiền phải cùng chiều và không vượt phần vàng còn lại sau khi bù nợ cũ", 422, "INVALID_GOLD_CONVERSION");
  }
  if (Number(gold_to_money_99) !== 0 && !(Number(gold_price_99) > 0)) {
    return errorJson("Cần nhập giá vàng 99/chỉ để quy ra tiền", 422, "INVALID_GOLD_PRICE");
  }

  const subtotal = items.reduce((sum, i) => sum + i.unit_price * i.quantity - (i.discount || 0), 0);

  // Nhận diện toa vàng qua gold_sold_99/gold_bought_99, KHÔNG dùng gold_price_99>0 —
  // giá vàng có thể để trống nếu để nguyên hết thành nợ vàng (xem createOrder cùng lý do).
  let total, goldDebt99 = 0;
  if (gold_sold_99 > 0 || gold_bought_99 > 0 || Number(gold_to_money_99) !== 0) {
    const goldRemaining99 = gold_sold_99 - gold_bought_99;
    goldDebt99 = roundGold99(goldRemaining99 - gold_to_money_99);
    const goldMoneyValue = Math.round(gold_to_money_99 * gold_price_99);
    total = subtotal + goldMoneyValue - discount;
  } else {
    total = subtotal - discount - trade_in_total;
  }

  // Chặn sửa nếu đơn đã có tiền thu/hoàn (payments) mà tổng mới sẽ khiến số đã thu/hoàn
  // đó "vượt quá" tổng mới — nếu cho qua, công thức nợ (max(0, total-paid), sign-aware)
  // sẽ âm thầm kẹp về 0 và MẤT DẤU phần chênh lệch thực (khách trả dư/tiệm hoàn dư mà
  // không ai biết) — đúng lỗi đã rà soát trước khi bật tính năng sửa hoá đơn nháp.
  const paidRows = await sql`
    SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE order_id = ${id} AND status = 'completed'
  `;
  const paid = parseInt(paidRows[0].paid) || 0;
  const rawRemaining = total >= 0 ? (total - paid) : (paid - total);
  if (paid !== 0 && rawRemaining < 0) {
    return errorJson(
      `Đơn này đã ${total >= 0 ? "thu" : "hoàn"} ${Math.abs(paid).toLocaleString("vi-VN")}đ — không thể sửa để tổng đơn giảm xuống dưới số đó (sẽ làm mất dấu phần chênh lệch). Hãy điều chỉnh khoản đã thu/hoàn trước.`,
      409
    );
  }

  let paymentAmount = 0;
  let paymentMethod = null;
  if (additional_payment !== null && additional_payment !== undefined) {
    paymentAmount = additional_payment?.amount;
    paymentMethod = additional_payment?.method;
    if (!Number.isSafeInteger(paymentAmount) || paymentAmount === 0) {
      return errorJson("Số tiền thanh toán phải là số nguyên VND khác 0", 422, "INVALID_PAYMENT_AMOUNT");
    }
    if (typeof paymentMethod !== "string" || !paymentMethod.trim()) {
      return errorJson("Phương thức thanh toán là bắt buộc", 422, "INVALID_PAYMENT_METHOD");
    }
    if ((total >= 0 && paymentAmount < 0) || (total < 0 && paymentAmount > 0)) {
      return errorJson("Chiều thu/trả tiền không khớp với tổng toa", 422, "INVALID_PAYMENT_DIRECTION");
    }
  }
  // Trước đây sửa nháp không bao giờ đổi trạng thái — toa đã thu đủ vẫn nằm "pending" và
  // bị tính là nợ. Thu đủ tiền (gồm khoản vừa thu) và hết nợ vàng thì chốt "completed".
  const status = isOrderSettled(total, paid + paymentAmount, goldDebt99) ? "completed" : "pending";

  const now = new Date().toISOString();

  const queries = [sql`DELETE FROM order_items WHERE order_id = ${id}`];
  for (const item of items) {
    const itemId = crypto.randomUUID();
    const itemTotal = item.unit_price * item.quantity - (item.discount || 0);
    queries.push(sql`
      INSERT INTO order_items (id, order_id, product_variant_id, item_name, quantity, unit_price, discount, total, metal_details, created_at)
      VALUES (${itemId}, ${id}, ${item.product_variant_id || null}, ${item.item_name || null},
              ${item.quantity}, ${item.unit_price}, ${item.discount || 0}, ${itemTotal},
              ${item.metal_details ? JSON.stringify(item.metal_details) : null}, ${now})
    `);
  }
  if (paymentAmount !== 0) {
    queries.push(sql`
      INSERT INTO payments
        (id, tenant_id, order_id, method, amount, status, payment_date, reference_no, created_at)
      VALUES
        (${crypto.randomUUID()}, ${tenantId}, ${id}, ${paymentMethod.trim()},
         ${paymentAmount}, 'completed', ${now}, ${additional_payment?.reference_no || null}, ${now})
    `);
  }
  const updateIndex = queries.length;
  queries.push(sql`
    UPDATE orders SET
      customer_id = ${customer_id || null}, subtotal = ${subtotal}, discount = ${discount}, total = ${total},
      trade_in_total = ${trade_in_total},
      trade_in_details = ${trade_in_details ? JSON.stringify(trade_in_details) : null},
      gold_price_99 = ${gold_price_99}, gold_sold_99 = ${gold_sold_99}, gold_bought_99 = ${gold_bought_99},
      gold_to_money_99 = ${gold_to_money_99}, gold_debt_99 = ${goldDebt99}, making_fee_total = ${making_fee_total},
      notes = ${notes || null}, old_money_debt = ${old_money_debt}, old_gold_debt_99 = ${old_gold_debt_99},
      status = ${status}, updated_at = ${now}
    WHERE id = ${id} AND tenant_id = ${tenantId}
    RETURNING id, order_number, status, total, gold_debt_99
  `);

  let rows;
  try {
    rows = (await sql.transaction(queries, { isolationLevel: "ReadCommitted" }))[updateIndex];
  } catch (err) {
    console.error("Không thể cập nhật hoá đơn nháp:", err);
    return errorJson("Không thể cập nhật hoá đơn, vui lòng thử lại", 500, "ORDER_UPDATE_FAILED");
  }

  for (const customerId of new Set([existing.customer_id, customer_id].filter(Boolean))) {
    try { await syncCustomerSupportContext(sql, env, tenantId, customerId); }
    catch (err) { console.error("Không đồng bộ được dữ liệu khách sau khi sửa đơn:", err.message); }
  }

  return json(rows[0]);
}
