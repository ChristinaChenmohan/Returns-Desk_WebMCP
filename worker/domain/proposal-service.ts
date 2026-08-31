import type { ProposalStatus, ResolutionType } from "../../src/shared/contracts/common";
import { submitProposalInput, type SubmitProposalInput } from "../../src/shared/contracts/tools";
import type { RequestContext } from "../http/context";
import { EligibilityRepository, type EligibilityCheckRecord } from "../repositories/eligibility-repository";
import { IdempotencyRepository, type IdempotencyRecord } from "../repositories/idempotency-repository";
import { OrderRepository } from "../repositories/order-repository";
import { PolicyRepository } from "../repositories/policy-repository";
import {
  ProposalRepository,
  type ProposalAuditInput,
  type ProposalFactGuard,
  type ProposalMessage,
  type ProposalOwnershipGuard,
  type ProposalRecord,
} from "../repositories/proposal-repository";
import { DomainError } from "./errors";
import { canonicalJson, hashEligibilityInput } from "./policy/hash-input";
import type { AllowedResolution, EligibilityInput } from "./policy/types";
import type { Clock, IdGenerator } from "./primitives";
import { cryptoIds, systemClock } from "./primitives";
import { transitionProposal } from "./proposal-transitions";

const REJECT_COMMAND = "proposal.reject";
const SUBMIT_COMMAND = "proposal.submit";
const REPLACE_COMMAND = "proposal.replace";

export type CommandContext = RequestContext;
export type HumanContext = Omit<RequestContext, "actor"> & {
  actor: { type: "human"; id: string };
};
export type SubmitProposal = SubmitProposalInput;

export interface RejectProposal {
  proposalId: string;
  expectedVersion: number;
  reasonCode: string;
  note?: string;
  idempotencyKey: string;
}

export interface ReplaceProposal extends SubmitProposal {
  proposalId: string;
  expectedVersion: number;
  note?: string;
}

export interface ProposalResult {
  proposalId: string;
  caseId: string;
  eligibilityCheckId: string;
  status: ProposalStatus;
  resolutionType: ResolutionType;
  requestedQuantity: number;
  amountCents: number | null;
  merchantCostCents: number;
  currency: string;
  returnRequired: boolean;
  replacementVariantId: string | null;
  expiresAt: string;
  version: number;
  reviewedAt: string | null;
  reviewedBy: string | null;
  rejectionReasonCode: string | null;
  invalidatedReasonCode: string | null;
  supersededByProposalId: string | null;
  executedEffects: readonly [];
  nextAction: "human_review_required" | "none";
  caseSync: {
    caseId: string;
    caseVersion: number;
    affectedEntityIds: readonly string[];
    uiSync: "synchronized";
  };
}

interface PreparedProposal {
  check: EligibilityCheckRecord;
  option: AllowedResolution;
  message: ProposalMessage;
  command: SubmitProposal;
  factGuard: ProposalFactGuard;
}

export interface ProposalBatchObserver {
  beforeBatch(operation: "submit" | "replace"): Promise<void>;
}

export class ProposalService {
  private readonly proposals: ProposalRepository;
  private readonly checks: EligibilityRepository;
  private readonly idempotency: IdempotencyRepository;
  private readonly orders: OrderRepository;
  private readonly policies: PolicyRepository;

  constructor(
    private readonly db: D1Database,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = cryptoIds,
    private readonly batchObserver?: ProposalBatchObserver,
  ) {
    this.proposals = new ProposalRepository(db);
    this.checks = new EligibilityRepository(db);
    this.idempotency = new IdempotencyRepository(db, clock);
    this.orders = new OrderRepository(db);
    this.policies = new PolicyRepository(db);
  }

  async submit(command: SubmitProposal, context: CommandContext): Promise<ProposalResult> {
    const parsed = parseSubmitCommand(command);
    const requestHash = await hashProposalPayload(parsed);
    const replay = await this.proposals.findByIdempotencyKey(context.sessionId, parsed.idempotencyKey);
    if (replay !== null) return this.replayProposal(replay, requestHash);
    const prepared = await this.prepareSubmission(parsed, context);

    const now = this.clock.now().toISOString();
    const record = buildProposalRecord(
      this.ids.next("proposal"),
      prepared,
      requestHash,
      context,
      now,
    );
    const ownership = proposalOwnership(SUBMIT_COMMAND, record);
    const audit = this.audit(
      context,
      record,
      "rma_proposal.submitted",
      "Submitted an RMA proposal for human review.",
      proposalAuditMetadata(record, { fromStatus: null, toStatus: "pending" }),
    );
    let results: D1Result<unknown>[];
    try {
      await this.batchObserver?.beforeBatch("submit");
      results = await this.db.batch([
        this.proposals.prepareSubmitClaim(
          record, context.seedVersion, now, prepared.factGuard, ownership,
        ),
        this.proposals.prepareSubmitInsert(record, ownership),
        this.proposals.prepareAuditForClaim(audit, ownership),
        this.proposals.prepareCaseVersionBumpForClaim(
          context.sessionId, record.caseId, audit.id, now, ownership,
        ),
      ]);
    } catch (error: unknown) {
      const concurrent = await this.proposals.findByIdempotencyKey(context.sessionId, command.idempotencyKey);
      if (concurrent !== null) return this.replayProposal(concurrent, requestHash);
      const pending = await this.proposals.findPendingByCase(context.sessionId, command.caseId);
      if (pending !== null) throw pendingConflict(pending.id);
      throw error;
    }
    if (results[0]?.meta.changes !== 1) {
      return this.resolveSubmitConflict(command, context, requestHash);
    }
    return this.loadResult(context.sessionId, record.id);
  }

  async read(proposalId: string, context: CommandContext): Promise<ProposalResult> {
    const initial = await this.proposals.findById(context.sessionId, proposalId);
    if (initial === null) throw proposalNotFound();
    if (initial.status === "pending" && this.clock.now().getTime() >= new Date(initial.expiresAt).getTime()) {
      const now = this.clock.now().toISOString();
      const audit = this.audit(
        { ...context, actor: { type: "system", id: "system:proposal-expiry" } },
        initial,
        "rma_proposal.expired",
        "Expired an RMA proposal.",
        { fromStatus: "pending", toStatus: "expired" },
      );
      await this.db.batch([
        this.proposals.prepareExpire(context.sessionId, proposalId, now),
        this.proposals.prepareAuditAfterChange(audit),
        this.proposals.prepareCaseVersionBump(context.sessionId, initial.caseId, audit.id, now),
      ]);
    }
    return this.loadResult(context.sessionId, proposalId);
  }

  async reject(command: RejectProposal, context: HumanContext): Promise<ProposalResult> {
    assertHuman(context);
    validateHumanCommand(command.proposalId, command.expectedVersion, command.idempotencyKey, command.note);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(command.reasonCode)) {
      throw new DomainError("INVALID_REQUEST", 400, false, "correct_input");
    }
    const requestHash = await hashValue({
      proposalId: command.proposalId,
      expectedVersion: command.expectedVersion,
      reasonCode: command.reasonCode,
      note: command.note ?? null,
    });
    const idempotent = await this.idempotency.find(context.sessionId, REJECT_COMMAND, command.idempotencyKey);
    if (idempotent !== null) return this.replayCommand(context, requestHash, idempotent);

    const currentResult = await this.read(command.proposalId, context);
    transitionProposal(currentResult.status, "rejected");
    if (currentResult.version !== command.expectedVersion) throw versionConflict(currentResult.status);
    const now = this.clock.now().toISOString();
    const auditId = this.ids.next("audit");
    const idempotencyInsert = this.db.prepare(
      `INSERT INTO idempotency_records
        (session_id, command_kind, idempotency_key, request_hash,
         result_entity_type, result_entity_id, created_at)
       SELECT ?, ?, ?, ?, 'rma_proposal', ?, ?
         FROM rma_proposals rp
         JOIN demo_sessions ds ON ds.id = rp.session_id
        WHERE rp.session_id = ? AND rp.id = ? AND rp.status = 'pending'
          AND rp.version = ? AND ds.seed_version = ?`,
    ).bind(
      context.sessionId, REJECT_COMMAND, command.idempotencyKey, requestHash,
      command.proposalId, now, context.sessionId, command.proposalId,
      command.expectedVersion, context.seedVersion,
    );
    const audit: ProposalAuditInput = {
      id: auditId,
      sessionId: context.sessionId,
      caseId: currentResult.caseId,
      actorType: "human",
      actorId: context.actor.id,
      eventType: "rma_proposal.rejected",
      proposalId: command.proposalId,
      summary: "Rejected an RMA proposal.",
      metadata: { fromStatus: "pending", toStatus: "rejected", reasonCode: command.reasonCode },
      createdAt: now,
    };
    let results: D1Result<unknown>[];
    try {
      results = await this.db.batch([
        idempotencyInsert,
        this.proposals.prepareReject(
          context.sessionId, command.proposalId, command.expectedVersion,
          context.actor.id, command.reasonCode, command.note ?? null, now,
          REJECT_COMMAND, command.idempotencyKey, requestHash,
        ),
        this.proposals.prepareAuditAfterChange(audit),
        this.proposals.prepareCaseVersionBump(context.sessionId, currentResult.caseId, auditId, now),
      ]);
    } catch (error: unknown) {
      const concurrent = await this.idempotency.find(context.sessionId, REJECT_COMMAND, command.idempotencyKey);
      if (concurrent !== null) return this.replayCommand(context, requestHash, concurrent);
      throw error;
    }
    if (results[1]?.meta.changes !== 1) {
      const concurrent = await this.idempotency.find(context.sessionId, REJECT_COMMAND, command.idempotencyKey);
      if (concurrent !== null) return this.replayCommand(context, requestHash, concurrent);
      await this.throwProposalWriteConflict(command.proposalId, command.expectedVersion, context);
    }
    return this.loadResult(context.sessionId, command.proposalId);
  }

  async replace(command: ReplaceProposal, context: HumanContext): Promise<ProposalResult> {
    assertHuman(context);
    validateHumanCommand(command.proposalId, command.expectedVersion, command.idempotencyKey, command.note);
    const submission: SubmitProposal = {
      caseId: command.caseId,
      eligibilityCheckId: command.eligibilityCheckId,
      resolutionType: command.resolutionType,
      ...(command.replacementVariantId === undefined ? {} : { replacementVariantId: command.replacementVariantId }),
      customerMessage: command.customerMessage,
      idempotencyKey: command.idempotencyKey,
    };
    const parsed = parseSubmitCommand(submission);
    const requestHash = await hashValue({
      replacesProposalId: command.proposalId,
      expectedVersion: command.expectedVersion,
      proposal: canonicalProposalPayload(parsed),
    });
    const replay = await this.proposals.findByIdempotencyKey(context.sessionId, command.idempotencyKey);
    if (replay !== null) return this.replayProposal(replay, requestHash);
    const prepared = await this.prepareSubmission(parsed, context);

    const old = await this.proposals.findById(context.sessionId, command.proposalId);
    if (old === null) throw proposalNotFound();
    if (old.caseId !== command.caseId) {
      throw new DomainError("CASE_RELATION_MISMATCH", 409, false, "reload_case");
    }
    const current = await this.read(command.proposalId, context);
    transitionProposal(current.status, "superseded");
    if (current.version !== command.expectedVersion) throw versionConflict(current.status);

    const now = this.clock.now().toISOString();
    const replacement = buildProposalRecord(
      this.ids.next("proposal"), prepared, requestHash, context, now,
    );
    const ownership = proposalOwnership(REPLACE_COMMAND, replacement);
    const supersededAudit = this.audit(
      context, old, "rma_proposal.superseded", "Superseded an RMA proposal.",
      proposalAuditMetadata(old, {
        fromStatus: "pending", toStatus: "superseded", supersededByProposalId: replacement.id,
      }),
    );
    const submittedAudit = this.audit(
      context, replacement, "rma_proposal.submitted", "Submitted a replacement RMA proposal.",
      proposalAuditMetadata(replacement, {
        fromStatus: null, toStatus: "pending", supersedesProposalId: old.id,
      }),
    );
    let results: D1Result<unknown>[];
    try {
      await this.batchObserver?.beforeBatch("replace");
      results = await this.db.batch([
        this.proposals.prepareReplaceClaim(
          replacement, old.id, command.expectedVersion, context.seedVersion,
          now, prepared.factGuard, ownership,
        ),
        this.proposals.prepareSupersede(
          context.sessionId, old.id, command.expectedVersion, context.actor.id,
          command.note ?? null, now, ownership,
        ),
        this.proposals.prepareReplacementInsert(
          replacement, old.id, command.expectedVersion + 1, ownership,
        ),
        this.proposals.prepareLinkSuperseded(
          context.sessionId, old.id, replacement.id, command.expectedVersion + 1, ownership,
        ),
        this.proposals.prepareAuditForClaim(supersededAudit, ownership),
        this.proposals.prepareAuditForClaim(submittedAudit, ownership),
        this.proposals.prepareCaseVersionBumpForClaim(
          context.sessionId, old.caseId, submittedAudit.id, now, ownership,
        ),
      ]);
    } catch (error: unknown) {
      const concurrent = await this.proposals.findByIdempotencyKey(context.sessionId, command.idempotencyKey);
      if (concurrent !== null) return this.replayProposal(concurrent, requestHash);
      throw error;
    }
    if (results[0]?.meta.changes !== 1) {
      const concurrent = await this.proposals.findByIdempotencyKey(context.sessionId, command.idempotencyKey);
      if (concurrent !== null) return this.replayProposal(concurrent, requestHash);
      await this.prepareSubmission(parsed, context);
      await this.throwProposalWriteConflict(command.proposalId, command.expectedVersion, context);
    }
    return this.loadResult(context.sessionId, replacement.id);
  }

  private async prepareSubmission(command: SubmitProposal, context: CommandContext): Promise<PreparedProposal> {
    const parsed = submitProposalInput.safeParse(command);
    if (!parsed.success) throw new DomainError("INVALID_REQUEST", 400, false, "correct_input");
    const check = await this.checks.findById(context.sessionId, parsed.data.eligibilityCheckId);
    if (check === null) throw new DomainError("ELIGIBILITY_CHECK_NOT_FOUND", 404, false, "check_return_eligibility");
    if (check.caseId !== parsed.data.caseId) {
      throw new DomainError("CASE_RELATION_MISMATCH", 409, false, "reload_case");
    }
    if (this.clock.now().getTime() >= new Date(check.expiresAt).getTime()) {
      throw new DomainError("ELIGIBILITY_CHECK_STALE", 409, false, "check_return_eligibility");
    }
    if (check.status !== "eligible" || !check.snapshot.decision.proposalSubmissionAllowed) {
      throw new DomainError("ELIGIBILITY_NOT_ELIGIBLE", 422, false, "review_eligibility");
    }
    if (
      parsed.data.resolutionType === "store_credit"
      && !check.snapshot.input.storeCreditConsent
    ) throw new DomainError("CUSTOMER_CONSENT_REQUIRED", 422, false, "obtain_customer_consent");
    const option = findAllowedOption(check, parsed.data.resolutionType, parsed.data.replacementVariantId);
    if (option === null) {
      throw new DomainError("RESOLUTION_NOT_ALLOWED", 422, false, "compare_allowed_resolutions");
    }
    const factGuard = await this.assertSnapshotFresh(check, context, parsed.data.resolutionType);
    return { check, option, message: parsed.data.customerMessage, command: parsed.data, factGuard };
  }

  private async assertSnapshotFresh(
    check: EligibilityCheckRecord,
    context: CommandContext,
    resolutionType: ResolutionType,
  ): Promise<ProposalFactGuard> {
    const original = check.snapshot.input;
    const facts = await this.orders.findEligibilityFacts(
      context.sessionId, original.orderId, original.orderItemId,
    );
    const policy = await this.policies.findById(context.sessionId, original.policyVersionId);
    if (facts === null || policy === null) throw staleEligibility();
    const replacement = original.replacementVariant === null || resolutionType !== "exchange"
      ? original.replacementVariant
      : await this.orders.findReplacementVariant(
          context.sessionId, facts.productId, original.replacementVariant.id,
        );
    if (resolutionType === "exchange" && original.replacementVariant !== null && replacement === null) {
      throw staleEligibility();
    }
    const policyRow = await this.db.prepare(
      "SELECT version FROM policy_versions WHERE session_id = ? AND id = ?",
    ).bind(context.sessionId, original.policyVersionId).first<{ version: number }>();
    if (policyRow === null) throw staleEligibility();
    const currentCase = await this.db.prepare(
      "SELECT reason_code, condition_code FROM return_cases WHERE session_id = ? AND id = ?",
    ).bind(context.sessionId, check.caseId).first<{
      reason_code: string;
      condition_code: string;
    }>();
    if (
      currentCase === null
      || currentCase.reason_code !== original.reasonCode
      || currentCase.condition_code !== original.conditionCode
    ) throw staleEligibility();
    const currentInput: EligibilityInput = {
      ...original,
      orderId: facts.orderId,
      orderItemId: facts.orderItemId,
      policyVersionId: facts.policyVersionId,
      orderedAt: facts.orderedAt,
      fulfilledAt: facts.fulfilledAt,
      deliveredAt: facts.deliveredAt,
      category: facts.category,
      finalSale: facts.finalSale,
      allowedReturnConditions: facts.allowedReturnConditions,
      fulfilledQuantity: facts.fulfilledQuantity,
      previouslyReturnedQuantity: facts.previouslyReturnedQuantity,
      currency: facts.currency,
      unitPriceCents: facts.unitPriceCents,
      refundableAmountRemainingCents:
        facts.unitPriceCents * (facts.fulfilledQuantity - facts.previouslyReturnedQuantity),
      replacementVariant: replacement,
    };
    if (hashEligibilityInput(currentInput, policy) !== check.inputHash) throw staleEligibility();
    return {
      input: currentInput,
      inputHash: check.inputHash,
      policyRowVersion: policyRow.version,
      eligibilityExpiresAt: check.expiresAt,
      allowedResolutionsJson: JSON.stringify(check.snapshot.decision.allowedResolutions),
      calculationSnapshotJson: JSON.stringify(check.snapshot),
      returnRequired: check.returnRequired,
      returnShippingPayer: check.returnShippingPayer,
    };
  }

  private replayProposal(record: ProposalRecord, requestHash: string): ProposalResult {
    if (record.requestHash !== requestHash) {
      throw new DomainError("IDEMPOTENCY_KEY_REUSED", 409, false, "use_a_new_idempotency_key");
    }
    return toResult(record);
  }

  private async replayCommand(
    context: CommandContext,
    requestHash: string,
    record: IdempotencyRecord,
  ): Promise<ProposalResult> {
    if (record.requestHash !== requestHash) {
      throw new DomainError("IDEMPOTENCY_KEY_REUSED", 409, false, "use_a_new_idempotency_key");
    }
    if (record.resultEntityType !== "rma_proposal") {
      throw new DomainError("IDEMPOTENCY_RESULT_MISSING", 500, false);
    }
    return this.loadResult(context.sessionId, record.resultEntityId);
  }

  private async resolveSubmitConflict(
    command: SubmitProposal,
    context: CommandContext,
    requestHash: string,
  ): Promise<ProposalResult> {
    const replay = await this.proposals.findByIdempotencyKey(context.sessionId, command.idempotencyKey);
    if (replay !== null) return this.replayProposal(replay, requestHash);
    await this.prepareSubmission(command, context);
    const pending = await this.proposals.findPendingByCase(context.sessionId, command.caseId);
    if (pending !== null) throw pendingConflict(pending.id);
    await assertSeed(this.db, context);
    const check = await this.checks.findById(context.sessionId, command.eligibilityCheckId);
    if (check === null) throw new DomainError("ELIGIBILITY_CHECK_NOT_FOUND", 404, false, "check_return_eligibility");
    if (this.clock.now().getTime() >= new Date(check.expiresAt).getTime()) {
      throw new DomainError("ELIGIBILITY_CHECK_STALE", 409, false, "check_return_eligibility");
    }
    throw new DomainError("PROPOSAL_WRITE_CONFLICT", 409, true, "retry_with_same_idempotency_key");
  }

  private async throwProposalWriteConflict(
    proposalId: string,
    expectedVersion: number,
    context: CommandContext,
  ): Promise<never> {
    await assertSeed(this.db, context);
    const current = await this.proposals.findById(context.sessionId, proposalId);
    if (current === null) throw proposalNotFound();
    if (current.status !== "pending") {
      throw new DomainError("PROPOSAL_NOT_PENDING", 409, false, "refresh_proposal", current.status);
    }
    if (current.version !== expectedVersion) throw versionConflict(current.status);
    throw new DomainError("PROPOSAL_WRITE_CONFLICT", 409, true, "retry_with_same_idempotency_key");
  }

  private async loadResult(sessionId: string, proposalId: string): Promise<ProposalResult> {
    const record = await this.proposals.findById(sessionId, proposalId);
    if (record === null) throw proposalNotFound();
    return toResult(record);
  }

  private audit(
    context: CommandContext,
    record: Pick<ProposalRecord, "id" | "caseId">,
    eventType: string,
    summary: string,
    metadata: Readonly<Record<string, unknown>>,
  ): ProposalAuditInput {
    return {
      id: this.ids.next("audit"),
      sessionId: context.sessionId,
      caseId: record.caseId,
      actorType: context.actor.type,
      actorId: context.actor.id,
      eventType,
      proposalId: record.id,
      summary,
      metadata,
      createdAt: this.clock.now().toISOString(),
    };
  }
}

function buildProposalRecord(
  id: string,
  prepared: PreparedProposal,
  requestHash: string,
  context: CommandContext,
  now: string,
): ProposalRecord {
  const option = prepared.option;
  const amount = option.amountCents;
  if (
    (prepared.command.resolutionType === "refund" || prepared.command.resolutionType === "store_credit")
    && (amount === null || !Number.isSafeInteger(amount) || amount < 0)
  ) throw new DomainError("INVALID_ELIGIBILITY_SNAPSHOT", 500, false);
  return {
    id,
    sessionId: context.sessionId,
    caseId: prepared.check.caseId,
    eligibilityCheckId: prepared.check.id,
    orderItemId: prepared.check.orderItemId,
    resolutionType: prepared.command.resolutionType,
    requestedQuantity: prepared.check.requestedQuantity,
    replacementVariantId: prepared.command.resolutionType === "exchange"
      ? prepared.command.replacementVariantId ?? null
      : null,
    replacementSku: prepared.command.resolutionType === "exchange"
      ? option.replacementSku
      : null,
    refundAmountCents: prepared.command.resolutionType === "refund" ? amount : null,
    storeCreditCents: prepared.command.resolutionType === "store_credit" ? amount : null,
    merchantCostCents: option.merchantCostCents,
    customerMessage: prepared.message,
    status: "pending",
    idempotencyKey: prepared.command.idempotencyKey,
    requestHash,
    returnRequired: option.returnRequired,
    createdBy: context.actor.type === "human" ? "human" : "agent",
    createdAt: now,
    expiresAt: prepared.check.expiresAt,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReasonCode: null,
    invalidatedReasonCode: null,
    reviewNote: null,
    supersededByProposalId: null,
    version: 1,
    currency: option.currency,
    caseVersion: prepared.check.snapshot.caseVersion + 1,
  };
}

function proposalOwnership(
  commandKind: ProposalOwnershipGuard["commandKind"],
  record: ProposalRecord,
): ProposalOwnershipGuard {
  return {
    commandKind,
    idempotencyKey: record.idempotencyKey,
    requestHash: record.requestHash,
    resultEntityId: record.id,
  };
}

function proposalAuditMetadata(
  record: ProposalRecord,
  transition: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    ...transition,
    resolutionType: record.resolutionType,
    requestedQuantity: record.requestedQuantity,
    amountCents: record.refundAmountCents ?? record.storeCreditCents,
    replacementVariantId: record.replacementVariantId,
    replacementSku: record.replacementSku,
  };
}

function findAllowedOption(
  check: EligibilityCheckRecord,
  resolutionType: ResolutionType,
  replacementVariantId: string | undefined,
): AllowedResolution | null {
  if (resolutionType !== "exchange" && replacementVariantId !== undefined) return null;
  return check.snapshot.decision.allowedResolutions.find(option =>
    option.type === resolutionType
    && (resolutionType !== "exchange" || option.replacementVariantId === replacementVariantId),
  ) ?? null;
}

function parseSubmitCommand(command: SubmitProposal): SubmitProposal {
  const parsed = submitProposalInput.safeParse(command);
  if (!parsed.success) throw new DomainError("INVALID_REQUEST", 400, false, "correct_input");
  return parsed.data;
}

function canonicalProposalPayload(command: SubmitProposal): Readonly<Record<string, unknown>> {
  return {
    caseId: command.caseId,
    eligibilityCheckId: command.eligibilityCheckId,
    resolutionType: command.resolutionType,
    replacementVariantId: command.replacementVariantId ?? null,
    customerMessage: {
      subject: command.customerMessage.subject,
      bodyText: command.customerMessage.bodyText,
      locale: command.customerMessage.locale,
    },
  };
}

async function hashProposalPayload(command: SubmitProposal): Promise<string> {
  return hashValue(canonicalProposalPayload(command));
}

async function hashValue(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function toResult(record: ProposalRecord): ProposalResult {
  return {
    proposalId: record.id,
    caseId: record.caseId,
    eligibilityCheckId: record.eligibilityCheckId,
    status: record.status,
    resolutionType: record.resolutionType,
    requestedQuantity: record.requestedQuantity,
    amountCents: record.refundAmountCents ?? record.storeCreditCents,
    merchantCostCents: record.merchantCostCents,
    currency: record.currency,
    returnRequired: record.returnRequired,
    replacementVariantId: record.replacementVariantId,
    expiresAt: record.expiresAt,
    version: record.version,
    reviewedAt: record.reviewedAt,
    reviewedBy: record.reviewedBy,
    rejectionReasonCode: record.rejectionReasonCode,
    invalidatedReasonCode: record.invalidatedReasonCode,
    supersededByProposalId: record.supersededByProposalId,
    executedEffects: [],
    nextAction: record.status === "pending" ? "human_review_required" : "none",
    caseSync: {
      caseId: record.caseId,
      caseVersion: record.caseVersion,
      affectedEntityIds: [record.id],
      uiSync: "synchronized",
    },
  };
}

function validateHumanCommand(
  proposalId: string,
  expectedVersion: number,
  idempotencyKey: string,
  note: string | undefined,
): void {
  if (
    proposalId.length < 1 || proposalId.length > 64
    || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(idempotencyKey)
    || (note !== undefined && note.length > 1000)
  ) throw new DomainError("INVALID_REQUEST", 400, false, "correct_input");
}

function assertHuman(context: HumanContext): void {
  if (context.actor.type !== "human") {
    throw new DomainError("CAPABILITY_DENIED", 403, false, "use_human_controls");
  }
}

async function assertSeed(db: D1Database, context: CommandContext): Promise<void> {
  const session = await db.prepare(
    "SELECT seed_version FROM demo_sessions WHERE id = ?",
  ).bind(context.sessionId).first<{ seed_version: number }>();
  if (session === null || session.seed_version !== context.seedVersion) {
    throw new DomainError("DEMO_SESSION_RESET", 409, false, "reload_demo");
  }
}

function proposalNotFound(): DomainError {
  return new DomainError("PROPOSAL_NOT_FOUND", 404, false, "reload_case");
}

function pendingConflict(proposalId: string): DomainError {
  return new DomainError("PENDING_PROPOSAL_CONFLICT", 409, false, proposalId);
}

function staleEligibility(): DomainError {
  return new DomainError("ELIGIBILITY_CHECK_STALE", 409, false, "check_return_eligibility");
}

function versionConflict(status: ProposalStatus): DomainError {
  return new DomainError("ENTITY_VERSION_CONFLICT", 409, false, "refresh_proposal", status);
}
