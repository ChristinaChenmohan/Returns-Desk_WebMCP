import type { EligibilityStatus } from "../../src/shared/contracts/common";
import type { HumanContext } from "./proposal-service";
import { EligibilityRepository, type EligibilityCalculationSnapshot } from "../repositories/eligibility-repository";
import { IdempotencyRepository, type IdempotencyRecord } from "../repositories/idempotency-repository";
import { PolicyRepository } from "../repositories/policy-repository";
import { DomainError } from "./errors";
import { evaluateEligibility } from "./policy/evaluate";
import { canonicalJson, hashEligibilityInput } from "./policy/hash-input";
import type { EligibilityDecision, EligibilityInput, PolicyDefinition } from "./policy/types";
import type { Clock, IdGenerator } from "./primitives";
import { cryptoIds, systemClock } from "./primitives";

const COMMAND_KIND = "eligibility.review";

export type EligibilityReviewResult =
  | "eligible_exception_approved"
  | "ineligible_exception_denied"
  | "insufficient_evidence";

export interface ReviewEligibility {
  parentCheckId: string;
  expectedVersion: number;
  reviewResult: EligibilityReviewResult;
  reasonCode: string;
  note?: string;
  idempotencyKey: string;
}

export interface EligibilityReviewOutcome extends EligibilityDecision {
  eligibilityCheckId: string;
  caseId: string;
  caseVersion: number;
  parentCheckId: string;
  reviewSource: "human";
  reviewedBy: string;
  reviewedAt: string;
  reviewReasonCode: string;
  correlationId: string;
}

interface ReviewMetadataRow {
  parent_check_id: string;
  reviewed_by: string;
  reviewed_at: string;
  calculation_snapshot_json: string;
}

export class EligibilityReviewService {
  private readonly checks: EligibilityRepository;
  private readonly policies: PolicyRepository;
  private readonly idempotency: IdempotencyRepository;

  constructor(
    private readonly db: D1Database,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = cryptoIds,
  ) {
    this.checks = new EligibilityRepository(db);
    this.policies = new PolicyRepository(db);
    this.idempotency = new IdempotencyRepository(db, clock);
  }

  async review(command: ReviewEligibility, context: HumanContext): Promise<EligibilityReviewOutcome> {
    assertHuman(context);
    validateCommand(command);
    const requestHash = await hashReview(command);
    const replay = await this.idempotency.find(context.sessionId, COMMAND_KIND, command.idempotencyKey);
    if (replay !== null) return this.replay(context, requestHash, replay, command.reasonCode);

    const parent = await this.checks.findById(context.sessionId, command.parentCheckId);
    if (parent === null) {
      throw new DomainError("ELIGIBILITY_CHECK_NOT_FOUND", 404, false, "reload_case");
    }
    if (parent.status !== "needs_review") {
      throw new DomainError("ELIGIBILITY_REVIEW_NOT_REQUIRED", 409, false, "reload_case");
    }
    const now = this.clock.now().toISOString();
    if (this.clock.now().getTime() >= new Date(parent.expiresAt).getTime()) {
      throw new DomainError("ELIGIBILITY_CHECK_STALE", 409, false, "check_return_eligibility");
    }
    const existingChild = await this.findChild(context.sessionId, parent.id);
    if (existingChild !== null) {
      throw new DomainError("ELIGIBILITY_ALREADY_REVIEWED", 409, false, "reload_case");
    }
    const policy = await this.policies.findById(context.sessionId, parent.policyVersionId);
    if (policy === null) throw new DomainError("POLICY_VERSION_NOT_FOUND", 404, false, "reload_case");
    const reviewInput: EligibilityInput = {
      ...parent.snapshot.input,
      evaluatedAt: now,
      reviewSource: "human",
      humanReviewOutcome: command.reviewResult,
    };
    const decision = reviewedDecision(reviewInput, policy, command.reviewResult, command.reasonCode);
    const childId = this.ids.next("eligibility_check");
    const snapshot: EligibilityCalculationSnapshot & {
      humanReview: {
        result: EligibilityReviewResult;
        reasonCode: string;
        note: string | null;
        reviewedBy: string;
        reviewedAt: string;
      };
    } = {
      input: reviewInput,
      decision,
      caseVersion: command.expectedVersion + 1,
      humanReview: {
        result: command.reviewResult,
        reasonCode: command.reasonCode,
        note: command.note ?? null,
        reviewedBy: context.actor.id,
        reviewedAt: now,
      },
    };
    const idempotencyInsert = this.db.prepare(
      `INSERT INTO idempotency_records
        (session_id, command_kind, idempotency_key, request_hash,
         result_entity_type, result_entity_id, created_at)
       SELECT ?, ?, ?, ?, 'eligibility_check', ?, ?
         FROM eligibility_checks parent
         JOIN return_cases rc ON rc.session_id = parent.session_id AND rc.id = parent.case_id
         JOIN demo_sessions ds ON ds.id = parent.session_id
        WHERE parent.session_id = ? AND parent.id = ? AND parent.status = 'needs_review'
          AND parent.expires_at > ? AND rc.version = ? AND ds.seed_version = ?
          AND NOT EXISTS (
            SELECT 1 FROM eligibility_checks child
             WHERE child.session_id = parent.session_id AND child.parent_check_id = parent.id
          )`,
    ).bind(
      context.sessionId, COMMAND_KIND, command.idempotencyKey, requestHash,
      childId, now, context.sessionId, parent.id, now,
      command.expectedVersion, context.seedVersion,
    );
    const childInsert = this.db.prepare(
      `INSERT INTO eligibility_checks
        (id, session_id, case_id, order_item_id, policy_version_id,
         requested_quantity, reason_code, condition_code, status,
         allowed_resolutions_json, return_required, return_shipping_payer,
         matched_rules_json, calculation_snapshot_json, input_hash,
         parent_check_id, review_source, reviewed_by, reviewed_at,
         created_at, expires_at)
       SELECT ?, parent.session_id, parent.case_id, parent.order_item_id,
              parent.policy_version_id, parent.requested_quantity,
              parent.reason_code, parent.condition_code, ?, ?, ?, ?, ?, ?, ?,
              parent.id, 'human', ?, ?, ?, ?
         FROM eligibility_checks parent
        WHERE parent.session_id = ? AND parent.id = ?
          AND EXISTS (
            SELECT 1 FROM idempotency_records
             WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
               AND request_hash = ? AND result_entity_id = ?
          )`,
    ).bind(
      childId, decision.status, JSON.stringify(decision.allowedResolutions),
      decision.returnRequired ? 1 : 0, decision.returnShippingPayer,
      JSON.stringify(decision.matchedRules), JSON.stringify(snapshot), decision.inputHash,
      context.actor.id, now, now, decision.expiresAt,
      context.sessionId, parent.id, context.sessionId, COMMAND_KIND,
      command.idempotencyKey, requestHash, childId,
    );
    const caseUpdate = this.db.prepare(
      `UPDATE return_cases
          SET updated_at = ?, version = version + 1
        WHERE session_id = ? AND id = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM eligibility_checks
             WHERE session_id = ? AND id = ? AND parent_check_id = ?
          )
          AND EXISTS (
            SELECT 1 FROM idempotency_records
             WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
               AND request_hash = ? AND result_entity_id = ?
          )`,
    ).bind(
      now, context.sessionId, parent.caseId, command.expectedVersion,
      context.sessionId, childId, parent.id,
      context.sessionId, COMMAND_KIND, command.idempotencyKey, requestHash, childId,
    );
    const auditId = this.ids.next("audit");
    const auditInsert = this.db.prepare(
      `INSERT INTO audit_events
        (id, session_id, case_id, actor_type, actor_id, event_type,
         entity_type, entity_id, summary, metadata_json, created_at)
       SELECT ?, ?, ?, 'human', ?, 'eligibility.reviewed',
              'eligibility_check', ?, 'Reviewed return eligibility.', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM idempotency_records
           WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
             AND request_hash = ? AND result_entity_id = ?
        )
          AND EXISTS (
            SELECT 1 FROM eligibility_checks
             WHERE session_id = ? AND id = ? AND parent_check_id = ?
          )`,
    ).bind(
      auditId, context.sessionId, parent.caseId, context.actor.id, childId,
      JSON.stringify({
        parentCheckId: parent.id,
        reviewResult: command.reviewResult,
        reasonCode: command.reasonCode,
        status: decision.status,
      }),
      now,
      context.sessionId, COMMAND_KIND, command.idempotencyKey, requestHash, childId,
      context.sessionId, childId, parent.id,
    );
    const proposalInvalidate = this.db.prepare(
      `UPDATE rma_proposals
          SET status = 'invalidated', reviewed_at = ?,
              reviewed_by = 'system:eligibility-review',
              invalidated_reason_code = 'ELIGIBILITY_REVIEWED',
              version = version + 1
        WHERE session_id = ? AND case_id = ? AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM idempotency_records
             WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
               AND request_hash = ? AND result_entity_id = ?
          )`,
    ).bind(
      now, context.sessionId, parent.caseId,
      context.sessionId, COMMAND_KIND, command.idempotencyKey, requestHash, childId,
    );
    const proposalAuditId = this.ids.next("audit");
    const proposalAuditInsert = this.db.prepare(
      `INSERT INTO audit_events
        (id, session_id, case_id, actor_type, actor_id, event_type,
         entity_type, entity_id, summary, metadata_json, created_at)
       SELECT ?, rp.session_id, rp.case_id, 'system', 'system:eligibility-review',
              'rma_proposal.invalidated', 'rma_proposal', rp.id,
              'Invalidated an RMA proposal after eligibility review.',
              json_object(
                'fromStatus', 'pending',
                'toStatus', 'invalidated',
                'reasonCode', 'ELIGIBILITY_REVIEWED',
                'eligibilityCheckId', ?,
                'resolutionType', rp.resolution_type,
                'requestedQuantity', rp.requested_quantity,
                'amountCents', COALESCE(rp.refund_amount_cents, rp.store_credit_cents),
                'replacementVariantId', rp.replacement_variant_id,
                'replacementSku', replacement.sku
              ), ?
         FROM rma_proposals rp
         LEFT JOIN product_variants replacement
           ON replacement.session_id = rp.session_id
          AND replacement.id = rp.replacement_variant_id
        WHERE rp.session_id = ? AND rp.case_id = ?
          AND rp.status = 'invalidated'
          AND rp.reviewed_at = ?
          AND rp.reviewed_by = 'system:eligibility-review'
          AND rp.invalidated_reason_code = 'ELIGIBILITY_REVIEWED'
          AND changes() = 1
          AND EXISTS (
            SELECT 1 FROM idempotency_records
             WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
               AND request_hash = ? AND result_entity_id = ?
          )`,
    ).bind(
      proposalAuditId, childId, now, context.sessionId, parent.caseId, now,
      context.sessionId, COMMAND_KIND, command.idempotencyKey, requestHash, childId,
    );
    let results: D1Result<unknown>[];
    try {
      results = await this.db.batch([
        idempotencyInsert,
        childInsert,
        caseUpdate,
        auditInsert,
        proposalInvalidate,
        proposalAuditInsert,
      ]);
    } catch (error: unknown) {
      const concurrent = await this.idempotency.find(context.sessionId, COMMAND_KIND, command.idempotencyKey);
      if (concurrent !== null) return this.replay(context, requestHash, concurrent, command.reasonCode);
      throw error;
    }
    if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
      const concurrent = await this.idempotency.find(context.sessionId, COMMAND_KIND, command.idempotencyKey);
      if (concurrent !== null) return this.replay(context, requestHash, concurrent, command.reasonCode);
      await this.throwConflict(command, context);
    }
    return this.loadOutcome(context, childId, command.reasonCode);
  }

  private async replay(
    context: HumanContext,
    requestHash: string,
    existing: IdempotencyRecord,
    reasonCode: string,
  ): Promise<EligibilityReviewOutcome> {
    if (existing.requestHash !== requestHash) {
      throw new DomainError("IDEMPOTENCY_KEY_REUSED", 409, false, "use_a_new_idempotency_key");
    }
    if (existing.resultEntityType !== "eligibility_check") {
      throw new DomainError("IDEMPOTENCY_RESULT_MISSING", 500, false);
    }
    return this.loadOutcome(context, existing.resultEntityId, reasonCode);
  }

  private async loadOutcome(
    context: HumanContext,
    checkId: string,
    reasonCode: string,
  ): Promise<EligibilityReviewOutcome> {
    const check = await this.checks.findById(context.sessionId, checkId);
    const metadata = await this.db.prepare(
      `SELECT parent_check_id, reviewed_by, reviewed_at, calculation_snapshot_json
         FROM eligibility_checks
        WHERE session_id = ? AND id = ? AND review_source = 'human'`,
    ).bind(context.sessionId, checkId).first<ReviewMetadataRow>();
    if (check === null || metadata === null) {
      throw new DomainError("IDEMPOTENCY_RESULT_MISSING", 500, false);
    }
    return {
      ...check.snapshot.decision,
      eligibilityCheckId: check.id,
      caseId: check.caseId,
      caseVersion: check.snapshot.caseVersion,
      parentCheckId: metadata.parent_check_id,
      reviewSource: "human",
      reviewedBy: metadata.reviewed_by,
      reviewedAt: metadata.reviewed_at,
      reviewReasonCode: reasonCode,
      correlationId: context.requestId,
    };
  }

  private findChild(sessionId: string, parentId: string): Promise<{ id: string } | null> {
    return this.db.prepare(
      "SELECT id FROM eligibility_checks WHERE session_id = ? AND parent_check_id = ? ORDER BY created_at, id LIMIT 1",
    ).bind(sessionId, parentId).first<{ id: string }>();
  }

  private async throwConflict(command: ReviewEligibility, context: HumanContext): Promise<never> {
    const session = await this.db.prepare(
      "SELECT seed_version FROM demo_sessions WHERE id = ?",
    ).bind(context.sessionId).first<{ seed_version: number }>();
    if (session === null || session.seed_version !== context.seedVersion) {
      throw new DomainError("DEMO_SESSION_RESET", 409, false, "reload_demo");
    }
    const parent = await this.checks.findById(context.sessionId, command.parentCheckId);
    if (parent === null) throw new DomainError("ELIGIBILITY_CHECK_NOT_FOUND", 404, false, "reload_case");
    if (await this.findChild(context.sessionId, parent.id) !== null) {
      throw new DomainError("ELIGIBILITY_ALREADY_REVIEWED", 409, false, "reload_case");
    }
    const currentCase = await this.db.prepare(
      "SELECT version FROM return_cases WHERE session_id = ? AND id = ?",
    ).bind(context.sessionId, parent.caseId).first<{ version: number }>();
    if (currentCase === null) throw new DomainError("CASE_NOT_FOUND", 404, false, "reload_case");
    if (currentCase.version !== command.expectedVersion) {
      throw new DomainError("ENTITY_VERSION_CONFLICT", 409, false, "refresh_entity");
    }
    throw new DomainError("ELIGIBILITY_REVIEW_CONFLICT", 409, true, "retry_same_idempotency_key");
  }
}

function reviewedDecision(
  input: EligibilityInput,
  policy: PolicyDefinition,
  result: EligibilityReviewResult,
  reasonCode: string,
): EligibilityDecision {
  const inputHash = hashEligibilityInput(input, policy);
  if (result === "eligible_exception_approved") {
    const reviewPolicy: PolicyDefinition = {
      ...policy,
      rules: policy.rules.filter(rule => rule.outcome.eligibility !== "needs_review"),
    };
    const evaluationInput: EligibilityInput = {
      ...input,
      finalSale: false,
      ...(input.reasonCode === "changed_mind" && input.conditionCode === "damaged"
        ? { reasonCode: "damaged" as const }
        : {}),
    };
    const evaluated = evaluateEligibility(evaluationInput, reviewPolicy);
    if (evaluated.status !== "eligible") {
      throw new DomainError("ELIGIBILITY_REVIEW_NOT_APPROVABLE", 409, false, "correct_business_facts");
    }
    return {
      ...evaluated,
      inputHash,
      reasonCodes: [reasonCode, ...evaluated.reasonCodes],
      proposalSubmissionAllowed: true,
    };
  }
  const evaluated = evaluateEligibility(input, policy);
  const status: EligibilityStatus = result === "ineligible_exception_denied"
    ? "ineligible"
    : "needs_review";
  return {
    ...evaluated,
    status,
    allowedResolutions: [],
    reasonCodes: [reasonCode],
    inputHash,
    conflictEvidence: null,
    proposalSubmissionAllowed: false,
  };
}

function validateCommand(command: ReviewEligibility): void {
  if (
    command.parentCheckId.length < 1 || command.parentCheckId.length > 64
    || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1
    || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(command.reasonCode)
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(command.idempotencyKey)
    || (command.note !== undefined && command.note.length > 1000)
  ) throw new DomainError("INVALID_REQUEST", 400, false, "correct_input");
}

function assertHuman(context: HumanContext): void {
  if (context.actor.type !== "human") {
    throw new DomainError("CAPABILITY_DENIED", 403, false, "use_human_controls");
  }
}

async function hashReview(command: ReviewEligibility): Promise<string> {
  const normalized = canonicalJson({
    parentCheckId: command.parentCheckId,
    expectedVersion: command.expectedVersion,
    reviewResult: command.reviewResult,
    reasonCode: command.reasonCode,
    note: command.note ?? null,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
