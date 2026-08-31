import { describe, expect, it } from "vitest";

import { EligibilityReviewService } from "../../worker/domain/eligibility-review-service";
import { EligibilityService } from "../../worker/domain/eligibility-service";
import type { HumanContext } from "../../worker/domain/proposal-service";
import type { Clock, IdGenerator } from "../../worker/domain/primitives";
import type { RequestContext } from "../../worker/http/context";
import { SessionRepository } from "../../worker/repositories/session-repository";
import { db } from "./setup";

const clock: Clock = { now: () => new Date("2026-08-29T07:00:00.000Z") };

class SequenceIds implements IdGenerator {
  private sequence = 0;
  constructor(private readonly namespace: string) {}
  next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_review_${this.namespace}_${this.sequence}`;
  }
}

let sequence = 0;

async function reviewFixture() {
  sequence += 1;
  const ids = new SequenceIds(String(sequence));
  const session = await new SessionRepository(db, clock, ids).getOrCreate(null);
  const row = await db.prepare(
    `SELECT o.id AS order_id, oi.id AS order_item_id, p.id AS product_id
       FROM orders o
       JOIN order_items oi ON oi.session_id = o.session_id AND oi.order_id = o.id
       JOIN product_variants pv ON pv.session_id = oi.session_id AND pv.id = oi.variant_id
       JOIN products p ON p.session_id = pv.session_id AND p.id = pv.product_id
      WHERE o.session_id = ? AND o.order_number = 'ORD-1002'`,
  ).bind(session.id).first<{ order_id: string; order_item_id: string; product_id: string }>();
  if (row === null) throw new Error("missing review fixture");
  await db.prepare("UPDATE products SET returnable_condition = 'damaged' WHERE session_id = ? AND id = ?")
    .bind(session.id, row.product_id).run();
  await db.prepare("UPDATE orders SET ordered_at = ?, fulfilled_at = ?, delivered_at = ? WHERE session_id = ? AND id = ?")
    .bind("2026-08-20T07:00:00.000Z", "2026-08-21T07:00:00.000Z", "2026-08-22T07:00:00.000Z", session.id, row.order_id).run();
  const agent: RequestContext = {
    sessionId: session.id,
    seedVersion: session.seedVersion,
    csrfToken: "csrf",
    actor: { type: "agent", id: "agent:test" },
    requestId: `review-${sequence}`,
  };
  const human: HumanContext = { ...agent, actor: { type: "human", id: "merchant:test" } };
  const parent = await new EligibilityService(db, clock, ids).check({
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    requestedQuantity: 1,
    reasonCode: "damaged",
    conditionCode: "damaged",
    idempotencyKey: `review-parent-${sequence}`,
  }, agent);
  if (parent.status !== "needs_review") throw new Error("fixture must need review");
  return { session, ids, agent, human, parent, service: new EligibilityReviewService(db, clock, ids) };
}

describe("EligibilityReviewService", () => {
  it.each([
    ["eligible_exception_approved", "eligible", true],
    ["ineligible_exception_denied", "ineligible", false],
    ["insufficient_evidence", "needs_review", false],
  ] as const)("creates an immutable human child for %s", async (reviewResult, status, submissionAllowed) => {
    const f = await reviewFixture();
    const child = await f.service.review({
      parentCheckId: f.parent.eligibilityCheckId,
      expectedVersion: f.parent.caseVersion,
      reviewResult,
      reasonCode: "MERCHANT_REVIEW_DECISION",
      note: "Structured review complete.",
      idempotencyKey: `review-child-${reviewResult}-${sequence}`,
    }, f.human);
    expect(child).toMatchObject({
      parentCheckId: f.parent.eligibilityCheckId,
      status,
      proposalSubmissionAllowed: submissionAllowed,
      reviewedBy: f.human.actor.id,
    });
    const parent = await db.prepare(
      "SELECT status, review_source, reviewed_by FROM eligibility_checks WHERE session_id = ? AND id = ?",
    ).bind(f.session.id, f.parent.eligibilityCheckId).first();
    expect(parent).toEqual({ status: "needs_review", review_source: "engine", reviewed_by: null });
    const stored = await db.prepare(
      "SELECT calculation_snapshot_json FROM eligibility_checks WHERE session_id = ? AND id = ?",
    ).bind(f.session.id, child.eligibilityCheckId).first<{ calculation_snapshot_json: string }>();
    expect(JSON.parse(stored!.calculation_snapshot_json)).toMatchObject({
      humanReview: {
        result: reviewResult,
        reasonCode: "MERCHANT_REVIEW_DECISION",
        note: "Structured review complete.",
        reviewedBy: f.human.actor.id,
      },
    });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ? AND event_type = 'rma_proposal.invalidated'")
      .bind(f.session.id).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("invalidates an affected pending proposal exactly once under idempotent concurrent review", async () => {
    const f = await reviewFixture();
    const eligibleId = "eligible_before_human_review";
    await db.prepare(
      `INSERT INTO eligibility_checks
        (id, session_id, case_id, order_item_id, policy_version_id, requested_quantity,
         reason_code, condition_code, status, allowed_resolutions_json, return_required,
         return_shipping_payer, matched_rules_json, calculation_snapshot_json, input_hash,
         parent_check_id, review_source, reviewed_by, reviewed_at, created_at, expires_at)
       SELECT ?, session_id, case_id, order_item_id, policy_version_id, requested_quantity,
              reason_code, condition_code, 'eligible', '[]', return_required,
              return_shipping_payer, matched_rules_json, calculation_snapshot_json, ?,
              NULL, 'engine', NULL, NULL, created_at, expires_at
         FROM eligibility_checks WHERE session_id = ? AND id = ?`,
    ).bind(eligibleId, "eligible_before_hash", f.session.id, f.parent.eligibilityCheckId).run();
    await db.prepare(
      `INSERT INTO rma_proposals
        (id, session_id, case_id, eligibility_check_id, order_item_id, resolution_type,
         requested_quantity, replacement_variant_id, refund_amount_cents, store_credit_cents,
         merchant_cost_cents, customer_message_json, status, idempotency_key, request_hash,
         return_required, created_by, created_at, expires_at, version)
       SELECT 'proposal_affected_review', session_id, case_id, id, order_item_id, 'refund',
              requested_quantity, NULL, 3200, NULL, 3200,
              '{"subject":"Safe","bodyText":"Safe","locale":"en-US"}',
              'pending', 'affected-review-key', 'affected-review-hash', return_required,
              'agent', created_at, expires_at, 1
         FROM eligibility_checks WHERE session_id = ? AND id = ?`,
    ).bind(f.session.id, eligibleId).run();
    const command = {
      parentCheckId: f.parent.eligibilityCheckId,
      expectedVersion: f.parent.caseVersion,
      reviewResult: "ineligible_exception_denied" as const,
      reasonCode: "MERCHANT_REVIEW_DECISION",
      idempotencyKey: "concurrent-review-invalidation",
    };
    const outcomes = await Promise.all([
      f.service.review(command, f.human),
      f.service.review(command, f.human),
    ]);
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(await db.prepare(
      "SELECT status, version, invalidated_reason_code FROM rma_proposals WHERE session_id = ? AND id = 'proposal_affected_review'",
    ).bind(f.session.id).first()).toEqual({
      status: "invalidated", version: 2, invalidated_reason_code: "ELIGIBILITY_REVIEWED",
    });
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ? AND entity_id = 'proposal_affected_review' AND event_type = 'rma_proposal.invalidated'",
    ).bind(f.session.id).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM rma_proposals WHERE session_id = ? AND case_id = ? AND status = 'pending'",
    ).bind(f.session.id, f.parent.caseId).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("requires human context, rejects cross-session parents, and protects a parent from a second review", async () => {
    const first = await reviewFixture();
    const command = {
      parentCheckId: first.parent.eligibilityCheckId,
      expectedVersion: first.parent.caseVersion,
      reviewResult: "ineligible_exception_denied" as const,
      reasonCode: "MERCHANT_REVIEW_DECISION",
      idempotencyKey: `review-once-${sequence}`,
    };
    await expect(first.service.review(command, first.agent as HumanContext))
      .rejects.toMatchObject({ code: "CAPABILITY_DENIED", httpStatus: 403 });
    const second = await reviewFixture();
    await expect(second.service.review(command, second.human))
      .rejects.toMatchObject({ code: "ELIGIBILITY_CHECK_NOT_FOUND", httpStatus: 404 });
    await first.service.review(command, first.human);
    await expect(first.service.review({ ...command, idempotencyKey: `${command.idempotencyKey}-other` }, first.human))
      .rejects.toMatchObject({ code: "ELIGIBILITY_ALREADY_REVIEWED", httpStatus: 409 });
  });

  it("replays the same review idempotently and rejects a changed payload", async () => {
    const f = await reviewFixture();
    const command = {
      parentCheckId: f.parent.eligibilityCheckId,
      expectedVersion: f.parent.caseVersion,
      reviewResult: "insufficient_evidence" as const,
      reasonCode: "MORE_EVIDENCE_REQUIRED",
      idempotencyKey: `review-replay-${sequence}`,
    };
    const first = await f.service.review(command, f.human);
    expect(await f.service.review(command, f.human)).toEqual(first);
    await expect(f.service.review({ ...command, reasonCode: "DIFFERENT_REASON" }, f.human))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", httpStatus: 409 });
  });
});
