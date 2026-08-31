import { EligibilityService } from "../../worker/domain/eligibility-service";
import { ProposalService, type HumanContext, type SubmitProposal } from "../../worker/domain/proposal-service";
import type { Clock, IdGenerator } from "../../worker/domain/primitives";
import { SessionRepository } from "../../worker/repositories/session-repository";
import type { ResolutionType } from "../../src/shared/contracts/common";

export const approvalClock: Clock = { now: () => new Date("2026-08-29T07:00:00.000Z") };
let sequence = 0;
export const approvalIds: IdGenerator = { next: prefix => `${prefix}_approval_${++sequence}` };

export async function approvalFixture(db: D1Database, resolution: ResolutionType = "refund", returnRequired = true) {
  const session = await new SessionRepository(db, approvalClock, approvalIds).getOrCreate(null);
  const human: HumanContext = {
    sessionId: session.id, seedVersion: session.seedVersion, csrfToken: "csrf",
    actor: { type: "human", id: "merchant:test" }, requestId: approvalIds.next("req"),
  };
  const facts = await db.prepare(`SELECT o.id AS orderId, oi.id AS orderItemId,
    replacement.id AS replacementId, oi.policy_version_id AS policyId
    FROM orders o JOIN order_items oi ON oi.session_id = o.session_id AND oi.order_id = o.id
    JOIN product_variants original ON original.session_id = oi.session_id AND original.id = oi.variant_id
    JOIN product_variants replacement ON replacement.session_id = original.session_id
      AND replacement.product_id = original.product_id AND replacement.id <> original.id
    WHERE o.session_id = ? AND o.order_number = 'ORD-1001'`).bind(session.id)
    .first<{ orderId: string; orderItemId: string; replacementId: string; policyId: string }>();
  if (facts === null) throw new Error("Missing approval fixture");
  if (!returnRequired) {
    await db.prepare("UPDATE policy_versions SET default_return_required = 0 WHERE session_id = ? AND id = ?")
      .bind(session.id, facts.policyId).run();
  }
  await db.prepare("UPDATE product_variants SET inventory_quantity = 1 WHERE session_id = ? AND id = ?")
    .bind(session.id, facts.replacementId).run();
  const createProposal = async (orderItemId = facts.orderItemId) => {
    const check = await new EligibilityService(db, approvalClock, approvalIds).check({
      orderId: facts.orderId, orderItemId, requestedQuantity: 1,
      reasonCode: "wrong_size", conditionCode: "opened_unused", storeCreditConsent: true,
      replacementVariantId: facts.replacementId, idempotencyKey: approvalIds.next("check"),
    }, human);
    const submission: SubmitProposal = {
      caseId: check.caseId, eligibilityCheckId: check.eligibilityCheckId, resolutionType: resolution,
      ...(resolution === "exchange" ? { replacementVariantId: facts.replacementId } : {}),
      customerMessage: { subject: "Review", bodyText: "Demo return", locale: "en-US" },
      idempotencyKey: approvalIds.next("submit"),
    };
    return new ProposalService(db, approvalClock, approvalIds).submit(submission, human);
  };
  const proposal = await createProposal();
  const command = {
    proposalId: proposal.proposalId, expectedVersion: proposal.version,
    confirmation: "approve_and_simulate_completion" as const, idempotencyKey: approvalIds.next("approve"),
  };
  return { human, facts, proposal, command, createProposal };
}

export async function executionCounts(db: D1Database, sessionId: string) {
  const tables = ["rmas", "rma_items", "simulated_refunds", "store_credits", "inventory_reservations", "return_labels"] as const;
  return Object.fromEntries(await Promise.all(tables.map(async table => [table,
    (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).bind(sessionId).first<{ n: number }>())!.n,
  ])));
}
