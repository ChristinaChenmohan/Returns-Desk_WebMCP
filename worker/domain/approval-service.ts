import { z } from "zod";
import type { EffectRef } from "../../src/shared/contracts/common";
import { buildApprovalBatch } from "../repositories/approval-batch";
import { ApprovalRepository, type ApprovalEffect, type CompletedRma } from "../repositories/approval-repository";
import { EligibilityRepository } from "../repositories/eligibility-repository";
import { IdempotencyRepository } from "../repositories/idempotency-repository";
import { ProposalRepository, type ProposalFactGuard, type ProposalRecord } from "../repositories/proposal-repository";
import { DomainError } from "./errors";
import { canonicalJson } from "./policy/hash-input";
import { cryptoIds, systemClock, type Clock, type IdGenerator } from "./primitives";
import { ProposalService, type HumanContext } from "./proposal-service";

const approveInput = z.object({
  proposalId: z.string().min(1).max(64), expectedVersion: z.number().int().positive(),
  confirmation: z.literal("approve_and_simulate_completion"),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
}).strict();

export type ApproveProposal = z.infer<typeof approveInput>;
export interface ApprovalResult {
  proposal: { id: string; status: "approved" | "invalidated"; version: number; invalidatedReasonCode: string | null };
  rma: CompletedRma | null;
  executedEffects: readonly ApprovalEffect[];
  effects: readonly EffectRef[];
}

/** Test seam for deterministic races and failures, never supplied by HTTP callers. */
export interface ApprovalBatchObserver {
  beforeBatch?(): Promise<void>;
  transformBatch?(statements: D1PreparedStatement[]): D1PreparedStatement[];
}

const businessCodes = new Set([
  "ELIGIBILITY_CHECK_STALE", "RETURN_QUANTITY_UNAVAILABLE", "EXCHANGE_INVENTORY_UNAVAILABLE",
  "RESOLUTION_NOT_ALLOWED", "PROPOSAL_AMOUNT_MISMATCH",
]);

export class ApprovalService {
  private readonly proposals: ProposalRepository;
  private readonly workflow: ProposalService;
  private readonly approvals: ApprovalRepository;
  private readonly idempotency: IdempotencyRepository;

  constructor(
    private readonly db: D1Database,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = cryptoIds,
    private readonly observer?: ApprovalBatchObserver,
  ) {
    this.proposals = new ProposalRepository(db);
    this.workflow = new ProposalService(db, clock, ids);
    this.approvals = new ApprovalRepository(db);
    this.idempotency = new IdempotencyRepository(db, clock);
  }

  async approve(command: ApproveProposal, context: HumanContext): Promise<ApprovalResult> {
    if (context.actor.type !== "human") throw new DomainError("CAPABILITY_DENIED", 403, false, "use_human_controls");
    const parsed = approveInput.safeParse(command);
    if (!parsed.success) throw new DomainError("INVALID_REQUEST", 400, false, "correct_input");
    const requestHash = await hashCommand(parsed.data);
    try {
      await this.assertSeed(context);
      const replay = await this.readReplay(command, context, requestHash);
      if (replay !== null) return replay;
      const p = await this.current(command.proposalId, context);
      if (p.status === "approved") return await this.replayApproved(command, context, requestHash, p);
      assertPending(p);
      if (p.version !== command.expectedVersion) {
        throw new DomainError("ENTITY_VERSION_CONFLICT", 409, false, "refresh_proposal", p.status);
      }
      let guard: ProposalFactGuard;
      try {
        guard = await this.validateFacts(p, context);
      } catch (error: unknown) {
        if (isBusinessError(error)) return await this.invalidate(p, context, command, requestHash, error.code);
        throw error;
      }
      await this.observer?.beforeBatch?.();
      // Re-read the injected clock after a pause, so expired work cannot be approved.
      const batch = buildApprovalBatch(this.db, this.ids, {
        proposal: p, guard, context, idempotencyKey: command.idempotencyKey,
        requestHash, now: this.clock.now().toISOString(),
      });
      try {
        const results = await this.db.batch(this.observer?.transformBatch?.(batch) ?? batch);
        if (results[0]?.meta.changes === 1) return await this.result(await this.requireProposal(p.id, context));
      } catch {
        // A concurrent winner may have committed, or a Reset may have removed the old seed.
        // Arbitrary database failures must never be turned into business invalidations.
        await this.assertSeed(context);
        const concurrentReplay = await this.readReplay(command, context, requestHash);
        if (concurrentReplay !== null) return concurrentReplay;
        const current = await this.requireProposal(p.id, context);
        if (current.status === "approved") return await this.replayApproved(command, context, requestHash, current);
        throw technicalFailure();
      }
      await this.assertSeed(context);
      const concurrentReplay = await this.readReplay(command, context, requestHash);
      if (concurrentReplay !== null) return concurrentReplay;
      const current = await this.current(p.id, context);
      if (current.status === "approved") return await this.replayApproved(command, context, requestHash, current);
      if (current.status === "invalidated") return await this.result(current);
      assertPending(current);
      if (current.version !== command.expectedVersion) {
        throw new DomainError("ENTITY_VERSION_CONFLICT", 409, false, "refresh_proposal", current.status);
      }
      try {
        await this.validateFacts(current, context);
      } catch (error: unknown) {
        if (isBusinessError(error)) return await this.invalidate(current, context, command, requestHash, error.code);
        throw error;
      }
      throw technicalFailure();
    } catch (error: unknown) {
      if (error instanceof DomainError) throw error;
      throw technicalFailure();
    }
  }

  private async validateFacts(p: ProposalRecord, context: HumanContext): Promise<ProposalFactGuard> {
    const check = await new EligibilityRepository(this.db).findById(context.sessionId, p.eligibilityCheckId);
    if (check === null || check.status !== "eligible" || check.caseId !== p.caseId
      || check.orderItemId !== p.orderItemId || check.requestedQuantity !== p.requestedQuantity
      || !check.snapshot.decision.proposalSubmissionAllowed
      || new Date(check.expiresAt).getTime() <= this.clock.now().getTime()) throw business("ELIGIBILITY_CHECK_STALE");
    const item = await this.db.prepare(`SELECT fulfilled_quantity - previously_returned_quantity AS remaining
      FROM order_items WHERE session_id = ? AND id = ?`).bind(context.sessionId, p.orderItemId).first<{ remaining: number }>();
    if (item === null || item.remaining < p.requestedQuantity) throw business("RETURN_QUANTITY_UNAVAILABLE");
    if (p.resolutionType === "exchange") {
      const variant = await this.db.prepare(`SELECT inventory_quantity AS quantity, active FROM product_variants
        WHERE session_id = ? AND id = ?`).bind(context.sessionId, p.replacementVariantId).first<{ quantity: number; active: number }>();
      if (variant === null || variant.active !== 1 || variant.quantity < p.requestedQuantity) {
        throw business("EXCHANGE_INVENTORY_UNAVAILABLE");
      }
    }
    const option = check.snapshot.decision.allowedResolutions.find(option => option.type === p.resolutionType
      && option.replacementVariantId === p.replacementVariantId);
    if (option === undefined || (p.resolutionType === "store_credit" && !check.snapshot.input.storeCreditConsent)) {
      throw business("RESOLUTION_NOT_ALLOWED");
    }
    if (option.amountCents !== (p.refundAmountCents ?? p.storeCreditCents)
      || option.merchantCostCents !== p.merchantCostCents || option.currency !== p.currency
      || option.returnRequired !== p.returnRequired) throw business("PROPOSAL_AMOUNT_MISMATCH");
    return this.workflow.assertSnapshotFresh(check, context, p.resolutionType);
  }

  private async invalidate(p: ProposalRecord, context: HumanContext, command: ApproveProposal, requestHash: string, reason: string): Promise<ApprovalResult> {
    const now = this.clock.now().toISOString();
    const auditId = this.ids.next("audit");
    await this.db.batch([
      this.db.prepare(`UPDATE rma_proposals SET status = 'invalidated', invalidated_reason_code = ?,
        reviewed_at = ?, reviewed_by = ?, version = version + 1
        WHERE session_id = ? AND id = ? AND status = 'pending' AND version = ?
          AND EXISTS (SELECT 1 FROM demo_sessions WHERE id = ? AND seed_version = ?)`)
        .bind(reason, now, context.actor.id, p.sessionId, p.id, p.version, p.sessionId, context.seedVersion),
      this.proposals.prepareAuditAfterChange({
        id: auditId, sessionId: p.sessionId, caseId: p.caseId, actorType: "system", actorId: "system:approval",
        eventType: "rma_proposal.invalidated", proposalId: p.id, summary: "Approval facts changed.",
        metadata: { proposalId: p.id, fromStatus: "pending", toStatus: "invalidated", reasonCode: reason }, createdAt: now,
      }),
      this.db.prepare(`INSERT INTO idempotency_records
        (session_id, command_kind, idempotency_key, request_hash, result_entity_type, result_entity_id, created_at)
        SELECT ?, 'proposal.approve', ?, ?, 'rma_proposal', ?, ?
        WHERE EXISTS (SELECT 1 FROM audit_events WHERE session_id = ? AND id = ?)`)
        .bind(p.sessionId, command.idempotencyKey, requestHash, p.id, now, p.sessionId, auditId),
      this.proposals.prepareCaseVersionBump(p.sessionId, p.caseId, auditId, now),
    ]);
    await this.assertSeed(context);
    const current = await this.requireProposal(p.id, context);
    if (current.status === "approved" || current.status === "invalidated") return this.result(current);
    assertPending(current);
    throw technicalFailure();
  }

  private async readReplay(command: ApproveProposal, context: HumanContext, hash: string): Promise<ApprovalResult | null> {
    const record = await this.idempotency.find(context.sessionId, "proposal.approve", command.idempotencyKey);
    if (record === null) return null;
    if (record.requestHash !== hash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", 409, false, "use_a_new_idempotency_key");
    return this.result(await this.requireProposal(record.resultEntityId, context));
  }

  private async replayApproved(
    command: ApproveProposal,
    context: HumanContext,
    hash: string,
    proposal: ProposalRecord,
  ): Promise<ApprovalResult> {
    await this.db.prepare(`INSERT OR IGNORE INTO idempotency_records
      (session_id, command_kind, idempotency_key, request_hash, result_entity_type, result_entity_id, created_at)
      SELECT ?, 'proposal.approve', ?, ?, 'rma_proposal', ?, ?
      WHERE EXISTS (SELECT 1 FROM rmas WHERE session_id = ? AND proposal_id = ?)`)
      .bind(context.sessionId, command.idempotencyKey, hash, proposal.id, this.clock.now().toISOString(),
        context.sessionId, proposal.id).run();
    const replay = await this.readReplay(command, context, hash);
    if (replay === null) throw technicalFailure();
    return replay;
  }

  private async current(id: string, context: HumanContext): Promise<ProposalRecord> {
    await this.workflow.read(id, context); // Persists lazy expiry and its audit exactly once.
    return this.requireProposal(id, context);
  }

  private async requireProposal(id: string, context: HumanContext): Promise<ProposalRecord> {
    const p = await this.proposals.findById(context.sessionId, id);
    if (p === null) throw new DomainError("PROPOSAL_NOT_FOUND", 404, false, "reload_case");
    return p;
  }

  private async result(p: ProposalRecord): Promise<ApprovalResult> {
    if (p.status !== "approved" && p.status !== "invalidated") throw technicalFailure();
    const completed = p.status === "approved" ? await this.approvals.findCompleted(p.sessionId, p.id) : null;
    if (p.status === "approved" && completed === null) throw technicalFailure();
    return {
      proposal: { id: p.id, status: p.status, version: p.version, invalidatedReasonCode: p.invalidatedReasonCode },
      rma: completed?.rma ?? null, executedEffects: completed?.effects ?? [],
      effects: [
        { entityType: "case", entityId: p.caseId, entityVersion: p.caseVersion, caseId: p.caseId },
        { entityType: "rma_proposal", entityId: p.id, entityVersion: p.version, caseId: p.caseId },
        ...(completed === null ? [] : [{ entityType: "rma", entityId: completed.rma.id, entityVersion: 1, caseId: p.caseId }]),
      ],
    };
  }

  private async assertSeed(context: HumanContext): Promise<void> {
    const session = await this.db.prepare("SELECT seed_version FROM demo_sessions WHERE id = ?")
      .bind(context.sessionId).first<{ seed_version: number }>();
    if (session === null || session.seed_version !== context.seedVersion) {
      throw new DomainError("DEMO_SESSION_RESET", 409, false, "reload_demo");
    }
  }
}

function assertPending(p: ProposalRecord): void {
  if (p.status === "expired") throw new DomainError("PROPOSAL_EXPIRED", 409, false, "rerun_eligibility", p.status);
  if (p.status !== "pending") throw new DomainError("PROPOSAL_NOT_APPROVABLE", 409, false, "rerun_eligibility", p.status);
}
function business(code: string): DomainError { return new DomainError(code, 409, false, "rerun_eligibility"); }
function isBusinessError(error: unknown): error is DomainError { return error instanceof DomainError && businessCodes.has(error.code); }
function technicalFailure(): DomainError { return new DomainError("APPROVAL_TRANSACTION_FAILED", 503, true, "retry_with_same_idempotency_key", "pending"); }
async function hashCommand(command: ApproveProposal): Promise<string> {
  const { idempotencyKey: _key, ...payload } = command;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(payload)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
