import type { CheckEligibilityInput } from "../../src/shared/contracts/tools";
import { DomainError } from "./errors";
import { canonicalJson } from "./policy/hash-input";
import { evaluateEligibility } from "./policy/evaluate";
import type { EligibilityDecision, EligibilityInput } from "./policy/types";
import type { Clock, IdGenerator } from "./primitives";
import { cryptoIds, systemClock } from "./primitives";
import type { RequestContext } from "../http/context";
import { AuditRepository } from "../repositories/audit-repository";
import { CaseRepository, type EligibilityMutationGuard, type ReturnCaseRecord } from "../repositories/case-repository";
import { EligibilityRepository, type EligibilityCheckRecord } from "../repositories/eligibility-repository";
import type { IdempotencyRecord } from "../repositories/idempotency-repository";
import { IdempotencyRepository } from "../repositories/idempotency-repository";
import { OrderRepository } from "../repositories/order-repository";
import { PolicyRepository } from "../repositories/policy-repository";

const COMMAND_KIND = "eligibility.check";

export interface EligibilityResult extends EligibilityDecision {
  eligibilityCheckId: string;
  caseId: string;
  caseVersion: number;
  correlationId: string;
}

export class EligibilityService {
  private readonly orders: OrderRepository;
  private readonly policies: PolicyRepository;
  private readonly cases: CaseRepository;
  private readonly checks: EligibilityRepository;
  private readonly idempotency: IdempotencyRepository;
  private readonly audits: AuditRepository;

  constructor(
    private readonly db: D1Database,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = cryptoIds,
  ) {
    this.orders = new OrderRepository(db);
    this.policies = new PolicyRepository(db);
    this.cases = new CaseRepository(db);
    this.checks = new EligibilityRepository(db);
    this.idempotency = new IdempotencyRepository(db, clock);
    this.audits = new AuditRepository(db, clock, ids);
  }

  async check(command: CheckEligibilityInput, context: RequestContext): Promise<EligibilityResult> {
    const requestHash = await hashCommand(command);
    const existing = await this.idempotency.find(
      context.sessionId,
      COMMAND_KIND,
      command.idempotencyKey,
    );
    if (existing !== null) return this.replay(context, requestHash, existing);

    const facts = await this.orders.findEligibilityFacts(
      context.sessionId,
      command.orderId,
      command.orderItemId,
    );
    if (facts === null) {
      throw new DomainError("ORDER_ITEM_NOT_FOUND", 404, false, "select_an_order_item");
    }
    const replacement = command.replacementVariantId === undefined
      ? null
      : await this.orders.findReplacementVariant(
          context.sessionId,
          facts.productId,
          command.replacementVariantId,
        );
    if (command.replacementVariantId !== undefined && replacement === null) {
      throw new DomainError("REPLACEMENT_VARIANT_NOT_FOUND", 404, false, "select_a_replacement_variant");
    }
    const policy = await this.policies.findById(context.sessionId, facts.policyVersionId);
    if (policy === null) {
      throw new DomainError("POLICY_VERSION_NOT_FOUND", 404, false, "reload_order");
    }

    const now = this.clock.now().toISOString();
    const existingCase = command.caseId === undefined
      ? null
      : await this.cases.findById(context.sessionId, command.caseId);
    if (command.caseId !== undefined && existingCase === null) {
      throw new DomainError("CASE_NOT_FOUND", 404, false, "reload_case");
    }
    if (existingCase !== null && existingCase.orderId !== facts.orderId) {
      throw new DomainError("CASE_RELATION_MISMATCH", 409, false, "select_the_matching_case");
    }
    const caseId = existingCase?.id ?? this.ids.next("case");
    const caseVersion = (existingCase?.version ?? 0) + 1;
    const checkId = this.ids.next("eligibility_check");
    const input: EligibilityInput = {
      sessionId: context.sessionId,
      caseId,
      orderId: facts.orderId,
      orderItemId: facts.orderItemId,
      requestedQuantity: command.requestedQuantity,
      reasonCode: command.reasonCode,
      conditionCode: command.conditionCode,
      policyVersionId: facts.policyVersionId,
      orderedAt: facts.orderedAt,
      fulfilledAt: facts.fulfilledAt,
      deliveredAt: facts.deliveredAt,
      evaluatedAt: now,
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
      storeCreditConsent: command.storeCreditConsent ?? false,
      reviewSource: "engine",
    };
    const decision = evaluateEligibility(input, policy);
    const caseRecord = buildCaseRecord(
      existingCase,
      caseId,
      caseVersion,
      facts.customerId,
      input,
      command.customerNote ?? null,
      context,
      now,
    );
    const checkRecord: EligibilityCheckRecord = {
      id: checkId,
      sessionId: context.sessionId,
      caseId,
      orderItemId: facts.orderItemId,
      policyVersionId: policy.id,
      requestedQuantity: command.requestedQuantity,
      reasonCode: command.reasonCode,
      conditionCode: command.conditionCode,
      status: decision.status,
      returnRequired: decision.returnRequired,
      returnShippingPayer: decision.returnShippingPayer,
      inputHash: decision.inputHash,
      snapshot: { input, decision, caseVersion },
      createdAt: now,
      expiresAt: decision.expiresAt,
    };
    const guard: EligibilityMutationGuard = {
      commandKind: COMMAND_KIND,
      idempotencyKey: command.idempotencyKey,
      requestHash,
      resultEntityId: checkId,
    };
    const idempotencyInsert = this.prepareIdempotencyInsert(
      context,
      command,
      requestHash,
      checkId,
      existingCase,
      now,
    );
    const caseStatement = existingCase === null
      ? this.cases.prepareInsert(caseRecord, guard)
      : this.cases.prepareUpdateForCheck(caseRecord, existingCase.version, guard);
    const audit = this.audits.prepareAppend({
      sessionId: context.sessionId,
      caseId,
      actorType: context.actor.type,
      actorId: context.actor.id,
      eventType: "eligibility.checked",
      entityType: "eligibility_check",
      entityId: checkId,
      summary: "Checked return eligibility.",
      metadata: { status: decision.status, policyVersionId: policy.id, inputHash: decision.inputHash },
    }, this.ids.next("audit"), guard);

    try {
      const results = await this.db.batch([
        idempotencyInsert,
        caseStatement,
        this.checks.prepareInsert(checkRecord, guard),
        audit.statement,
      ]);
      if (results[0]?.meta.changes !== 1) {
        const concurrent = await this.idempotency.find(
          context.sessionId,
          COMMAND_KIND,
          command.idempotencyKey,
        );
        if (concurrent !== null) return this.replay(context, requestHash, concurrent);
        await this.throwGuardConflict(context, existingCase !== null);
      }
    } catch (error: unknown) {
      if (error instanceof DomainError) throw error;
      const concurrent = await this.idempotency.find(
        context.sessionId,
        COMMAND_KIND,
        command.idempotencyKey,
      );
      if (concurrent !== null) return this.replay(context, requestHash, concurrent);
      throw error;
    }
    return toResult(checkRecord, context.requestId);
  }

  private prepareIdempotencyInsert(
    context: RequestContext,
    command: CheckEligibilityInput,
    requestHash: string,
    checkId: string,
    existingCase: ReturnCaseRecord | null,
    createdAt: string,
  ): D1PreparedStatement {
    if (existingCase === null) {
      return this.db.prepare(
        `INSERT INTO idempotency_records
          (session_id, command_kind, idempotency_key, request_hash,
           result_entity_type, result_entity_id, created_at)
         SELECT ?, ?, ?, ?, 'eligibility_check', ?, ?
           FROM demo_sessions
          WHERE id = ? AND seed_version = ?`,
      ).bind(
        context.sessionId, COMMAND_KIND, command.idempotencyKey, requestHash,
        checkId, createdAt, context.sessionId, context.seedVersion,
      );
    }
    return this.db.prepare(
      `INSERT INTO idempotency_records
        (session_id, command_kind, idempotency_key, request_hash,
         result_entity_type, result_entity_id, created_at)
       SELECT ?, ?, ?, ?, 'eligibility_check', ?, ?
         FROM return_cases rc
         JOIN demo_sessions ds ON ds.id = rc.session_id
        WHERE rc.session_id = ? AND rc.id = ? AND rc.order_id = ?
          AND rc.version = ? AND ds.seed_version = ?`,
    ).bind(
      context.sessionId, COMMAND_KIND, command.idempotencyKey, requestHash,
      checkId, createdAt, context.sessionId, existingCase.id,
      existingCase.orderId, existingCase.version, context.seedVersion,
    );
  }

  private async replay(
    context: RequestContext,
    requestHash: string,
    existing: IdempotencyRecord,
  ): Promise<EligibilityResult> {
    if (existing.requestHash !== requestHash) {
      throw new DomainError("IDEMPOTENCY_KEY_REUSED", 409, false, "use_a_new_idempotency_key");
    }
    if (existing.resultEntityType !== "eligibility_check") {
      throw new DomainError("IDEMPOTENCY_RESULT_MISSING", 500, false);
    }
    const check = await this.checks.findById(context.sessionId, existing.resultEntityId);
    if (check === null) throw new DomainError("IDEMPOTENCY_RESULT_MISSING", 500, false);
    return toResult(check, context.requestId);
  }

  private async throwGuardConflict(context: RequestContext, existingCase: boolean): Promise<never> {
    const session = await this.db.prepare(
      "SELECT seed_version FROM demo_sessions WHERE id = ?",
    ).bind(context.sessionId).first<{ seed_version: number }>();
    if (session === null || session.seed_version !== context.seedVersion) {
      throw new DomainError("DEMO_SESSION_RESET", 409, false, "reload_session_bootstrap");
    }
    throw new DomainError(
      existingCase ? "ENTITY_VERSION_CONFLICT" : "ELIGIBILITY_WRITE_CONFLICT",
      409,
      false,
      existingCase ? "reload_case" : "retry_with_the_same_idempotency_key",
    );
  }
}

function buildCaseRecord(
  existing: ReturnCaseRecord | null,
  caseId: string,
  caseVersion: number,
  customerId: string,
  input: EligibilityInput,
  customerNote: string | null,
  context: RequestContext,
  now: string,
): ReturnCaseRecord {
  return {
    id: caseId,
    sessionId: context.sessionId,
    orderId: input.orderId,
    customerId,
    status: existing?.status ?? "open",
    source: existing?.source ?? (context.actor.type === "agent" ? "agent" : "manual"),
    reasonCode: input.reasonCode,
    conditionCode: input.conditionCode,
    customerNote,
    openedAt: existing?.openedAt ?? now,
    updatedAt: now,
    version: caseVersion,
  };
}

function toResult(check: EligibilityCheckRecord, correlationId: string): EligibilityResult {
  return {
    ...check.snapshot.decision,
    eligibilityCheckId: check.id,
    caseId: check.caseId,
    caseVersion: check.snapshot.caseVersion,
    correlationId,
  };
}

async function hashCommand(command: CheckEligibilityInput): Promise<string> {
  const normalized = canonicalJson({
    caseId: command.caseId ?? null,
    orderId: command.orderId,
    orderItemId: command.orderItemId,
    requestedQuantity: command.requestedQuantity,
    reasonCode: command.reasonCode,
    conditionCode: command.conditionCode,
    replacementVariantId: command.replacementVariantId ?? null,
    storeCreditConsent: command.storeCreditConsent ?? false,
    customerNote: command.customerNote ?? null,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}
