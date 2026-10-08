const DEFAULT_SCHOOLSAI_API_BASE = "https://apic.schoolsai.work";

export function schoolsAiEndpoint(env, path) {
  const base = String(env?.KNOWLEDGE_WORKER_BASE_URL || DEFAULT_SCHOOLSAI_API_BASE)
    .trim()
    .replace(/\/+$/, "");
  return `${base}/api/v1/${String(path).replace(/^\/+/, "")}`;
}

// SchoolsAI chỉ nhận customer_context dạng object phẳng. Các danh sách được serialize
// thành JSON string để bot vẫn đọc được đầy đủ mà không vi phạm contract của API.
export function toSchoolsAiCustomerContext(source) {
  const customer = source.customer || {};
  const debt = source.debt || {};
  return {
    schema_version: String(source.schema_version || 1),
    synced_at: source.synced_at || new Date().toISOString(),
    customer_id: String(customer.id || ""),
    customer_name: customer.name || "",
    customer_phone: customer.phone || "",
    customer_email: customer.email || "",
    customer_address: customer.address || "",
    customer_is_business: String(Boolean(customer.is_business)),
    customer_tax_code: customer.tax_code || "",
    customer_created_at: customer.created_at || "",
    debt_money: String(Number(debt.money) || 0),
    debt_money_direction: debt.money_direction || "customer_owes_shop",
    debt_gold_99: String(Number(debt.gold_99) || 0),
    debt_gold_direction: debt.gold_direction || "customer_owes_shop",
    recent_orders_json: JSON.stringify(source.recent_orders || []),
    recent_gold_orders_json: JSON.stringify(source.recent_gold_orders || []),
  };
}

export async function getKnowledgeWorkerToken(sql, env, tenantId) {
  const rows = await sql`
    SELECT value FROM settings
    WHERE tenant_id = ${tenantId} AND key = 'knowledge_worker_api_key'
    LIMIT 1
  `;
  return rows[0]?.value?.trim() || env.KNOWLEDGE_WORKER_TOKEN || "";
}

export async function buildCustomerSupportContext(sql, tenantId, customerId) {
  const customers = await sql`
    SELECT id, name, phone, email, address, is_business, tax_code, created_at
    FROM customers WHERE id = ${customerId} AND tenant_id = ${tenantId} LIMIT 1
  `;
  if (!customers.length) throw new Error("Không tìm thấy khách hàng để đồng bộ");

  const debtRows = await sql`
    SELECT
      COALESCE(SUM(o.total - COALESCE(p.paid, 0)), 0) AS order_money_debt,
      COALESCE(SUM(o.gold_debt_99), 0) AS order_gold_debt
    FROM orders o
    LEFT JOIN (
      SELECT order_id, SUM(amount) AS paid FROM payments WHERE status = 'completed' GROUP BY order_id
    ) p ON p.order_id = o.id
    WHERE o.customer_id = ${customerId} AND o.tenant_id = ${tenantId}
      AND o.status NOT IN ('cancelled', 'refunded')
  `;
  const adjustmentRows = await sql`
    SELECT COALESCE(SUM(money_amount), 0) AS money, COALESCE(SUM(gold_amount_99), 0) AS gold
    FROM customer_debt_adjustments WHERE customer_id = ${customerId} AND tenant_id = ${tenantId}
  `;
  const orderRows = await sql`
    WITH recent AS (
      SELECT o.id, o.order_number, o.order_type, o.status, o.total, o.gold_debt_99, o.created_at,
             COALESCE(SUM(p.amount), 0) AS paid
      FROM orders o
      LEFT JOIN payments p ON p.order_id = o.id AND p.status = 'completed'
      WHERE o.customer_id = ${customerId} AND o.tenant_id = ${tenantId}
      GROUP BY o.id
      ORDER BY o.created_at DESC LIMIT 8
    )
    SELECT r.*, oi.id AS item_id, oi.quantity, oi.unit_price, oi.total AS item_total,
           COALESCE(pr.name, oi.item_name, 'Hàng tuỳ ý') AS item_name, pv.sku
    FROM recent r
    LEFT JOIN order_items oi ON oi.order_id = r.id
    LEFT JOIN product_variants pv ON pv.id = oi.product_variant_id
    LEFT JOIN products pr ON pr.id = pv.product_id
    ORDER BY r.created_at DESC, oi.created_at ASC
  `;

  const orderMap = new Map();
  for (const row of orderRows) {
    if (!orderMap.has(row.id)) {
      const total = Number(row.total) || 0;
      const paid = Number(row.paid) || 0;
      orderMap.set(row.id, {
        order_number: row.order_number,
        date: row.created_at,
        type: row.order_type,
        status: row.status,
        total,
        paid,
        remaining_money: total - paid,
        gold_debt_99: Number(row.gold_debt_99) || 0,
        items: [],
      });
    }
    if (row.item_id) orderMap.get(row.id).items.push({
      name: row.item_name,
      sku: row.sku || undefined,
      quantity: Number(row.quantity) || 0,
      unit_price: Number(row.unit_price) || 0,
      total: Number(row.item_total) || 0,
    });
  }
  const moneyDebt = Number(debtRows[0]?.order_money_debt || 0) + Number(adjustmentRows[0]?.money || 0);
  const goldDebt = Number(debtRows[0]?.order_gold_debt || 0) + Number(adjustmentRows[0]?.gold || 0);

  // Phiếu gia công (đặt hàng vàng theo yêu cầu) — khách hỏi bot "phiếu của tôi tới đâu rồi"
  // cần thấy được trạng thái pending/ready/delivered, không chỉ đơn bán lẻ/sỉ thông thường.
  const goldOrderRows = await sql`
    SELECT go.id, go.order_number, go.order_date, go.expected_date, go.status,
           go.total_amount, go.deposit_amount, go.remaining_amount,
           goi.product_name, goi.description, goi.quantity, goi.weight, goi.gold_purity, goi.amount
    FROM gold_orders go
    LEFT JOIN gold_order_items goi ON goi.order_id = go.id
    WHERE go.customer_id = ${customerId} AND go.tenant_id = ${tenantId}
    ORDER BY go.created_at DESC LIMIT 8
  `;
  const goldOrderMap = new Map();
  for (const row of goldOrderRows) {
    if (!goldOrderMap.has(row.id)) {
      goldOrderMap.set(row.id, {
        order_number: row.order_number,
        order_date: row.order_date,
        expected_date: row.expected_date,
        status: row.status,
        total_amount: Number(row.total_amount) || 0,
        deposit_amount: Number(row.deposit_amount) || 0,
        remaining_amount: Number(row.remaining_amount) || 0,
        items: [],
      });
    }
    if (row.product_name) goldOrderMap.get(row.id).items.push({
      name: row.product_name,
      description: row.description || undefined,
      quantity: Number(row.quantity) || 0,
      weight_chi: Number(row.weight) || 0,
      gold_purity: Number(row.gold_purity) || 0,
      amount: Number(row.amount) || 0,
    });
  }

  return {
    schema_version: 1,
    synced_at: new Date().toISOString(),
    customer: customers[0],
    debt: {
      money: moneyDebt,
      money_direction: moneyDebt >= 0 ? "customer_owes_shop" : "shop_owes_customer",
      gold_99: goldDebt,
      gold_direction: goldDebt >= 0 ? "customer_owes_shop" : "shop_owes_customer",
    },
    recent_orders: Array.from(orderMap.values()),
    recent_gold_orders: Array.from(goldOrderMap.values()),
  };
}

export async function syncCustomerSupportContext(sql, env, tenantId, customerId, session = null) {
  let supportSession = session;
  if (!supportSession) {
    const rows = await sql`
      SELECT support_chat_session FROM customers
      WHERE id = ${customerId} AND tenant_id = ${tenantId} LIMIT 1
    `;
    supportSession = rows[0]?.support_chat_session;
  }
  if (!supportSession) return { skipped: true };
  const token = await getKnowledgeWorkerToken(sql, env, tenantId);
  if (!token) return { skipped: true };
  const source = await buildCustomerSupportContext(sql, tenantId, customerId);
  const context = toSchoolsAiCustomerContext(source);
  const response = await fetch(schoolsAiEndpoint(env, "customer-context"), {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session: supportSession, context }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Không đồng bộ được dữ liệu khách (${response.status})`);
  return data;
}

/**
 * Chủ động gửi 1 tin nhắn cho khách qua bot chat (VD báo "đơn đã xong, mời ghé lấy").
 * Yêu cầu khách đã có support_chat_session (tạo qua createSupportChatLink/
 * ensureCustomerSupportLink trước đó, hoặc khách đã tự chat ít nhất 1 lần) — nếu chưa có
 * session, PocketBase phía bot sẽ không tìm thấy phiên và trả 404, nên bỏ qua thay vì lỗi
 * (best-effort, không được chặn luồng chính đang gọi hàm này, VD đổi trạng thái đơn).
 */
export async function sendSupportChatMessage(sql, env, tenantId, customerId, text, session = null) {
  let supportSession = session;
  if (!supportSession) {
    const rows = await sql`
      SELECT support_chat_session FROM customers
      WHERE id = ${customerId} AND tenant_id = ${tenantId} LIMIT 1
    `;
    supportSession = rows[0]?.support_chat_session;
  }
  if (!supportSession) return { skipped: true };
  const token = await getKnowledgeWorkerToken(sql, env, tenantId);
  if (!token) return { skipped: true };

  const response = await fetch(schoolsAiEndpoint(env, "messages"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session: supportSession, text }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Không gửi được tin nhắn (${response.status})`);
  return data;
}

export async function createSupportChatLink(sql, env, tenantId, customerName) {
  const token = await getKnowledgeWorkerToken(sql, env, tenantId);
  if (!token) throw new Error("Chưa cấu hình API key Social/Knowledge Worker");

  const response = await fetch(schoolsAiEndpoint(env, "chat-link"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ customer_name: customerName }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.chat_url) {
    throw new Error(data.error || `Không tạo được link hỗ trợ (${response.status})`);
  }
  return { session: data.session || null, url: data.chat_url };
}

export async function ensureCustomerSupportLink(sql, env, tenantId, customer) {
  if (!customer || customer.support_chat_url) return customer;

  const name = String(customer.name || "").trim() || `Khách hàng ${String(customer.id).slice(0, 8)}`;
  const link = await createSupportChatLink(sql, env, tenantId, name);
  const now = new Date().toISOString();
  const rows = await sql`
    UPDATE customers
    SET support_chat_url = ${link.url}, support_chat_session = ${link.session},
        support_chat_created_at = ${now}, updated_at = ${now}
    WHERE id = ${customer.id} AND tenant_id = ${tenantId} AND support_chat_url IS NULL
    RETURNING support_chat_url, support_chat_session, support_chat_created_at
  `;

  if (rows.length) {
    const result = { ...customer, ...rows[0] };
    try { await syncCustomerSupportContext(sql, env, tenantId, customer.id, result.support_chat_session); }
    catch (err) { console.error("Không đồng bộ được dữ liệu khách mới:", err.message); }
    return result;
  }
  const current = await sql`
    SELECT support_chat_url, support_chat_session, support_chat_created_at
    FROM customers WHERE id = ${customer.id} AND tenant_id = ${tenantId} LIMIT 1
  `;
  return { ...customer, ...(current[0] || {}) };
}
