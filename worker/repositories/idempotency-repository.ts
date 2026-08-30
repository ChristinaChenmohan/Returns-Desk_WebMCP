import type { Clock } from "../domain/primitives";
import { systemClock } from "../domain/primitives";

export interface IdempotencyRecord {
  sessionId: string;
  commandKind: string;
  idempotencyKey: string;
  requestHash: string;
  resultEntityType: string;
  resultEntityId: string;
  createdAt: string;
}

export interface NewIdempotencyRecord {
  sessionId: string;
  commandKind: string;
  idempotencyKey: string;
  requestHash: string;
  resultEntityType: string;
  resultEntityId: string;
}

interface IdempotencyRow {
  session_id: string;
  command_kind: string;
  idempotency_key: string;
  request_hash: string;
  result_entity_type: string;
  result_entity_id: string;
  created_at: string;
}

export class IdempotencyRepository {
  constructor(
    private readonly db: D1Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async find(
    sessionId: string,
    commandKind: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT session_id, command_kind, idempotency_key, request_hash,
                result_entity_type, result_entity_id, created_at
           FROM idempotency_records
          WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?`,
      )
      .bind(sessionId, commandKind, idempotencyKey)
      .first<IdempotencyRow>();

    return row === null ? null : toRecord(row);
  }

  prepareInsert(input: NewIdempotencyRecord): {
    record: IdempotencyRecord;
    statement: D1PreparedStatement;
  } {
    const record: IdempotencyRecord = {
      ...input,
      createdAt: this.clock.now().toISOString(),
    };
    const statement = this.db
      .prepare(
        `INSERT INTO idempotency_records
          (session_id, command_kind, idempotency_key, request_hash,
           result_entity_type, result_entity_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.sessionId,
        record.commandKind,
        record.idempotencyKey,
        record.requestHash,
        record.resultEntityType,
        record.resultEntityId,
        record.createdAt,
      );

    return { record, statement };
  }

  async insert(input: NewIdempotencyRecord): Promise<IdempotencyRecord> {
    const prepared = this.prepareInsert(input);
    await this.db.batch([prepared.statement]);
    return prepared.record;
  }
}

function toRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    sessionId: row.session_id,
    commandKind: row.command_kind,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    resultEntityType: row.result_entity_type,
    resultEntityId: row.result_entity_id,
    createdAt: row.created_at,
  };
}
