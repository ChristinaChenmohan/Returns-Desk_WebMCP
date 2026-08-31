import type { HumanContext } from "../domain/proposal-service";
import type { IdGenerator } from "../domain/primitives";
import { ApprovalRepository } from "./approval-repository";
import type { ProposalFactGuard, ProposalRecord } from "./proposal-repository";

export interface ApprovalBatchInput {
  proposal: ProposalRecord;
  guard: ProposalFactGuard;
  context: HumanContext;
  idempotencyKey: string;
  requestHash: string;
  now: string;
}

// Each statement is owned by this attempt's unique RMA ID. A losing attempt
// cannot consume quantity, inventory, or write audits belonging to the winner.
export function buildApprovalBatch(db: D1Database, ids: IdGenerator, input: ApprovalBatchInput): D1PreparedStatement[] {
  const { proposal: p, guard, context, now } = input;
  const rmaId = ids.next("rma");
  const owned = "EXISTS (SELECT 1 FROM rmas WHERE session_id = ? AND id = ? AND proposal_id = ?)";
  const owner = [p.sessionId, rmaId, p.id];
  const statements = [
    new ApprovalRepository(db).prepareRma(p, guard, context, rmaId, `DEMO-RMA-${rmaId}`, now),
    db.prepare(`UPDATE order_items SET previously_returned_quantity = previously_returned_quantity + ?
      WHERE session_id = ? AND id = ? AND fulfilled_quantity - previously_returned_quantity >= ?
        AND ${owned}`).bind(p.requestedQuantity, p.sessionId, p.orderItemId, p.requestedQuantity, ...owner),
    db.prepare(`INSERT INTO rma_items (id, session_id, rma_id, order_item_id, quantity, replacement_variant_id)
      SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1 AND ${owned}`)
      .bind(ids.next("rma_item"), p.sessionId, rmaId, p.orderItemId, p.requestedQuantity, p.replacementVariantId, ...owner),
  ];
  const effectId = ids.next(p.resolutionType === "exchange" ? "reservation" : p.resolutionType);
  const effectType = p.resolutionType === "exchange" ? "inventory_reservation" : p.resolutionType === "refund" ? "simulated_refund" : "store_credit";
  const effectEvent = p.resolutionType === "exchange" ? "inventory.committed" : p.resolutionType === "refund" ? "refund.simulated" : "store_credit.created";
  if (p.resolutionType === "exchange") {
    statements.push(
      db.prepare(`UPDATE product_variants SET inventory_quantity = inventory_quantity - ?, inventory_version = inventory_version + 1
        WHERE session_id = ? AND id = ? AND active = 1 AND inventory_quantity >= ? AND ${owned}`)
        .bind(p.requestedQuantity, p.sessionId, p.replacementVariantId, p.requestedQuantity, ...owner),
      db.prepare(`INSERT INTO inventory_reservations
        (id, session_id, reservation_number, rma_id, variant_id, quantity, status, created_at)
        SELECT ?, ?, ?, ?, ?, ?, 'committed', ? WHERE changes() = 1 AND ${owned}`)
        .bind(effectId, p.sessionId, `DEMO-RES-${effectId}`, rmaId, p.replacementVariantId, p.requestedQuantity, now, ...owner),
    );
  } else {
    const table = p.resolutionType === "refund" ? "simulated_refunds" : "store_credits";
    const numberColumn = p.resolutionType === "refund" ? "refund_number" : "credit_number";
    statements.push(db.prepare(`INSERT INTO ${table} (id, session_id, ${numberColumn}, rma_id, amount_cents, currency, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${owned}`)
      .bind(effectId, p.sessionId, `DEMO-${effectId}`, rmaId, p.refundAmountCents ?? p.storeCreditCents, p.currency, now, ...owner));
  }
  const audit = (event: string, entityType: string, entityId: string) => db.prepare(`INSERT INTO audit_events
    (id, session_id, case_id, actor_type, actor_id, event_type, entity_type, entity_id, summary, metadata_json, created_at)
    SELECT ?, ?, ?, 'human', ?, ?, ?, ?, ?, ?, ? WHERE ${owned}`).bind(
    ids.next("audit"), p.sessionId, p.caseId, context.actor.id, event, entityType, entityId, `Demo ${event}`,
    JSON.stringify({ proposalId: p.id, rmaId, fromStatus: "pending", toStatus: "approved",
      resolutionType: p.resolutionType, requestedQuantity: p.requestedQuantity,
      amountCents: p.refundAmountCents ?? p.storeCreditCents, replacementSku: p.replacementSku }), now, ...owner,
  );
  if (p.returnRequired) {
    const labelId = ids.next("label");
    statements.push(db.prepare(`INSERT INTO return_labels (id, session_id, label_number, rma_id, tracking_number, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${owned}`)
      .bind(labelId, p.sessionId, `DEMO-LABEL-${labelId}`, rmaId, `DEMO-TRACK-${labelId}`, now, ...owner),
    audit("return_label.created", "return_label", labelId));
  }
  statements.push(
    audit(effectEvent, effectType, effectId), audit("rma.created", "rma", rmaId),
    audit("rma.completed", "rma", rmaId), audit("rma_proposal.approved", "rma_proposal", p.id),
    db.prepare(`INSERT INTO idempotency_records
      (session_id, command_kind, idempotency_key, request_hash, result_entity_type, result_entity_id, created_at)
      SELECT ?, 'proposal.approve', ?, ?, 'rma_proposal', ?, ? WHERE ${owned}`)
      .bind(p.sessionId, input.idempotencyKey, input.requestHash, p.id, now, ...owner),
    db.prepare(`UPDATE return_cases SET version = version + 1, updated_at = ?
      WHERE session_id = ? AND id = ? AND ${owned}`).bind(now, p.sessionId, p.caseId, ...owner),
    // Last: the trigger checks all artifacts before permitting the transition.
    db.prepare(`UPDATE rma_proposals SET status = 'approved', version = version + 1, reviewed_at = ?, reviewed_by = ?
      WHERE session_id = ? AND id = ? AND status = 'pending' AND version = ? AND ${owned}`)
      .bind(now, context.actor.id, p.sessionId, p.id, p.version, ...owner),
  );
  return statements;
}
