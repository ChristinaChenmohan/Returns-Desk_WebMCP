import type { ConditionCode, ReasonCode } from "../../src/shared/contracts/common";

export interface EligibilityMutationGuard {
  commandKind: string;
  idempotencyKey: string;
  requestHash: string;
  resultEntityId: string;
}

export interface ReturnCaseRecord {
  id: string;
  sessionId: string;
  orderId: string;
  customerId: string;
  status: string;
  source: "agent" | "manual";
  reasonCode: ReasonCode;
  conditionCode: ConditionCode;
  customerNote: string | null;
  openedAt: string;
  updatedAt: string;
  version: number;
}

interface CaseRow {
  id: string;
  session_id: string;
  order_id: string;
  customer_id: string;
  status: string;
  source: "agent" | "manual";
  reason_code: ReasonCode;
  condition_code: ConditionCode;
  customer_note: string | null;
  opened_at: string;
  updated_at: string;
  version: number;
}

export class CaseRepository {
  constructor(private readonly db: D1Database) {}

  async findById(sessionId: string, caseId: string): Promise<ReturnCaseRecord | null> {
    const row = await this.db.prepare(
      `SELECT id, session_id, order_id, customer_id, status, source,
              reason_code, condition_code, customer_note, opened_at,
              updated_at, version
         FROM return_cases
        WHERE session_id = ? AND id = ?`,
    ).bind(sessionId, caseId).first<CaseRow>();
    return row === null ? null : toCase(row);
  }

  prepareInsert(record: ReturnCaseRecord, guard: EligibilityMutationGuard): D1PreparedStatement {
    return this.db.prepare(
      `INSERT INTO return_cases
        (id, session_id, order_id, customer_id, status, source, reason_code,
         condition_code, customer_note, opened_at, updated_at, version)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM idempotency_records
           WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
             AND request_hash = ? AND result_entity_id = ?
        )`,
    ).bind(
      record.id, record.sessionId, record.orderId, record.customerId, record.status,
      record.source, record.reasonCode, record.conditionCode, record.customerNote,
      record.openedAt, record.updatedAt, record.version,
      record.sessionId, guard.commandKind, guard.idempotencyKey,
      guard.requestHash, guard.resultEntityId,
    );
  }

  prepareUpdateForCheck(
    record: ReturnCaseRecord,
    expectedVersion: number,
    guard: EligibilityMutationGuard,
  ): D1PreparedStatement {
    return this.db.prepare(
      `UPDATE return_cases
          SET reason_code = ?, condition_code = ?, customer_note = ?,
              updated_at = ?, version = version + 1
        WHERE session_id = ? AND id = ? AND order_id = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM idempotency_records
             WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?
               AND request_hash = ? AND result_entity_id = ?
          )`,
    ).bind(
      record.reasonCode, record.conditionCode, record.customerNote, record.updatedAt,
      record.sessionId, record.id, record.orderId, expectedVersion,
      record.sessionId, guard.commandKind, guard.idempotencyKey,
      guard.requestHash, guard.resultEntityId,
    );
  }
}

function toCase(row: CaseRow): ReturnCaseRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    orderId: row.order_id,
    customerId: row.customer_id,
    status: row.status,
    source: row.source,
    reasonCode: row.reason_code,
    conditionCode: row.condition_code,
    customerNote: row.customer_note,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
