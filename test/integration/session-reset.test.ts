/// <reference types="@cloudflare/vitest-plugin/types" />

import { describe, expect, it } from "vitest";
import type { Clock, IdGenerator } from "../../worker/domain/primitives";
import { ResetService } from "../../worker/demo/reset-service";
import { SessionRepository } from "../../worker/repositories/session-repository";
import { db } from "./setup";

const fixedClock: Clock = {
  now: () => new Date("2026-08-29T08:00:00.000Z"),
};

class SequenceIds implements IdGenerator {
  private sequence = 0;

  next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_test_${this.sequence}`;
  }
}

async function orderNumbers(sessionId: string): Promise<string[]> {
  const result = await db.prepare(
    "SELECT order_number FROM orders WHERE session_id = ? ORDER BY order_number",
  ).bind(sessionId).all<{ order_number: string }>();
  return result.results.map((row) => row.order_number);
}

describe("Demo Session lifecycle", () => {
  it("creates isolated Sessions with the same deterministic Demo scenarios", async () => {
    const repository = new SessionRepository(db, fixedClock, new SequenceIds());

    const first = await repository.getOrCreate(null);
    const second = await repository.getOrCreate(null);

    expect(first.id).not.toBe(second.id);
    expect(first.seedVersion).toBe(1);
    expect(second.seedVersion).toBe(1);
    expect(await orderNumbers(first.id)).toEqual(["ORD-1001", "ORD-1002"]);
    expect(await orderNumbers(second.id)).toEqual(["ORD-1001", "ORD-1002"]);

    const resumed = await repository.getOrCreate(first.id);
    expect(resumed).toEqual(first);
  });

  it("resets only the target Session and replays the same reset idempotently", async () => {
    const ids = new SequenceIds();
    const repository = new SessionRepository(db, fixedClock, ids);
    const service = new ResetService(db, fixedClock, ids);
    const first = await repository.getOrCreate(null);
    const second = await repository.getOrCreate(null);

    await db.batch([
      db.prepare(
        "INSERT INTO customers (id, session_id, name, email_normalized, locale) VALUES (?, ?, ?, ?, ?)",
      ).bind("dirty_a", first.id, "Dirty A", "dirty-a@example.test", "en-US"),
      db.prepare(
        "INSERT INTO customers (id, session_id, name, email_normalized, locale) VALUES (?, ?, ?, ?, ?)",
      ).bind("dirty_b", second.id, "Dirty B", "dirty-b@example.test", "en-US"),
      db.prepare(
        "UPDATE product_variants SET inventory_quantity = 0, inventory_version = inventory_version + 1 WHERE session_id = ? AND sku = ?",
      ).bind(first.id, "SHOE-BLUE-9"),
      db.prepare(
        "UPDATE product_variants SET inventory_quantity = 0, inventory_version = inventory_version + 1 WHERE session_id = ? AND sku = ?",
      ).bind(second.id, "SHOE-BLUE-9"),
    ]);

    const reset = await service.reset({
      sessionId: first.id,
      expectedSeedVersion: 1,
      idempotencyKey: "reset-key-1",
    });

    expect(reset).toEqual({ sessionId: first.id, seedVersion: 2, resetCount: 1 });
    expect(await orderNumbers(first.id)).toEqual(["ORD-1001", "ORD-1002"]);
    expect(await orderNumbers(second.id)).toEqual(["ORD-1001", "ORD-1002"]);

    const sessions = await db.prepare(
      "SELECT id, seed_version, reset_count FROM demo_sessions WHERE id IN (?, ?) ORDER BY id",
    ).bind(first.id, second.id).all<{
      id: string;
      seed_version: number;
      reset_count: number;
    }>();
    expect(sessions.results).toEqual(
      [
        { id: first.id, seed_version: 2, reset_count: 1 },
        { id: second.id, seed_version: 1, reset_count: 0 },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );

    const dirtyRows = await db.prepare(
      "SELECT id, session_id FROM customers WHERE session_id IN (?, ?) AND id IN ('dirty_a', 'dirty_b') ORDER BY id",
    ).bind(first.id, second.id).all<{ id: string; session_id: string }>();
    expect(dirtyRows.results).toEqual([{ id: "dirty_b", session_id: second.id }]);

    const inventories = await db.prepare(
      "SELECT session_id, inventory_quantity, inventory_version FROM product_variants WHERE session_id IN (?, ?) AND sku = ? ORDER BY session_id",
    ).bind(first.id, second.id, "SHOE-BLUE-9").all<{
      session_id: string;
      inventory_quantity: number;
      inventory_version: number;
    }>();
    expect(inventories.results).toEqual(
      [
        { session_id: first.id, inventory_quantity: 4, inventory_version: 1 },
        { session_id: second.id, inventory_quantity: 0, inventory_version: 2 },
      ].sort((left, right) => left.session_id.localeCompare(right.session_id)),
    );

    const replay = await service.reset({
      sessionId: first.id,
      expectedSeedVersion: 1,
      idempotencyKey: "reset-key-1",
    });
    expect(replay).toEqual(reset);

    await expect(
      service.reset({
        sessionId: first.id,
        expectedSeedVersion: 1,
        idempotencyKey: "reset-key-stale-after-reset",
      }),
    ).rejects.toMatchObject({ code: "DEMO_SESSION_RESET" });

    const audit = await db.prepare(
      "SELECT event_type FROM audit_events WHERE session_id = ? AND event_type = 'demo.reset'",
    ).bind(first.id).all<{ event_type: string }>();
    expect(audit.results).toEqual([{ event_type: "demo.reset" }]);
  });

  it("rejects a stale Reset without deleting Session data", async () => {
    const ids = new SequenceIds();
    const repository = new SessionRepository(db, fixedClock, ids);
    const service = new ResetService(db, fixedClock, ids);
    const session = await repository.getOrCreate(null);

    await db.prepare(
      "INSERT INTO customers (id, session_id, name, email_normalized, locale) VALUES (?, ?, ?, ?, ?)",
    ).bind("dirty_stale", session.id, "Dirty Stale", "dirty-stale@example.test", "en-US").run();

    await expect(
      service.reset({
        sessionId: session.id,
        expectedSeedVersion: 99,
        idempotencyKey: "reset-key-stale",
      }),
    ).rejects.toMatchObject({ code: "DEMO_SESSION_RESET" });

    const state = await db.prepare(
      "SELECT seed_version, reset_count FROM demo_sessions WHERE id = ?",
    ).bind(session.id).first<{ seed_version: number; reset_count: number }>();
    expect(state).toEqual({ seed_version: 1, reset_count: 0 });
    expect(
      await db.prepare(
        "SELECT id FROM customers WHERE session_id = ? AND id = ?",
      ).bind(session.id, "dirty_stale").first<{ id: string }>(),
    ).toEqual({ id: "dirty_stale" });
    expect(
      await db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ? AND event_type = 'demo.reset'",
      ).bind(session.id).first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("allows only one concurrent Reset for an expected seed version", async () => {
    const ids = new SequenceIds();
    const repository = new SessionRepository(db, fixedClock, ids);
    const service = new ResetService(db, fixedClock, ids);
    const session = await repository.getOrCreate(null);

    const results = await Promise.allSettled([
      service.reset({
        sessionId: session.id,
        expectedSeedVersion: 1,
        idempotencyKey: "reset-race-a",
      }),
      service.reset({
        sessionId: session.id,
        expectedSeedVersion: 1,
        idempotencyKey: "reset-race-b",
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(
      await db.prepare(
        "SELECT seed_version, reset_count FROM demo_sessions WHERE id = ?",
      ).bind(session.id).first<{ seed_version: number; reset_count: number }>(),
    ).toEqual({ seed_version: 2, reset_count: 1 });
    expect(
      await db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ? AND event_type = 'demo.reset'",
      ).bind(session.id).first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("replays two concurrent Resets with the same idempotency key", async () => {
    const ids = new SequenceIds();
    const repository = new SessionRepository(db, fixedClock, ids);
    const service = new ResetService(db, fixedClock, ids);
    const session = await repository.getOrCreate(null);

    const results = await Promise.allSettled([
      service.reset({
        sessionId: session.id,
        expectedSeedVersion: 1,
        idempotencyKey: "reset-race-same",
      }),
      service.reset({
        sessionId: session.id,
        expectedSeedVersion: 1,
        idempotencyKey: "reset-race-same",
      }),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(
      await db.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ? AND event_type = 'demo.reset'",
      ).bind(session.id).first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("does not misreport an unexpected D1 batch failure as a stale Session", async () => {
    const ids = new SequenceIds();
    const repository = new SessionRepository(db, fixedClock, ids);
    const session = await repository.getOrCreate(null);
    const failure = new Error("simulated D1 batch outage");
    const failingDb = new Proxy(db, {
      get(target, property): unknown {
        if (property === "batch") {
          return async (): Promise<never> => Promise.reject(failure);
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new ResetService(failingDb, fixedClock, ids);

    await expect(
      service.reset({
        sessionId: session.id,
        expectedSeedVersion: 1,
        idempotencyKey: "reset-db-failure",
      }),
    ).rejects.toBe(failure);
  });
});
