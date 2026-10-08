import assert from "node:assert/strict";
import test from "node:test";

import { schoolsAiEndpoint, toSchoolsAiCustomerContext } from "../functions/_support-chat.js";

test("SchoolsAI endpoint defaults to the current API and supports an override", () => {
  assert.equal(schoolsAiEndpoint({}, "chat-link"), "https://apic.schoolsai.work/api/v1/chat-link");
  assert.equal(
    schoolsAiEndpoint({ KNOWLEDGE_WORKER_BASE_URL: "https://example.test/" }, "/messages"),
    "https://example.test/api/v1/messages"
  );
});

test("customer context is flat while preserving order history as JSON", () => {
  const context = toSchoolsAiCustomerContext({
    schema_version: 1,
    synced_at: "2026-09-22T00:00:00.000Z",
    customer: { id: "c1", name: "Nguyễn An", is_business: false },
    debt: { money: 125000, money_direction: "customer_owes_shop", gold_99: 0 },
    recent_orders: [{ order_number: "HD-1", total: 125000 }],
    recent_gold_orders: [],
  });

  assert.equal(context.customer_name, "Nguyễn An");
  assert.equal(context.debt_money, "125000");
  assert.deepEqual(JSON.parse(context.recent_orders_json), [{ order_number: "HD-1", total: 125000 }]);
  assert.ok(Object.values(context).every(value => value === null || typeof value !== "object"));
});
