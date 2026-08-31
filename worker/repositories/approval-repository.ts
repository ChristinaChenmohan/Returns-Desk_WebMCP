import type { ResolutionType } from "../../src/shared/contracts/common";
import type { HumanContext } from "../domain/proposal-service";
import { proposalFactScope, type ProposalFactGuard, type ProposalRecord } from "./proposal-repository";

export interface CompletedRma {
  id: string;
  rmaNumber: string;
  status: "completed";
  resolutionType: ResolutionType;
  createdAt: string;
  completedAt: string;
}

export interface ApprovalEffect {
  entityType: "simulated_refund" | "store_credit" | "inventory_reservation" | "return_label";
  entityId: string;
  number: string;
  amountCents: number | null;
  quantity: number | null;
  trackingNumber: string | null;
}

export class ApprovalRepository {
  constructor(private readonly db: D1Database) {}

  async findCompleted(sessionId: string, proposalId: string): Promise<{ rma: CompletedRma; effects: ApprovalEffect[] } | null> {
    const rma = await this.db.prepare(`SELECT id, rma_number AS rmaNumber, status,
      resolution_type AS resolutionType, created_at AS createdAt, completed_at AS completedAt
      FROM rmas WHERE session_id = ? AND proposal_id = ?`).bind(sessionId, proposalId).first<CompletedRma>();
    if (rma === null) return null;
    const effects = await this.db.prepare(`
      SELECT 'simulated_refund' AS entityType, id AS entityId, refund_number AS number,
        amount_cents AS amountCents, NULL AS quantity, NULL AS trackingNumber
        FROM simulated_refunds WHERE session_id = ? AND rma_id = ?
      UNION ALL SELECT 'store_credit', id, credit_number, amount_cents, NULL, NULL
        FROM store_credits WHERE session_id = ? AND rma_id = ?
      UNION ALL SELECT 'inventory_reservation', id, reservation_number, NULL, quantity, NULL
        FROM inventory_reservations WHERE session_id = ? AND rma_id = ?
      UNION ALL SELECT 'return_label', id, label_number, NULL, NULL, tracking_number
        FROM return_labels WHERE session_id = ? AND rma_id = ?
      ORDER BY entityType, entityId`).bind(
      sessionId, rma.id, sessionId, rma.id, sessionId, rma.id, sessionId, rma.id,
    ).all<ApprovalEffect>();
    return { rma, effects: effects.results };
  }

  prepareRma(p: ProposalRecord, guard: ProposalFactGuard, context: HumanContext, rmaId: string, number: string, now: string) {
    const scope = proposalFactScope(p, guard);
    return this.db.prepare(`INSERT INTO rmas
      (id, session_id, rma_number, case_id, proposal_id, resolution_type, status, created_at, completed_at)
      SELECT ?, ?, ?, ?, ?, ?, 'completed', ?, ? FROM eligibility_checks ec ${scope.joins}
      JOIN rma_proposals rp ON rp.session_id = ec.session_id AND rp.eligibility_check_id = ec.id
      WHERE ${scope.conditions} AND ds.seed_version = ? AND ec.expires_at > ?
        AND rp.id = ? AND rp.status = 'pending' AND rp.version = ? AND rp.expires_at > ?
        AND rp.case_id = ? AND rp.order_item_id = ? AND rp.resolution_type = ?
        AND rp.requested_quantity = ? AND rp.replacement_variant_id IS ?
        AND rp.refund_amount_cents IS ? AND rp.store_credit_cents IS ?
        AND rp.merchant_cost_cents = ? AND rp.return_required = ?`).bind(
      rmaId, p.sessionId, number, p.caseId, p.id, p.resolutionType, now, now,
      ...scope.values, context.seedVersion, now, p.id, p.version, now,
      p.caseId, p.orderItemId, p.resolutionType, p.requestedQuantity, p.replacementVariantId,
      p.refundAmountCents, p.storeCreditCents, p.merchantCostCents, p.returnRequired ? 1 : 0,
    );
  }
}
