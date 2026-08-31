import type { ProposalStatus, ResolutionType } from "../../src/shared/contracts/common";
import type { EligibilityInput } from "../domain/policy/types";

export interface ProposalMessage {
  subject: string;
  bodyText: string;
  locale: "en-US" | "zh-CN";
}

export interface ProposalRecord {
  id: string;
  sessionId: string;
  caseId: string;
  eligibilityCheckId: string;
  orderItemId: string;
  resolutionType: ResolutionType;
  requestedQuantity: number;
  replacementVariantId: string | null;
  replacementSku: string | null;
  refundAmountCents: number | null;
  storeCreditCents: number | null;
  merchantCostCents: number;
  customerMessage: ProposalMessage;
  status: ProposalStatus;
  idempotencyKey: string;
  requestHash: string;
  returnRequired: boolean;
  createdBy: "agent" | "human";
  createdAt: string;
  expiresAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  rejectionReasonCode: string | null;
  invalidatedReasonCode: string | null;
  reviewNote: string | null;
  supersededByProposalId: string | null;
  version: number;
  currency: string;
  caseVersion: number;
}

interface ProposalRow {
  id: string;
  session_id: string;
  case_id: string;
  eligibility_check_id: string;
  order_item_id: string;
  resolution_type: ResolutionType;
  requested_quantity: number;
  replacement_variant_id: string | null;
  replacement_sku: string | null;
  refund_amount_cents: number | null;
  store_credit_cents: number | null;
  merchant_cost_cents: number;
  customer_message_json: string;
  status: ProposalStatus;
  idempotency_key: string;
  request_hash: string;
  return_required: number;
  created_by: "agent" | "human";
  created_at: string;
  expires_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason_code: string | null;
  invalidated_reason_code: string | null;
  review_note: string | null;
  superseded_by_proposal_id: string | null;
  version: number;
  currency: string;
  case_version: number;
}

export interface ProposalAuditInput {
  id: string;
  sessionId: string;
  caseId: string;
  actorType: "agent" | "human" | "system";
  actorId: string | null;
  eventType: string;
  proposalId: string;
  summary: string;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: string;
}

export interface ProposalOwnershipGuard {
  commandKind: "proposal.submit" | "proposal.replace";
  idempotencyKey: string;
  requestHash: string;
  resultEntityId: string;
}

export interface ProposalFactGuard {
  input: EligibilityInput;
  inputHash: string;
  policyRowVersion: number;
  eligibilityExpiresAt: string;
  allowedResolutionsJson: string;
  calculationSnapshotJson: string;
  returnRequired: boolean;
  returnShippingPayer: "merchant" | "customer";
}

const SELECT_COLUMNS = `rp.id, rp.session_id, rp.case_id, rp.eligibility_check_id,
  rp.order_item_id, rp.resolution_type, rp.requested_quantity,
  rp.replacement_variant_id, replacement.sku AS replacement_sku,
  rp.refund_amount_cents, rp.store_credit_cents,
  rp.merchant_cost_cents, rp.customer_message_json, rp.status,
  rp.idempotency_key, rp.request_hash, rp.return_required, rp.created_by,
  rp.created_at, rp.expires_at, rp.reviewed_at, rp.reviewed_by,
  rp.rejection_reason_code, rp.invalidated_reason_code, rp.review_note,
  rp.superseded_by_proposal_id, rp.version, o.currency, rc.version AS case_version`;

export class ProposalRepository {
  constructor(private readonly db: D1Database) {}

  async findById(sessionId: string, proposalId: string): Promise<ProposalRecord | null> {
    const row = await this.db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM rma_proposals rp
         JOIN return_cases rc ON rc.session_id = rp.session_id AND rc.id = rp.case_id
         JOIN orders o ON o.session_id = rc.session_id AND o.id = rc.order_id
         LEFT JOIN product_variants replacement
           ON replacement.session_id = rp.session_id AND replacement.id = rp.replacement_variant_id
        WHERE rp.session_id = ? AND rc.session_id = ? AND o.session_id = ? AND rp.id = ?`,
    ).bind(sessionId, sessionId, sessionId, proposalId).first<ProposalRow>();
    return row === null ? null : toProposal(row);
  }

  async findByIdempotencyKey(sessionId: string, key: string): Promise<ProposalRecord | null> {
    const row = await this.db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM rma_proposals rp
         JOIN return_cases rc ON rc.session_id = rp.session_id AND rc.id = rp.case_id
         JOIN orders o ON o.session_id = rc.session_id AND o.id = rc.order_id
         LEFT JOIN product_variants replacement
           ON replacement.session_id = rp.session_id AND replacement.id = rp.replacement_variant_id
        WHERE rp.session_id = ? AND rc.session_id = ? AND o.session_id = ?
          AND rp.idempotency_key = ?`,
    ).bind(sessionId, sessionId, sessionId, key).first<ProposalRow>();
    return row === null ? null : toProposal(row);
  }

  async findPendingByCase(sessionId: string, caseId: string): Promise<ProposalRecord | null> {
    const row = await this.db.prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM rma_proposals rp
         JOIN return_cases rc ON rc.session_id = rp.session_id AND rc.id = rp.case_id
         JOIN orders o ON o.session_id = rc.session_id AND o.id = rc.order_id
         LEFT JOIN product_variants replacement
           ON replacement.session_id = rp.session_id AND replacement.id = rp.replacement_variant_id
        WHERE rp.session_id = ? AND rc.session_id = ? AND o.session_id = ?
          AND rp.case_id = ? AND rp.status = 'pending'`,
    ).bind(sessionId, sessionId, sessionId, caseId).first<ProposalRow>();
    return row === null ? null : toProposal(row);
  }

  prepareSubmitClaim(
    record: ProposalRecord,
    seedVersion: number,
    now: string,
    factGuard: ProposalFactGuard,
    ownership: ProposalOwnershipGuard,
  ): D1PreparedStatement {
    const scope = proposalFactScope(record, factGuard);
    const sql = `INSERT INTO idempotency_records
      (session_id, command_kind, idempotency_key, request_hash,
       result_entity_type, result_entity_id, created_at)
     SELECT ?, ?, ?, ?, 'rma_proposal', ?, ?
       FROM eligibility_checks ec ` + scope.joins + `
      WHERE ` + scope.conditions + `
        AND ec.expires_at > ?
        AND ds.seed_version = ?
        AND NOT EXISTS (
          SELECT 1 FROM rma_proposals pending
           WHERE pending.session_id = ec.session_id AND pending.case_id = ec.case_id
             AND pending.status = 'pending'
        )`;
    return this.db.prepare(sql).bind(
      record.sessionId, ownership.commandKind, ownership.idempotencyKey,
      ownership.requestHash, ownership.resultEntityId, now, ...scope.values, now, seedVersion,
    );
  }

  prepareReplaceClaim(
    record: ProposalRecord,
    oldProposalId: string,
    expectedVersion: number,
    seedVersion: number,
    now: string,
    factGuard: ProposalFactGuard,
    ownership: ProposalOwnershipGuard,
  ): D1PreparedStatement {
    const scope = proposalFactScope(record, factGuard);
    const sql = `INSERT INTO idempotency_records
      (session_id, command_kind, idempotency_key, request_hash,
       result_entity_type, result_entity_id, created_at)
     SELECT ?, ?, ?, ?, 'rma_proposal', ?, ?
       FROM rma_proposals old
       JOIN eligibility_checks ec
         ON ec.session_id = old.session_id AND ec.case_id = old.case_id AND ec.id = ? `
      + scope.joins + `
      WHERE old.session_id = ? AND old.id = ? AND old.case_id = ?
        AND old.status = 'pending' AND old.version = ? AND old.expires_at > ?
        AND ` + scope.conditions + `
        AND ec.expires_at > ?
        AND ds.seed_version = ?
        AND NOT EXISTS (
          SELECT 1 FROM rma_proposals pending
           WHERE pending.session_id = old.session_id AND pending.case_id = old.case_id
             AND pending.status = 'pending' AND pending.id <> old.id
        )`;
    return this.db.prepare(sql).bind(
      record.sessionId, ownership.commandKind, ownership.idempotencyKey,
      ownership.requestHash, ownership.resultEntityId, now, record.eligibilityCheckId,
      record.sessionId, oldProposalId, record.caseId, expectedVersion, now,
      ...scope.values, now, seedVersion,
    );
  }

  prepareSubmitInsert(
    record: ProposalRecord,
    ownership: ProposalOwnershipGuard,
  ): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO rma_proposals
        (id, session_id, case_id, eligibility_check_id, order_item_id,
         resolution_type, requested_quantity, replacement_variant_id,
         refund_amount_cents, store_credit_cents, merchant_cost_cents,
         customer_message_json, status, idempotency_key, request_hash,
         return_required, created_by, created_at, expires_at, version)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 1
        WHERE EXISTS (
          SELECT 1 FROM idempotency_records
           WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
             AND request_hash = ? AND result_entity_id = ?
        )`,
    ).bind(
      record.id, record.sessionId, record.caseId, record.eligibilityCheckId,
      record.orderItemId, record.resolutionType, record.requestedQuantity,
      record.replacementVariantId, record.refundAmountCents, record.storeCreditCents,
      record.merchantCostCents, JSON.stringify(record.customerMessage),
      record.idempotencyKey, record.requestHash, record.returnRequired ? 1 : 0,
      record.createdBy, record.createdAt, record.expiresAt,
      record.sessionId, ownership.commandKind, ownership.idempotencyKey,
      ownership.requestHash, ownership.resultEntityId,
    );
  }

  prepareSupersede(
    sessionId: string,
    proposalId: string,
    expectedVersion: number,
    actorId: string,
    note: string | null,
    now: string,
    ownership: ProposalOwnershipGuard,
  ): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE rma_proposals
          SET status = 'superseded', reviewed_at = ?, reviewed_by = ?,
              review_note = ?, version = version + 1
        WHERE session_id = ? AND id = ? AND status = 'pending' AND version = ?
          AND EXISTS (
            SELECT 1 FROM idempotency_records
             WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
               AND request_hash = ? AND result_entity_id = ?
          )`,
    ).bind(
      now, actorId, note, sessionId, proposalId, expectedVersion,
      sessionId, ownership.commandKind, ownership.idempotencyKey,
      ownership.requestHash, ownership.resultEntityId,
    );
  }

  prepareReplacementInsert(
    record: ProposalRecord,
    oldProposalId: string,
    oldVersionAfterSupersede: number,
    ownership: ProposalOwnershipGuard,
  ): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO rma_proposals
        (id, session_id, case_id, eligibility_check_id, order_item_id,
         resolution_type, requested_quantity, replacement_variant_id,
         refund_amount_cents, store_credit_cents, merchant_cost_cents,
         customer_message_json, status, idempotency_key, request_hash,
         return_required, created_by, created_at, expires_at, version)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'human', ?, ?, 1
         FROM rma_proposals old
        WHERE old.session_id = ? AND old.id = ? AND old.case_id = ?
          AND old.status = 'superseded' AND old.version = ?
          AND old.superseded_by_proposal_id IS NULL
          AND EXISTS (
            SELECT 1 FROM idempotency_records
             WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
               AND request_hash = ? AND result_entity_id = ?
          )`,
    ).bind(
      record.id, record.sessionId, record.caseId, record.eligibilityCheckId,
      record.orderItemId, record.resolutionType, record.requestedQuantity,
      record.replacementVariantId, record.refundAmountCents, record.storeCreditCents,
      record.merchantCostCents, JSON.stringify(record.customerMessage),
      record.idempotencyKey, record.requestHash, record.returnRequired ? 1 : 0,
      record.createdAt, record.expiresAt, record.sessionId, oldProposalId,
      record.caseId, oldVersionAfterSupersede, record.sessionId,
      ownership.commandKind, ownership.idempotencyKey, ownership.requestHash,
      ownership.resultEntityId,
    );
  }

  prepareLinkSuperseded(
    sessionId: string,
    oldProposalId: string,
    newProposalId: string,
    oldVersionAfterSupersede: number,
    ownership: ProposalOwnershipGuard,
  ): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE rma_proposals
          SET superseded_by_proposal_id = ?
        WHERE session_id = ? AND id = ? AND status = 'superseded'
          AND version = ? AND superseded_by_proposal_id IS NULL
          AND EXISTS (
            SELECT 1 FROM rma_proposals replacement
             WHERE replacement.session_id = ? AND replacement.id = ?
               AND replacement.status = 'pending'
          )
          AND EXISTS (
            SELECT 1 FROM idempotency_records
             WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
               AND request_hash = ? AND result_entity_id = ?
          )`,
    ).bind(
      newProposalId, sessionId, oldProposalId, oldVersionAfterSupersede,
      sessionId, newProposalId, sessionId, ownership.commandKind,
      ownership.idempotencyKey, ownership.requestHash, ownership.resultEntityId,
    );
  }

  prepareExpire(sessionId: string, proposalId: string, now: string): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE rma_proposals
          SET status = 'expired', version = version + 1
        WHERE id = ?
          AND case_id IN (SELECT id FROM return_cases WHERE session_id = ?)
          AND status = 'pending' AND expires_at <= ?`,
    ).bind(proposalId, sessionId, now);
  }

  prepareReject(
    sessionId: string,
    proposalId: string,
    expectedVersion: number,
    actorId: string,
    reasonCode: string,
    note: string | null,
    now: string,
    commandKind: string,
    idempotencyKey: string,
    requestHash: string,
  ): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE rma_proposals
          SET status = 'rejected', reviewed_at = ?, reviewed_by = ?,
              rejection_reason_code = ?, review_note = ?, version = version + 1
        WHERE session_id = ? AND id = ? AND status = 'pending' AND version = ?
          AND EXISTS (
            SELECT 1 FROM idempotency_records
             WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
               AND request_hash = ? AND result_entity_id = ?
          )`,
    ).bind(
      now, actorId, reasonCode, note, sessionId, proposalId, expectedVersion,
      sessionId, commandKind, idempotencyKey, requestHash, proposalId,
    );
  }

  prepareAuditAfterChange(input: ProposalAuditInput): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO audit_events
        (id, session_id, case_id, actor_type, actor_id, event_type,
         entity_type, entity_id, summary, metadata_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, 'rma_proposal', ?, ?, ?, ?
        WHERE changes() = 1
          AND EXISTS (
            SELECT 1 FROM rma_proposals WHERE session_id = ? AND id = ? AND case_id = ?
          )`,
    ).bind(
      input.id, input.sessionId, input.caseId, input.actorType, input.actorId,
      input.eventType, input.proposalId, input.summary, JSON.stringify(input.metadata),
      input.createdAt, input.sessionId, input.proposalId, input.caseId,
    );
  }

  prepareAuditAfterAudit(input: ProposalAuditInput, prerequisiteAuditId: string): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO audit_events
        (id, session_id, case_id, actor_type, actor_id, event_type,
         entity_type, entity_id, summary, metadata_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, 'rma_proposal', ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM audit_events
           WHERE session_id = ? AND id = ? AND case_id = ?
        )`,
    ).bind(
      input.id, input.sessionId, input.caseId, input.actorType, input.actorId,
      input.eventType, input.proposalId, input.summary, JSON.stringify(input.metadata),
      input.createdAt, input.sessionId, prerequisiteAuditId, input.caseId,
    );
  }

  prepareAuditForClaim(
    input: ProposalAuditInput,
    ownership: ProposalOwnershipGuard,
  ): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO audit_events
        (id, session_id, case_id, actor_type, actor_id, event_type,
         entity_type, entity_id, summary, metadata_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, 'rma_proposal', ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM idempotency_records
           WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
             AND request_hash = ? AND result_entity_id = ?
        )
          AND EXISTS (
            SELECT 1 FROM rma_proposals
             WHERE session_id = ? AND id = ? AND case_id = ?
          )`,
    ).bind(
      input.id, input.sessionId, input.caseId, input.actorType, input.actorId,
      input.eventType, input.proposalId, input.summary, JSON.stringify(input.metadata),
      input.createdAt, input.sessionId, ownership.commandKind, ownership.idempotencyKey,
      ownership.requestHash, ownership.resultEntityId, input.sessionId,
      input.proposalId, input.caseId,
    );
  }

  prepareCaseVersionBumpForClaim(
    sessionId: string,
    caseId: string,
    auditId: string,
    now: string,
    ownership: ProposalOwnershipGuard,
  ): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE return_cases
          SET updated_at = ?, version = version + 1
        WHERE session_id = ? AND id = ?
          AND EXISTS (
            SELECT 1 FROM audit_events WHERE session_id = ? AND id = ? AND case_id = ?
          )
          AND EXISTS (
            SELECT 1 FROM idempotency_records
             WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
               AND request_hash = ? AND result_entity_id = ?
          )`,
    ).bind(
      now, sessionId, caseId, sessionId, auditId, caseId, sessionId,
      ownership.commandKind, ownership.idempotencyKey, ownership.requestHash,
      ownership.resultEntityId,
    );
  }

  prepareCaseVersionBump(sessionId: string, caseId: string, auditId: string, now: string): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE return_cases
          SET updated_at = ?, version = version + 1
        WHERE session_id = ? AND id = ?
          AND EXISTS (
            SELECT 1 FROM audit_events WHERE session_id = ? AND id = ? AND case_id = ?
          )`,
    ).bind(now, sessionId, caseId, sessionId, auditId, caseId);
  }
}

type SqlValue = ArrayBuffer | null | number | string;

function proposalFactScope(
  record: ProposalRecord,
  guard: ProposalFactGuard,
): { joins: string; conditions: string; values: readonly SqlValue[] } {
  const input = guard.input;
  const rawConditions = rawReturnConditions(input.allowedReturnConditions);
  const rawPlaceholders = rawConditions.map(() => "?").join(", ");
  const replacement = input.replacementVariant;
  return {
    joins: `JOIN return_cases rc
      ON rc.session_id = ec.session_id AND rc.id = ec.case_id
     JOIN order_items oi
      ON oi.session_id = ec.session_id AND oi.id = ec.order_item_id
     JOIN orders o
      ON o.session_id = rc.session_id AND o.id = rc.order_id AND o.id = oi.order_id
     JOIN product_variants original
      ON original.session_id = oi.session_id AND original.id = oi.variant_id
     JOIN products p
      ON p.session_id = original.session_id AND p.id = original.product_id
     JOIN policy_versions pv
      ON pv.session_id = oi.session_id AND pv.id = oi.policy_version_id
     JOIN demo_sessions ds ON ds.id = ec.session_id`,
    conditions: `ec.session_id = ? AND rc.session_id = ?
      AND ec.id = ? AND ec.case_id = ? AND ec.order_item_id = ?
      AND ec.policy_version_id = ?
      AND ec.status = 'eligible' AND ec.requested_quantity = ?
      AND ec.reason_code = ? AND ec.condition_code = ? AND ec.input_hash = ?
      AND ec.expires_at = ? AND ec.allowed_resolutions_json = ?
      AND ec.calculation_snapshot_json = ?
      AND ec.return_required = ? AND ec.return_shipping_payer = ?
      AND json_extract(ec.calculation_snapshot_json, '$.decision.proposalSubmissionAllowed') = 1
      AND rc.reason_code = ? AND rc.condition_code = ?
      AND o.id = ? AND o.ordered_at = ? AND o.fulfilled_at IS ? AND o.delivered_at IS ?
      AND o.currency = ? AND oi.unit_price_cents = ? AND oi.fulfilled_quantity = ?
      AND oi.previously_returned_quantity = ? AND oi.policy_version_id = ?
      AND p.category = ? AND p.final_sale = ?
      AND p.returnable_condition IN (` + rawPlaceholders + `)
      AND pv.version = ?
      AND (? <> 'exchange' OR EXISTS (
        SELECT 1 FROM product_variants exchange_variant
         WHERE exchange_variant.session_id = ec.session_id
           AND exchange_variant.product_id = p.id AND exchange_variant.id = ?
           AND exchange_variant.sku = ? AND exchange_variant.active = ?
           AND exchange_variant.inventory_quantity = ?
           AND exchange_variant.inventory_version = ? AND exchange_variant.price_cents = ?
      ))`,
    values: [
      record.sessionId, record.sessionId, record.eligibilityCheckId, record.caseId,
      record.orderItemId, input.policyVersionId, input.requestedQuantity,
      input.reasonCode, input.conditionCode, guard.inputHash, guard.eligibilityExpiresAt,
      guard.allowedResolutionsJson, guard.calculationSnapshotJson,
      guard.returnRequired ? 1 : 0, guard.returnShippingPayer,
      input.reasonCode, input.conditionCode,
      input.orderId, input.orderedAt, input.fulfilledAt, input.deliveredAt,
      input.currency, input.unitPriceCents, input.fulfilledQuantity,
      input.previouslyReturnedQuantity, input.policyVersionId, input.category,
      input.finalSale ? 1 : 0, ...rawConditions, guard.policyRowVersion,
      record.resolutionType, replacement?.id ?? null, replacement?.sku ?? null,
      replacement?.active === true ? 1 : replacement?.active === false ? 0 : null,
      replacement?.inventoryQuantity ?? null, replacement?.inventoryVersion ?? null,
      replacement?.unitPriceCents ?? null,
    ],
  };
}

function rawReturnConditions(conditions: EligibilityInput["allowedReturnConditions"]): readonly string[] {
  if (conditions.length === 1 && conditions[0] === "unopened") return ["unopened"];
  if (conditions.length === 2 && conditions[0] === "unopened" && conditions[1] === "opened_unused") {
    return ["unworn", "unused", "opened_unused"];
  }
  if (conditions.includes("used")) return ["used"];
  if (conditions.length === 1 && conditions[0] === "damaged") return ["damaged"];
  return ["__no_matching_return_condition__"];
}

function toProposal(row: ProposalRow): ProposalRecord {
  const message = parseMessage(row.customer_message_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    caseId: row.case_id,
    eligibilityCheckId: row.eligibility_check_id,
    orderItemId: row.order_item_id,
    resolutionType: row.resolution_type,
    requestedQuantity: row.requested_quantity,
    replacementVariantId: row.replacement_variant_id,
    replacementSku: row.replacement_sku,
    refundAmountCents: row.refund_amount_cents,
    storeCreditCents: row.store_credit_cents,
    merchantCostCents: row.merchant_cost_cents,
    customerMessage: message,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    returnRequired: row.return_required === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    rejectionReasonCode: row.rejection_reason_code,
    invalidatedReasonCode: row.invalidated_reason_code,
    reviewNote: row.review_note,
    supersededByProposalId: row.superseded_by_proposal_id,
    version: row.version,
    currency: row.currency,
    caseVersion: row.case_version,
  };
}

function parseMessage(value: string): ProposalMessage {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || typeof (parsed as Readonly<Record<string, unknown>>).subject !== "string"
    || typeof (parsed as Readonly<Record<string, unknown>>).bodyText !== "string"
    || ((parsed as Readonly<Record<string, unknown>>).locale !== "en-US"
      && (parsed as Readonly<Record<string, unknown>>).locale !== "zh-CN")
  ) throw new Error("Invalid proposal message");
  return parsed as ProposalMessage;
}
