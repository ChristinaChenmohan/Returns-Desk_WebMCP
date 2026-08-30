import { DomainError } from "../domain/errors";
import type { Clock, IdGenerator } from "../domain/primitives";
import { cryptoIds, systemClock } from "../domain/primitives";
import { AuditRepository } from "../repositories/audit-repository";
import type { IdempotencyRecord } from "../repositories/idempotency-repository";
import { IdempotencyRepository } from "../repositories/idempotency-repository";
import { buildSeedStatements } from "./seed";

const RESET_COMMAND = "demo.reset";

export interface ResetCommand {
  sessionId: string;
  expectedSeedVersion: number;
  idempotencyKey: string;
}

export interface ResetResult {
  sessionId: string;
  seedVersion: number;
  resetCount: number;
}

interface ResetAuditMetadata {
  previousSeedVersion: number;
  seedVersion: number;
  resetCount: number;
}

export class ResetService {
  private readonly audits: AuditRepository;
  private readonly idempotency: IdempotencyRepository;

  constructor(
    private readonly db: D1Database,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = cryptoIds,
  ) {
    this.audits = new AuditRepository(db, clock, ids);
    this.idempotency = new IdempotencyRepository(db, clock);
  }

  async reset(command: ResetCommand): Promise<ResetResult> {
    const requestHash = await hashResetRequest(command.expectedSeedVersion);
    const existing = await this.idempotency.find(
      command.sessionId,
      RESET_COMMAND,
      command.idempotencyKey,
    );
    if (existing !== null) {
      return this.replay(command.sessionId, requestHash, existing);
    }

    const auditId = this.ids.next("audit");
    const nextSeedVersion = command.expectedSeedVersion + 1;
    const currentResetCount = await this.readResetCount(
      command.sessionId,
      command.expectedSeedVersion,
    );
    if (currentResetCount === null) {
      throw resetConflict();
    }
    const result: ResetResult = {
      sessionId: command.sessionId,
      seedVersion: nextSeedVersion,
      resetCount: currentResetCount + 1,
    };
    const guard = {
      commandKind: RESET_COMMAND,
      idempotencyKey: command.idempotencyKey,
      requestHash,
      resultEntityId: auditId,
    };
    const guardedIdempotencyInsert = this.db
      .prepare(
        `INSERT INTO idempotency_records
          (session_id, command_kind, idempotency_key, request_hash,
           result_entity_type, result_entity_id, created_at)
         SELECT ?, ?, ?, ?, 'audit_event', ?, ?
          FROM demo_sessions
         WHERE id = ? AND seed_version = ?`,
      )
      .bind(
        command.sessionId,
        RESET_COMMAND,
        command.idempotencyKey,
        requestHash,
        auditId,
        this.clock.now().toISOString(),
        command.sessionId,
        command.expectedSeedVersion,
      );
    const preparedAudit = this.audits.prepareAppend(
      {
        sessionId: command.sessionId,
        caseId: null,
        actorType: "human",
        actorId: null,
        eventType: RESET_COMMAND,
        entityType: "demo_session",
        entityId: command.sessionId,
        summary: "Reset the current demo session.",
        metadata: {
          previousSeedVersion: command.expectedSeedVersion,
          seedVersion: result.seedVersion,
          resetCount: result.resetCount,
        },
      },
      auditId,
      guard,
    );

    const statements = [
      guardedIdempotencyInsert,
      ...this.buildDeleteStatements(command.sessionId, guard),
      this.db
        .prepare(
          `UPDATE demo_sessions
              SET seed_version = seed_version + 1,
                  reset_count = reset_count + 1
            WHERE id = ? AND seed_version = ?
              AND EXISTS (
                SELECT 1
                  FROM idempotency_records
                 WHERE session_id = ? AND command_kind = ?
                   AND idempotency_key = ? AND request_hash = ?
                   AND result_entity_id = ?
              )`,
        )
        .bind(
          command.sessionId,
          command.expectedSeedVersion,
          command.sessionId,
          RESET_COMMAND,
          command.idempotencyKey,
          requestHash,
          auditId,
        ),
      ...buildSeedStatements(this.db, command.sessionId, this.clock, this.ids, guard),
      preparedAudit.statement,
    ];

    try {
      const batchResults = await this.db.batch(statements);
      if (batchResults[0]?.meta.changes !== 1) {
        const concurrent = await this.idempotency.find(
          command.sessionId,
          RESET_COMMAND,
          command.idempotencyKey,
        );
        if (concurrent !== null) {
          return this.replay(command.sessionId, requestHash, concurrent);
        }
        throw resetConflict();
      }
    } catch (error: unknown) {
      if (error instanceof DomainError) {
        throw error;
      }
      const concurrent = await this.idempotency.find(
        command.sessionId,
        RESET_COMMAND,
        command.idempotencyKey,
      );
      if (concurrent !== null) {
        return this.replay(command.sessionId, requestHash, concurrent);
      }
      throw error;
    }

    return result;
  }

  private async readResetCount(
    sessionId: string,
    expectedSeedVersion: number,
  ): Promise<number | null> {
    const row = await this.db
      .prepare(
        `SELECT reset_count
           FROM demo_sessions
          WHERE id = ? AND seed_version = ?`,
      )
      .bind(sessionId, expectedSeedVersion)
      .first<{ reset_count: number }>();
    return row?.reset_count ?? null;
  }

  private buildDeleteStatements(
    sessionId: string,
    guard: {
      commandKind: string;
      idempotencyKey: string;
      requestHash: string;
      resultEntityId: string;
    },
  ): D1PreparedStatement[] {
    const tables = [
      "return_labels",
      "inventory_reservations",
      "simulated_refunds",
      "store_credits",
      "rma_items",
      "rmas",
      "rma_proposals",
      "eligibility_checks",
      "return_cases",
      "order_items",
      "orders",
      "policy_rules",
      "policy_versions",
      "product_variants",
      "products",
      "customers",
    ];

    return tables.map((table) =>
      this.db
        .prepare(
          `DELETE FROM ${table}
            WHERE session_id = ?
              AND EXISTS (
                SELECT 1
                  FROM idempotency_records
                 WHERE session_id = ? AND command_kind = ?
                   AND idempotency_key = ? AND request_hash = ?
                   AND result_entity_id = ?
              )`,
        )
        .bind(
          sessionId,
          sessionId,
          guard.commandKind,
          guard.idempotencyKey,
          guard.requestHash,
          guard.resultEntityId,
        ),
    );
  }

  private async replay(
    sessionId: string,
    requestHash: string,
    existing: IdempotencyRecord,
  ): Promise<ResetResult> {
    if (existing.requestHash !== requestHash) {
      throw new DomainError(
        "IDEMPOTENCY_KEY_REUSED",
        409,
        false,
        "use_a_new_idempotency_key",
      );
    }
    if (existing.resultEntityType !== "audit_event") {
      throw new DomainError("IDEMPOTENCY_RESULT_MISSING", 500, false);
    }

    const audit = await this.audits.findById(sessionId, existing.resultEntityId);
    const metadata = audit === null ? null : asResetMetadata(audit.metadata);
    if (metadata === null) {
      throw new DomainError("IDEMPOTENCY_RESULT_MISSING", 500, false);
    }
    return {
      sessionId,
      seedVersion: metadata.seedVersion,
      resetCount: metadata.resetCount,
    };
  }
}

function asResetMetadata(
  metadata: Readonly<Record<string, unknown>>,
): ResetAuditMetadata | null {
  const previousSeedVersion = metadata.previousSeedVersion;
  const seedVersion = metadata.seedVersion;
  const resetCount = metadata.resetCount;
  if (
    typeof previousSeedVersion !== "number" ||
    typeof seedVersion !== "number" ||
    typeof resetCount !== "number"
  ) {
    return null;
  }
  return { previousSeedVersion, seedVersion, resetCount };
}

async function hashResetRequest(expectedSeedVersion: number): Promise<string> {
  const input = new TextEncoder().encode(
    JSON.stringify({ expectedSeedVersion }),
  );
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function resetConflict(): DomainError {
  return new DomainError(
    "DEMO_SESSION_RESET",
    409,
    false,
    "reload_session_bootstrap",
  );
}
