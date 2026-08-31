/// <reference types="@cloudflare/vitest-plugin/types" />

import { describe, expect, it } from "vitest";

import { ApprovalQueueService } from "../../worker/domain/approval-queue-service";
import { CaseQueryService } from "../../worker/domain/case-query-service";
import { DashboardService } from "../../worker/domain/dashboard-service";
import { EligibilityService } from "../../worker/domain/eligibility-service";
import { SessionRepository } from "../../worker/repositories/session-repository";
import { fixedClock } from "../fixtures/runtime";
import { db } from "./setup";

let seedSequence = 0;

async function seed() {
  seedSequence += 1;
  let idSequence = 0;
  const ids = { next: (prefix: string) => `${prefix}_workspace_${seedSequence}_${++idSequence}` };
  const session = await new SessionRepository(db, fixedClock, ids).getOrCreate(null);
  const order = await db.prepare(
    `SELECT o.id AS order_id, oi.id AS item_id
       FROM orders o JOIN order_items oi ON oi.session_id = o.session_id AND oi.order_id = o.id
      WHERE o.session_id = ? AND o.order_number = 'ORD-1001'`,
  ).bind(session.id).first<{ order_id: string; item_id: string }>();
  if (order === null) throw new Error("missing workspace fixture");
  const context = {
    sessionId: session.id, seedVersion: session.seedVersion, csrfToken: "csrf",
    actor: { type: "agent" as const, id: "agent:test" }, requestId: "req-query",
  };
  return { ids, session, order, context };
}

describe("workspace query services", () => {
  it("returns canonical monotonically increasing Case versions and cursor-safe activity", async () => {
    const fixture = await seed();
    const writes = new EligibilityService(db, fixedClock, fixture.ids);
    const first = await writes.check({
      orderId: fixture.order.order_id, orderItemId: fixture.order.item_id, requestedQuantity: 1,
      reasonCode: "wrong_size", conditionCode: "unopened", idempotencyKey: "workspace-1",
    }, fixture.context);
    const queries = new CaseQueryService(db);
    const before = await queries.getWorkspace(first.caseId, fixture.context);
    const serializedBefore = JSON.stringify(before);
    const publicEligibility = before.latestEligibility as unknown as Readonly<Record<string, unknown>>;
    expect(serializedBefore).not.toContain(fixture.session.id);
    expect(serializedBefore).not.toContain('"inputHash"');
    expect(serializedBefore).not.toContain('"input"');
    expect(serializedBefore).not.toContain("idempotencyKey");
    expect(publicEligibility).toMatchObject({
      eligibilityCheckId: first.eligibilityCheckId,
      status: "eligible",
      policyVersionId: first.policyVersionId,
      policyName: "Demo Returns Policy",
      requestedQuantity: 1,
      returnRequired: true,
      returnShippingPayer: "merchant",
      proposalSubmissionAllowed: true,
    });
    expect(publicEligibility.allowedResolutions).toEqual(first.allowedResolutions);
    expect(publicEligibility.matchedRules).toEqual(first.matchedRules);
    expect(publicEligibility.reasonCodes).toEqual(first.reasonCodes);
    const second = await writes.check({
      caseId: first.caseId, orderId: fixture.order.order_id, orderItemId: fixture.order.item_id,
      requestedQuantity: 1, reasonCode: "wrong_size", conditionCode: "opened_unused",
      idempotencyKey: "workspace-2",
    }, fixture.context);
    const after = await queries.getWorkspace(first.caseId, fixture.context);
    expect(before.version).toBe(1);
    expect(after.version).toBe(2);
    expect(after.version).toBeGreaterThanOrEqual(second.caseVersion);

    const activity = await queries.getActivity(first.caseId, { limit: 1 }, fixture.context);
    expect(activity.items).toHaveLength(1);
    expect(activity.nextCursor).not.toBeNull();
    await expect(queries.getActivity(first.caseId, { limit: 1, cursor: "not-a-cursor" }, fixture.context))
      .rejects.toMatchObject({ code: "INVALID_CURSOR", httpStatus: 400 });
    expect(JSON.stringify(activity)).not.toContain("Customer asked");
  });

  it("returns safe dashboard aggregates without evaluating policy", async () => {
    const fixture = await seed();
    const result = await new DashboardService(db).get(fixture.context);
    expect(result).toEqual({
      openCases: 0, pendingProposals: 0, pendingEligibilityReviews: 0,
      completedRmasToday: 0, exceptionCount: 0,
    });
  });

  it("shows only the latest unresolved needs-review snapshot as reviewable", async () => {
    const fixture = await seed();
    const old = await db.prepare(
      `SELECT o.id AS order_id, oi.id AS item_id, pv.product_id
         FROM orders o
         JOIN order_items oi ON oi.session_id = o.session_id AND oi.order_id = o.id
         JOIN product_variants pv ON pv.session_id = oi.session_id AND pv.id = oi.variant_id
        WHERE o.session_id = ? AND o.order_number = 'ORD-1002'`,
    ).bind(fixture.session.id).first<{ order_id: string; item_id: string; product_id: string }>();
    if (old === null) throw new Error("missing needs-review fixture");
    await db.batch([
      db.prepare("UPDATE products SET returnable_condition = 'damaged' WHERE session_id = ? AND id = ?")
        .bind(fixture.session.id, old.product_id),
      db.prepare(
        `UPDATE orders SET ordered_at = '2026-08-20T07:00:00.000Z',
                           fulfilled_at = '2026-08-21T07:00:00.000Z',
                           delivered_at = '2026-08-22T07:00:00.000Z'
          WHERE session_id = ? AND id = ?`,
      ).bind(fixture.session.id, old.order_id),
    ]);
    const decision = await new EligibilityService(db, fixedClock, fixture.ids).check({
      orderId: old.order_id, orderItemId: old.item_id, requestedQuantity: 1,
      reasonCode: "damaged", conditionCode: "damaged", idempotencyKey: "queue-review",
    }, fixture.context);
    expect(decision.status).toBe("needs_review");
    const queue = new ApprovalQueueService(db, fixedClock);
    expect((await queue.list({ type: "eligibility_review", limit: 20 }, fixture.context)).items
      .map(item => item.id)).toEqual([decision.eligibilityCheckId]);

    await db.prepare(
      `INSERT INTO eligibility_checks
        (id, session_id, case_id, order_item_id, policy_version_id, requested_quantity,
         reason_code, condition_code, status, allowed_resolutions_json, return_required,
         return_shipping_payer, matched_rules_json, calculation_snapshot_json, input_hash,
         parent_check_id, review_source, reviewed_by, reviewed_at, created_at, expires_at)
       SELECT 'review_child', session_id, case_id, order_item_id, policy_version_id,
              requested_quantity, reason_code, condition_code, status, allowed_resolutions_json,
              return_required, return_shipping_payer, matched_rules_json, calculation_snapshot_json,
              input_hash, id, 'human', 'human:test', '2026-08-29T07:01:00.000Z',
              '2026-08-29T07:01:00.000Z', '2026-08-29T08:01:00.000Z'
         FROM eligibility_checks WHERE session_id = ? AND id = ?`,
    ).bind(fixture.session.id, decision.eligibilityCheckId).run();
    expect((await queue.list({ type: "eligibility_review", limit: 20 }, fixture.context)).items
      .map(item => item.id)).toEqual(["review_child"]);
  });

  it("exposes only pending proposals and unresolved needs-review checks in the approval queue", async () => {
    const fixture = await seed();
    const writes = new EligibilityService(db, fixedClock, fixture.ids);
    const eligible = await writes.check({
      orderId: fixture.order.order_id, orderItemId: fixture.order.item_id, requestedQuantity: 1,
      reasonCode: "wrong_size", conditionCode: "unopened", idempotencyKey: "queue-eligible",
    }, fixture.context);
    const now = "2026-08-29T07:00:00.000Z";
    await db.batch([
      db.prepare(
        `INSERT INTO rma_proposals
          (id, session_id, case_id, eligibility_check_id, order_item_id, resolution_type,
           requested_quantity, replacement_variant_id, refund_amount_cents, store_credit_cents,
           merchant_cost_cents, customer_message_json, status, idempotency_key, request_hash,
           return_required, created_by, created_at, expires_at, version)
         VALUES (?, ?, ?, ?, ?, 'refund', 1, NULL, 12900, NULL, 12900, '{}', ?, ?, ?, 1,
                 'agent', ?, '2026-08-29T08:00:00.000Z', 1)`,
      ).bind("proposal_pending", fixture.session.id, eligible.caseId, eligible.eligibilityCheckId,
        fixture.order.item_id, "pending", "pending-key", "hash-p", now),
      db.prepare(
        `INSERT INTO rma_proposals
          (id, session_id, case_id, eligibility_check_id, order_item_id, resolution_type,
           requested_quantity, replacement_variant_id, refund_amount_cents, store_credit_cents,
           merchant_cost_cents, customer_message_json, status, idempotency_key, request_hash,
           return_required, created_by, created_at, expires_at, version)
         VALUES (?, ?, ?, ?, ?, 'refund', 1, NULL, 12900, NULL, 12900, '{}', ?, ?, ?, 1,
                 'agent', ?, '2026-08-29T08:00:00.000Z', 1)`,
      ).bind("proposal_rejected", fixture.session.id, eligible.caseId, eligible.eligibilityCheckId,
        fixture.order.item_id, "rejected", "rejected-key", "hash-r", now),
    ]);
    const queue = await new ApprovalQueueService(db, fixedClock).list({ limit: 20 }, fixture.context);
    expect(queue.items.map(item => item.id)).toEqual(["proposal_pending"]);
    expect(queue.items.every(item => item.type === "rma_proposal" && item.status === "pending")).toBe(true);

    const other = await seed();
    expect((await new ApprovalQueueService(db, fixedClock).list({ limit: 20 }, other.context)).items).toEqual([]);
    await expect(new CaseQueryService(db).getWorkspace(eligible.caseId, other.context))
      .rejects.toMatchObject({ code: "CASE_NOT_FOUND", httpStatus: 404 });
  });
});
