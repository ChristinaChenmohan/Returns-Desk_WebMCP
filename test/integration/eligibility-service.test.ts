/// <reference types="@cloudflare/vitest-plugin/types" />

import { describe, expect, it } from "vitest";

import { EligibilityService } from "../../worker/domain/eligibility-service";
import type { Clock, IdGenerator } from "../../worker/domain/primitives";
import type { RequestContext } from "../../worker/http/context";
import { EligibilityRepository } from "../../worker/repositories/eligibility-repository";
import { PolicyRepository } from "../../worker/repositories/policy-repository";
import { SessionRepository } from "../../worker/repositories/session-repository";
import { db } from "./setup";

const clock: Clock = { now: () => new Date("2026-08-29T07:00:00.000Z") };

class SequenceIds implements IdGenerator {
  private sequence = 0;
  constructor(private readonly namespace = "default") {}
  next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_elig_${this.namespace}_${this.sequence}`;
  }
}

let seedSequence = 0;

interface SeedRefs {
  orderId: string;
  orderItemId: string;
  replacementVariantId: string;
}

async function seed(): Promise<{
  service: EligibilityService;
  sessionId: string;
  refs: SeedRefs;
  context: RequestContext;
}> {
  seedSequence += 1;
  const ids = new SequenceIds(`seed_${seedSequence}`);
  const session = await new SessionRepository(db, clock, ids).getOrCreate(null);
  const order = await db.prepare(
    `SELECT o.id AS order_id, oi.id AS order_item_id
       FROM orders o
       JOIN order_items oi ON oi.session_id = o.session_id AND oi.order_id = o.id
      WHERE o.session_id = ? AND o.order_number = ?`,
  ).bind(session.id, "ORD-1001").first<{ order_id: string; order_item_id: string }>();
  const replacement = await db.prepare(
    "SELECT id FROM product_variants WHERE session_id = ? AND sku = ?",
  ).bind(session.id, "SHOE-BLUE-9").first<{ id: string }>();
  if (order === null || replacement === null) throw new Error("missing eligibility seed fixture");
  return {
    service: new EligibilityService(db, clock, ids),
    sessionId: session.id,
    refs: {
      orderId: order.order_id,
      orderItemId: order.order_item_id,
      replacementVariantId: replacement.id,
    },
    context: {
      sessionId: session.id,
      seedVersion: session.seedVersion,
      csrfToken: "test-csrf",
      actor: { type: "agent", id: "agent:test" },
      requestId: "req-eligibility",
    },
  };
}

function command(refs: SeedRefs, overrides: Record<string, unknown> = {}) {
  return {
    orderId: refs.orderId,
    orderItemId: refs.orderItemId,
    requestedQuantity: 1,
    reasonCode: "wrong_size" as const,
    conditionCode: "opened_unused" as const,
    replacementVariantId: refs.replacementVariantId,
    storeCreditConsent: false,
    customerNote: "Customer asked for a larger size.",
    idempotencyKey: "eligibility-key-1",
    ...overrides,
  };
}

describe("EligibilityService persistence", () => {
  it("creates a Case and immutable eligibility snapshot, then increments Case version", async () => {
    const fixture = await seed();
    const created = await fixture.service.check(command(fixture.refs), fixture.context);

    expect(created.status).toBe("eligible");
    expect(created.caseVersion).toBe(1);
    expect(created.proposalSubmissionAllowed).toBe(true);
    expect(created.allowedResolutions.map(option => option.type)).toEqual([
      "exchange", "refund", "store_credit",
    ]);

    const next = await fixture.service.check(command(fixture.refs, {
      caseId: created.caseId,
      conditionCode: "unopened",
      idempotencyKey: "eligibility-key-2",
    }), fixture.context);
    expect(next.caseId).toBe(created.caseId);
    expect(next.caseVersion).toBe(2);
    expect(next.eligibilityCheckId).not.toBe(created.eligibilityCheckId);

    const rows = await db.prepare(
      `SELECT version, reason_code, condition_code
         FROM return_cases
        WHERE session_id = ? AND id = ?`,
    ).bind(fixture.sessionId, created.caseId).first<{
      version: number;
      reason_code: string;
      condition_code: string;
    }>();
    expect(rows).toEqual({ version: 2, reason_code: "wrong_size", condition_code: "unopened" });
  });

  it("replays an identical idempotency key without another snapshot or Case version change", async () => {
    const fixture = await seed();
    const first = await fixture.service.check(command(fixture.refs), fixture.context);
    const replay = await fixture.service.check(command(fixture.refs), fixture.context);

    expect(replay).toEqual(first);
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM eligibility_checks WHERE session_id = ? AND case_id = ?",
    ).bind(fixture.sessionId, first.caseId).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await db.prepare(
      "SELECT version FROM return_cases WHERE session_id = ? AND id = ?",
    ).bind(fixture.sessionId, first.caseId).first<{ version: number }>()).toEqual({ version: 1 });
  });

  it("rejects the same idempotency key with a different normalized request hash", async () => {
    const fixture = await seed();
    await fixture.service.check(command(fixture.refs), fixture.context);

    await expect(fixture.service.check(command(fixture.refs, {
      requestedQuantity: 2,
    }), fixture.context)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      httpStatus: 409,
    });
  });

  it("persists needs_review without enabling proposal submission", async () => {
    const ids = new SequenceIds();
    const session = await new SessionRepository(db, clock, ids).getOrCreate(null);
    const old = await db.prepare(
      `SELECT o.id AS order_id, oi.id AS order_item_id, pv.product_id
         FROM orders o
         JOIN order_items oi ON oi.session_id = o.session_id AND oi.order_id = o.id
         JOIN product_variants pv ON pv.session_id = oi.session_id AND pv.id = oi.variant_id
        WHERE o.session_id = ? AND o.order_number = ?`,
    ).bind(session.id, "ORD-1002").first<{
      order_id: string;
      order_item_id: string;
      product_id: string;
    }>();
    if (old === null) throw new Error("missing final-sale fixture");
    await db.prepare(
      "UPDATE products SET returnable_condition = ? WHERE session_id = ? AND id = ?",
    ).bind("damaged", session.id, old.product_id).run();
    await db.prepare(
      `UPDATE orders
          SET ordered_at = ?, fulfilled_at = ?, delivered_at = ?
        WHERE session_id = ? AND id = ?`,
    ).bind(
      "2026-08-20T07:00:00.000Z",
      "2026-08-21T07:00:00.000Z",
      "2026-08-22T07:00:00.000Z",
      session.id,
      old.order_id,
    ).run();
    const service = new EligibilityService(db, clock, ids);
    const context: RequestContext = {
      sessionId: session.id,
      seedVersion: 1,
      csrfToken: "test-csrf",
      actor: { type: "agent", id: "agent:test" },
      requestId: "req-final-sale",
    };
    const result = await service.check({
      orderId: old.order_id,
      orderItemId: old.order_item_id,
      requestedQuantity: 1,
      reasonCode: "damaged",
      conditionCode: "damaged",
      idempotencyKey: "eligibility-final-sale-damage",
    }, context);

    expect(result.status).toBe("needs_review");
    expect(result.proposalSubmissionAllowed).toBe(false);
    expect(result.allowedResolutions).toEqual([]);
    expect(result.reasonCodes).toContain("MANUAL_REVIEW_REQUIRED");
  });

  it("keeps old calculation JSON unchanged when facts change and a new snapshot is created", async () => {
    const fixture = await seed();
    const first = await fixture.service.check(command(fixture.refs), fixture.context);
    const before = await db.prepare(
      "SELECT calculation_snapshot_json, input_hash FROM eligibility_checks WHERE session_id = ? AND id = ?",
    ).bind(fixture.sessionId, first.eligibilityCheckId).first<{
      calculation_snapshot_json: string;
      input_hash: string;
    }>();
    await db.prepare(
      `UPDATE product_variants
          SET inventory_quantity = 0, inventory_version = inventory_version + 1
        WHERE session_id = ? AND id = ?`,
    ).bind(fixture.sessionId, fixture.refs.replacementVariantId).run();

    const second = await fixture.service.check(command(fixture.refs, {
      caseId: first.caseId,
      idempotencyKey: "eligibility-after-inventory-change",
    }), fixture.context);
    const after = await db.prepare(
      "SELECT calculation_snapshot_json, input_hash FROM eligibility_checks WHERE session_id = ? AND id = ?",
    ).bind(fixture.sessionId, first.eligibilityCheckId).first<{
      calculation_snapshot_json: string;
      input_hash: string;
    }>();

    expect(after).toEqual(before);
    expect(second.inputHash).not.toBe(first.inputHash);
    expect(second.allowedResolutions.map(option => option.type)).toEqual(["refund", "store_credit"]);
  });

  it("scopes snapshot reads and Case relations to the current Session", async () => {
    const first = await seed();
    const result = await first.service.check(command(first.refs), first.context);
    const second = await seed();
    const repository = new EligibilityRepository(db);

    expect(await repository.findById(second.sessionId, result.eligibilityCheckId)).toBeNull();
    await expect(second.service.check(command(second.refs, {
      caseId: result.caseId,
      idempotencyKey: "cross-session-case",
    }), second.context)).rejects.toMatchObject({ code: "CASE_NOT_FOUND", httpStatus: 404 });
  });

  it.each([
    ["unknown condition field", "category_window", '{"category":"footwear","unknown":true}', '{"returnWindowDays":30}'],
    ["invalid reason enum", "return_required", '{"reasonCodes":["bogus"]}', '{"returnRequired":false}'],
    ["invalid eligibility status", "condition_requirement", '{"conditionCodes":["used"]}', '{"eligibility":"maybe","reasonCode":"BAD_STATUS"}'],
    ["inappropriate outcome", "category_window", '{"category":"footwear"}', '{"returnRequired":false}'],
    ["fractional negative money", "store_credit_bonus", '{}', '{"storeCreditBonusCents":-1.5}'],
    ["malformed JSON", "return_required", '{}', '{"returnRequired":'],
  ] as const)("rejects persisted policy rules with %s", async (
    _name,
    ruleType,
    conditionsJson,
    outcomeJson,
  ) => {
    const fixture = await seed();
    const policy = await db.prepare(
      `SELECT oi.policy_version_id, pr.id AS rule_id
         FROM order_items oi
         JOIN policy_rules pr
           ON pr.session_id = oi.session_id
          AND pr.policy_version_id = oi.policy_version_id
        WHERE oi.session_id = ? AND oi.id = ?
        ORDER BY pr.id LIMIT 1`,
    ).bind(fixture.sessionId, fixture.refs.orderItemId).first<{
      policy_version_id: string;
      rule_id: string;
    }>();
    if (policy === null) throw new Error("missing policy rule fixture");
    await db.prepare(
      `UPDATE policy_rules
          SET rule_type = ?, conditions_json = ?, outcome_json = ?
        WHERE session_id = ? AND id = ?`,
    ).bind(ruleType, conditionsJson, outcomeJson, fixture.sessionId, policy.rule_id).run();

    await expect(
      new PolicyRepository(db).findById(fixture.sessionId, policy.policy_version_id),
    ).rejects.toMatchObject({ code: "INVALID_POLICY_VERSION" });
  });

  it("surfaces malformed persisted policy as INVALID_POLICY_VERSION through the service", async () => {
    const fixture = await seed();
    await db.prepare(
      `UPDATE policy_rules
          SET outcome_json = ?
        WHERE session_id = ? AND policy_version_id = (
          SELECT policy_version_id FROM order_items
           WHERE session_id = ? AND id = ?
        ) AND rule_type = ?`,
    ).bind(
      '{"returnWindowDays":30,"returnRequired":false}',
      fixture.sessionId,
      fixture.sessionId,
      fixture.refs.orderItemId,
      "category_window",
    ).run();

    await expect(
      fixture.service.check(command(fixture.refs), fixture.context),
    ).rejects.toMatchObject({ code: "INVALID_POLICY_VERSION", httpStatus: 500 });
  });
});
