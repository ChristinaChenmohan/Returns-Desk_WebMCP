import type { Clock, IdGenerator } from "../domain/primitives";
import { cryptoIds, systemClock } from "../domain/primitives";

export type AuditActorType = "agent" | "human" | "system";

export interface AuditEventInput {
  sessionId: string;
  caseId: string | null;
  actorType: AuditActorType;
  actorId: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  summary: string;
  metadata: Readonly<Record<string, unknown>>;
}

export interface AuditEventRecord extends AuditEventInput {
  id: string;
  createdAt: string;
}

export interface AuditAppendGuard {
  commandKind: string;
  idempotencyKey: string;
  requestHash: string;
  resultEntityId: string;
}

interface AuditEventRow {
  id: string;
  session_id: string;
  case_id: string | null;
  actor_type: AuditActorType;
  actor_id: string | null;
  event_type: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  metadata_json: string;
  created_at: string;
}

export class AuditRepository {
  constructor(
    private readonly db: D1Database,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = cryptoIds,
  ) {}

  prepareAppend(
    input: AuditEventInput,
    id = this.ids.next("audit"),
    guard?: AuditAppendGuard,
  ): { event: AuditEventRecord; statement: D1PreparedStatement } {
    const event: AuditEventRecord = {
      ...input,
      id,
      createdAt: this.clock.now().toISOString(),
    };
    const columns = `id, session_id, case_id, actor_type, actor_id, event_type,
      entity_type, entity_id, summary, metadata_json, created_at`;
    const values = [
      event.id,
      event.sessionId,
      event.caseId,
      event.actorType,
      event.actorId,
      event.eventType,
      event.entityType,
      event.entityId,
      event.summary,
      JSON.stringify(event.metadata),
      event.createdAt,
    ];
    const statement = guard === undefined
      ? this.db
          .prepare(
            `INSERT INTO audit_events (${columns})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(...values)
      : this.db
          .prepare(
            `INSERT INTO audit_events (${columns})
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1
                  FROM idempotency_records
                 WHERE session_id = ? AND command_kind = ?
                   AND idempotency_key = ? AND request_hash = ?
                   AND result_entity_id = ?
              )`,
          )
          .bind(
            ...values,
            event.sessionId,
            guard.commandKind,
            guard.idempotencyKey,
            guard.requestHash,
            guard.resultEntityId,
          );

    return { event, statement };
  }

  async append(input: AuditEventInput): Promise<AuditEventRecord> {
    const prepared = this.prepareAppend(input);
    await this.db.batch([prepared.statement]);
    return prepared.event;
  }

  async findById(
    sessionId: string,
    eventId: string,
  ): Promise<AuditEventRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, session_id, case_id, actor_type, actor_id, event_type,
                entity_type, entity_id, summary, metadata_json, created_at
           FROM audit_events
          WHERE session_id = ? AND id = ?`,
      )
      .bind(sessionId, eventId)
      .first<AuditEventRow>();

    if (row === null) {
      return null;
    }

    return {
      id: row.id,
      sessionId: row.session_id,
      caseId: row.case_id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      eventType: row.event_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      summary: row.summary,
      metadata: parseMetadata(row.metadata_json),
      createdAt: row.created_at,
    };
  }
}

function parseMetadata(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Readonly<Record<string, unknown>>;
}
