import type { ConditionCode, ReasonCode } from "../../src/shared/contracts/common";
import { CaseRepository } from "../repositories/case-repository";
import { IdempotencyRepository } from "../repositories/idempotency-repository";
import { DomainError } from "./errors";
import { commandHash } from "./command-hash";
import type { HumanContext } from "./proposal-service";
import type { Clock, IdGenerator } from "./primitives";
export interface CreateCase { orderId: string; reasonCode: ReasonCode; conditionCode: ConditionCode; customerNote?: string; idempotencyKey: string }
export class CaseCreateService {
  constructor(private readonly db: D1Database, private readonly clock: Clock, private readonly ids: IdGenerator) {}
  async create(command: CreateCase, context: HumanContext) {
    if (context.actor.type !== "human") throw new DomainError("FORBIDDEN", 403, false);
    const { idempotencyKey, ...payload } = command;
    const hash = await commandHash(payload);
    const cases = new CaseRepository(this.db);
    const replay = async () => {
      const record = await new IdempotencyRepository(this.db).find(context.sessionId, "case.create", idempotencyKey);
      if (record === null) return null;
      if (record.requestHash !== hash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", 409, false);
      return cases.findById(context.sessionId, record.resultEntityId);
    };
    const existing = await replay(); if (existing) return existing;
    const order = await this.db.prepare("SELECT customer_id FROM orders WHERE session_id = ? AND id = ?")
      .bind(context.sessionId, command.orderId).first<{ customer_id: string }>();
    if (!order) throw new DomainError("ORDER_NOT_FOUND", 404, false);
    const id = this.ids.next("case"), now = this.clock.now().toISOString();
    const record = { id, sessionId: context.sessionId, orderId: command.orderId, customerId: order.customer_id, status: "open", source: "manual" as const,
      reasonCode: command.reasonCode, conditionCode: command.conditionCode, customerNote: command.customerNote ?? null, openedAt: now, updatedAt: now, version: 1 };
    try {
      const results = await this.db.batch([
        this.db.prepare(`INSERT INTO idempotency_records (session_id, command_kind, idempotency_key, request_hash, result_entity_type, result_entity_id, created_at)
          SELECT ?, 'case.create', ?, ?, 'return_case', ?, ? FROM demo_sessions WHERE id = ? AND seed_version = ?`)
          .bind(context.sessionId, idempotencyKey, hash, id, now, context.sessionId, context.seedVersion),
        cases.prepareInsert(record, { commandKind: "case.create", idempotencyKey, requestHash: hash, resultEntityId: id }),
        this.db.prepare(`INSERT INTO audit_events (id, session_id, case_id, actor_type, actor_id, event_type, entity_type, entity_id, summary, metadata_json, created_at)
          SELECT ?, ?, ?, 'human', ?, 'case.created', 'return_case', ?, 'Created a demo return case.', '{}', ?
          WHERE EXISTS (SELECT 1 FROM return_cases WHERE session_id = ? AND id = ?)`)
          .bind(this.ids.next("audit"), context.sessionId, id, context.actor.id, id, now, context.sessionId, id),
      ]);
      if (results[0]?.meta.changes !== 1) throw new DomainError("DEMO_SESSION_RESET", 409, false, "reload_demo");
    } catch (error) { const winner = await replay(); if (winner) return winner; throw error; }
    return record;
  }
}
