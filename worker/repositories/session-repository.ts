import type { Clock, IdGenerator } from "../domain/primitives";
import { cryptoIds, systemClock } from "../domain/primitives";
import { buildSeedStatements } from "../demo/seed";

const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

interface DemoSessionRow {
  id: string;
  created_at: string;
  expires_at: string;
  seed_version: number;
  reset_count: number;
}

export interface DemoSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  seedVersion: number;
  resetCount: number;
}

function toDemoSession(row: DemoSessionRow): DemoSession {
  return {
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    seedVersion: row.seed_version,
    resetCount: row.reset_count,
  };
}

export class SessionRepository {
  constructor(
    private readonly db: D1Database,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = cryptoIds,
  ) {}

  async getExisting(id: string): Promise<DemoSession | null> {
    const row = await this.db.prepare(`SELECT id, created_at, expires_at, seed_version, reset_count
      FROM demo_sessions WHERE id = ? AND expires_at > ?`).bind(id, this.clock.now().toISOString()).first<DemoSessionRow>();
    return row === null ? null : toDemoSession(row);
  }

  async getOrCreate(cookieId: string | null): Promise<DemoSession> {
    const now = this.clock.now();
    const nowIso = now.toISOString();

    if (cookieId !== null) {
      const existing = await this.db
        .prepare(
          `SELECT id, created_at, expires_at, seed_version, reset_count
             FROM demo_sessions
            WHERE id = ? AND expires_at > ?`,
        )
        .bind(cookieId, nowIso)
        .first<DemoSessionRow>();

      if (existing !== null) {
        return toDemoSession(existing);
      }
    }

    const session: DemoSession = {
      id: this.ids.next("session"),
      createdAt: nowIso,
      expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString(),
      seedVersion: 1,
      resetCount: 0,
    };

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO demo_sessions
            (id, created_at, expires_at, seed_version, reset_count)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          session.id,
          session.createdAt,
          session.expiresAt,
          session.seedVersion,
          session.resetCount,
        ),
      ...buildSeedStatements(this.db, session.id, this.clock, this.ids),
    ]);

    return session;
  }
}
