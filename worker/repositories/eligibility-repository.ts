import type { ConditionCode, ReasonCode } from "../../src/shared/contracts/common";
import type {
  EligibilityDecision,
  EligibilityInput,
  ReturnShippingPayer,
} from "../domain/policy/types";
import type { EligibilityMutationGuard } from "./case-repository";

export interface EligibilityCalculationSnapshot {
  input: EligibilityInput;
  decision: EligibilityDecision;
  caseVersion: number;
}

export interface EligibilityCheckRecord {
  id: string;
  sessionId: string;
  caseId: string;
  orderItemId: string;
  policyVersionId: string;
  requestedQuantity: number;
  reasonCode: ReasonCode;
  conditionCode: ConditionCode;
  status: EligibilityDecision["status"];
  returnRequired: boolean;
  returnShippingPayer: ReturnShippingPayer;
  inputHash: string;
  snapshot: EligibilityCalculationSnapshot;
  createdAt: string;
  expiresAt: string;
}

interface EligibilityRow {
  id: string;
  session_id: string;
  case_id: string;
  order_item_id: string;
  policy_version_id: string;
  requested_quantity: number;
  reason_code: ReasonCode;
  condition_code: ConditionCode;
  status: EligibilityDecision["status"];
  return_required: number;
  return_shipping_payer: ReturnShippingPayer;
  calculation_snapshot_json: string;
  input_hash: string;
  created_at: string;
  expires_at: string;
}

export class EligibilityRepository {
  constructor(private readonly db: D1Database) {}

  async findById(sessionId: string, checkId: string): Promise<EligibilityCheckRecord | null> {
    const row = await this.db.prepare(
      `SELECT id, session_id, case_id, order_item_id, policy_version_id,
              requested_quantity, reason_code, condition_code, status,
              return_required, return_shipping_payer, calculation_snapshot_json,
              input_hash, created_at, expires_at
         FROM eligibility_checks
        WHERE session_id = ? AND id = ?`,
    ).bind(sessionId, checkId).first<EligibilityRow>();
    return row === null ? null : toCheck(row);
  }

  prepareInsert(record: EligibilityCheckRecord, guard: EligibilityMutationGuard): D1PreparedStatement {
    const decision = record.snapshot.decision;
    return this.db.prepare(
      `INSERT INTO eligibility_checks
        (id, session_id, case_id, order_item_id, policy_version_id,
         requested_quantity, reason_code, condition_code, status,
         allowed_resolutions_json, return_required, return_shipping_payer,
         matched_rules_json, calculation_snapshot_json, input_hash,
         parent_check_id, review_source, reviewed_by, reviewed_at,
         created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'engine',
              NULL, NULL, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM idempotency_records
           WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
             AND request_hash = ? AND result_entity_id = ?
        )`,
    ).bind(
      record.id, record.sessionId, record.caseId, record.orderItemId,
      record.policyVersionId, record.requestedQuantity, record.reasonCode,
      record.conditionCode, record.status, JSON.stringify(decision.allowedResolutions),
      record.returnRequired ? 1 : 0, record.returnShippingPayer,
      JSON.stringify(decision.matchedRules), JSON.stringify(record.snapshot),
      record.inputHash, record.createdAt, record.expiresAt,
      record.sessionId, guard.commandKind, guard.idempotencyKey,
      guard.requestHash, guard.resultEntityId,
    );
  }
}

function toCheck(row: EligibilityRow): EligibilityCheckRecord {
  const snapshot = parseSnapshot(row.calculation_snapshot_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    caseId: row.case_id,
    orderItemId: row.order_item_id,
    policyVersionId: row.policy_version_id,
    requestedQuantity: row.requested_quantity,
    reasonCode: row.reason_code,
    conditionCode: row.condition_code,
    status: row.status,
    returnRequired: row.return_required === 1,
    returnShippingPayer: row.return_shipping_payer,
    inputHash: row.input_hash,
    snapshot,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function parseSnapshot(value: string): EligibilityCalculationSnapshot {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid eligibility snapshot");
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  if (typeof record.caseVersion !== "number" || record.input === undefined || record.decision === undefined) {
    throw new Error("Invalid eligibility snapshot");
  }
  return parsed as EligibilityCalculationSnapshot;
}
