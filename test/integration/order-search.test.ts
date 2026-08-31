/// <reference types="@cloudflare/vitest-plugin/types" />

import { describe, expect, it } from "vitest";

import { DemoCommerceAdapter } from "../../worker/demo/demo-commerce-adapter";
import { OrderService } from "../../worker/domain/order-service";
import { PolicyReadService } from "../../worker/domain/policy-read-service";
import { SessionRepository } from "../../worker/repositories/session-repository";
import { fixedClock } from "../fixtures/runtime";
import { db } from "./setup";

let seedSequence = 0;

async function seed() {
  seedSequence += 1;
  let idSequence = 0;
  const ids = { next: (prefix: string) => `${prefix}_order_${seedSequence}_${++idSequence}` };
  const session = await new SessionRepository(db, fixedClock, ids).getOrCreate(null);
  return { session, context: {
    sessionId: session.id, seedVersion: session.seedVersion, csrfToken: "csrf",
    actor: { type: "agent" as const, id: "agent:test" }, requestId: "req-order",
  } };
}

describe("order and policy reads", () => {
  it("caps deterministic search results at five, masks PII, and requires explicit selection", async () => {
    const { session, context } = await seed();
    const customer = await db.prepare(
      "SELECT id FROM customers WHERE session_id = ? LIMIT 1",
    ).bind(session.id).first<{ id: string }>();
    if (customer === null) throw new Error("missing customer fixture");
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 6; index += 1) {
      statements.push(db.prepare(
        `INSERT INTO orders
          (id, session_id, order_number, customer_id, currency, status, ordered_at, fulfilled_at, delivered_at)
         VALUES (?, ?, ?, ?, 'USD', 'delivered', ?, ?, ?)`,
      ).bind(
        `order_search_${index}`, session.id, `MATCH-${index}`, customer.id,
        "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z", "2026-08-03T00:00:00.000Z",
      ));
    }
    await db.batch(statements);

    const result = await new OrderService(new DemoCommerceAdapter(db)).search(
      { query: "MATCH", limit: 5 }, context,
    );
    expect(result.orders).toHaveLength(5);
    expect(result.orders.map(order => order.orderNumber)).toEqual([
      "MATCH-0", "MATCH-1", "MATCH-2", "MATCH-3", "MATCH-4",
    ]);
    expect(result.requiresSelection).toBe(true);
    expect(result.orders.every(order => order.maskedEmail === "a****@example.test")).toBe(true);
    expect(result.orders.every(order => order.customerDisplayName === "Avery C.")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("avery@example.test");
    expect(JSON.stringify(result)).not.toContain("Avery Chen");
  });

  it("keeps CommerceAdapter reads session-scoped with the standard not-found error", async () => {
    const first = await seed();
    const second = await seed();
    const order = await db.prepare("SELECT id FROM orders WHERE session_id = ? LIMIT 1")
      .bind(first.session.id).first<{ id: string }>();
    if (order === null) throw new Error("missing order fixture");
    await expect(new DemoCommerceAdapter(db).getOrder(second.session.id, order.id))
      .rejects.toMatchObject({ code: "ORDER_NOT_FOUND", httpStatus: 404 });
  });

  it("reads the order item's locked policy rather than the current active policy", async () => {
    const { session, context } = await seed();
    const locked = await db.prepare(
      `SELECT o.id AS order_id, oi.id AS item_id, oi.policy_version_id
         FROM orders o JOIN order_items oi ON oi.session_id = o.session_id AND oi.order_id = o.id
        WHERE o.session_id = ? LIMIT 1`,
    ).bind(session.id).first<{ order_id: string; item_id: string; policy_version_id: string }>();
    if (locked === null) throw new Error("missing order item fixture");
    await db.batch([
      db.prepare("UPDATE policy_versions SET status = 'retired' WHERE session_id = ? AND id = ?")
        .bind(session.id, locked.policy_version_id),
      db.prepare(
        `INSERT INTO policy_versions
          (id, session_id, version_number, name, effective_from, effective_to, default_window_days,
           absolute_max_window_days, default_return_required, default_resolutions_json,
           return_shipping_payer, status, version)
         VALUES ('policy_active_new', ?, 2, 'New Active', '2026-08-20T00:00:00.000Z', NULL,
                 7, 30, 0, '["refund"]', 'customer', 'active', 1)`,
      ).bind(session.id),
    ]);
    const result = await new PolicyReadService(db).getLockedPolicy({
      orderId: locked.order_id, orderItemId: locked.item_id,
    }, context);
    expect(result.policyVersionId).toBe(locked.policy_version_id);
    expect(result.name).toBe("Demo Returns Policy");
    expect(result.lockedToOrderItem).toBe(true);
  });
});
