/// <reference types="@cloudflare/vitest-plugin/types" />

import { describe, expect, it } from "vitest";

import {
  findPolicyConflicts,
  PolicyAdminService,
  type HumanContext,
  type UpdatePolicyDraft,
} from "../../worker/domain/policy-admin-service";
import type { PolicyRule } from "../../worker/domain/policy/types";
import { SessionRepository } from "../../worker/repositories/session-repository";
import { fixedClock } from "../fixtures/runtime";
import { db } from "./setup";

let fixtureSequence = 0;

async function fixture() {
  fixtureSequence += 1;
  let idSequence = 0;
  const ids = { next: (prefix: string) => `${prefix}_policy_${fixtureSequence}_${++idSequence}` };
  const session = await new SessionRepository(db, fixedClock, ids).getOrCreate(null);
  const draftId = `policy_draft_${fixtureSequence}`;
  await db.prepare(
    `INSERT INTO policy_versions
      (id, session_id, version_number, name, effective_from, effective_to, default_window_days,
       absolute_max_window_days, default_return_required, default_resolutions_json,
       return_shipping_payer, status, version)
     VALUES (?, ?, 2, 'Draft', '2026-09-01T00:00:00.000Z', NULL,
             30, 60, 1, '["refund"]', 'merchant', 'draft', 1)`,
  ).bind(draftId, session.id).run();
  const context: HumanContext = {
    sessionId: session.id, seedVersion: session.seedVersion, csrfToken: "csrf",
    actor: { type: "human", id: "human:test" }, requestId: "req-policy",
  };
  return { session, context, draftId, service: new PolicyAdminService(db, fixedClock, ids) };
}

function update(id: string, overrides: Partial<UpdatePolicyDraft> = {}): UpdatePolicyDraft {
  return {
    id, expectedVersion: 1, name: "Updated Draft",
    defaultWindowDays: 21, absoluteMaxWindowDays: 60, defaultReturnRequired: true,
    defaultResolutions: ["refund", "store_credit"], returnShippingPayer: "merchant",
    rules: [{
      id: "rule_draft_1", ruleType: "return_required", priority: 100,
      conditions: { reasonCodes: ["damaged"] }, outcome: { returnRequired: false },
      explanation: "Damage claims do not require a return.", active: true,
    }],
    ...overrides,
  };
}

describe("PolicyAdminService", () => {
  it("updates and validates only draft versions using the supported rule catalog", async () => {
    const { service, context, draftId } = await fixture();
    const updated = await service.updateDraft(update(draftId), context);
    expect(updated.version).toBe(2);
    expect((await service.validateDraft(draftId, context))).toEqual({ valid: true, conflicts: [] });

    await expect(service.updateDraft(update(draftId, { expectedVersion: 2, rules: [{
      ...update(draftId).rules[0]!, ruleType: "unknown_rule" as "return_required",
    }] }), context)).rejects.toMatchObject({ code: "INVALID_POLICY_DRAFT", httpStatus: 422 });
  });

  it("detects deterministic same-priority conflicts before activation", async () => {
    const { service, context, draftId } = await fixture();
    await expect(service.updateDraft(update(draftId, { rules: [
      update(draftId).rules[0]!,
      { ...update(draftId).rules[0]!, id: "rule_draft_2", outcome: { returnRequired: true } },
    ] }), context)).rejects.toMatchObject({ code: "POLICY_RULE_CONFLICT", httpStatus: 422 });
  });

  it.each([
    {
      left: ["refund", "store_credit"],
      right: ["store_credit", "refund"],
      reverseRules: false,
    },
    {
      left: ["store_credit", "refund"],
      right: ["refund", "store_credit"],
      reverseRules: true,
    },
  ] as const)("treats set-equivalent allowlists as equal regardless of rule order", async ({
    left, right, reverseRules,
  }) => {
    const { service, context, draftId } = await fixture();
    const rules = [
      {
        id: "rule_z", ruleType: "resolution_allowlist" as const, priority: 100,
        conditions: { reasonCodes: ["damaged"] },
        outcome: { allowedResolutions: [...left] },
        explanation: "First equivalent allowlist.", active: true,
      },
      {
        id: "rule_a", ruleType: "resolution_allowlist" as const, priority: 100,
        conditions: { reasonCodes: ["damaged"] },
        outcome: { allowedResolutions: [...right] },
        explanation: "Second equivalent allowlist.", active: true,
      },
    ];
    const orderedRules = reverseRules ? [...rules].reverse() : rules;

    await expect(service.updateDraft(update(draftId, { rules: orderedRules }), context))
      .resolves.toMatchObject({ id: draftId, version: 2 });
    await expect(service.validateDraft(draftId, context))
      .resolves.toEqual({ valid: true, conflicts: [] });
  });

  it("sorts equal-field conflicts by rule IDs regardless of rule order", () => {
    const rules: readonly PolicyRule[] = [
      {
        id: "rule_z", ruleType: "resolution_allowlist", priority: 100,
        conditions: { reasonCodes: ["damaged"] }, outcome: { allowedResolutions: ["refund"] },
        explanation: "Refund only.", active: true,
      },
      {
        id: "rule_a", ruleType: "resolution_allowlist", priority: 100,
        conditions: { reasonCodes: ["damaged"] }, outcome: { allowedResolutions: ["exchange"] },
        explanation: "Exchange only.", active: true,
      },
      {
        id: "rule_m", ruleType: "resolution_allowlist", priority: 100,
        conditions: { reasonCodes: ["damaged"] }, outcome: { allowedResolutions: ["store_credit"] },
        explanation: "Store credit only.", active: true,
      },
    ];
    const expectedRuleIds = [
      ["rule_a", "rule_m"],
      ["rule_a", "rule_z"],
      ["rule_m", "rule_z"],
    ];

    expect(findPolicyConflicts(rules).map(conflict => conflict.ruleIds)).toEqual(expectedRuleIds);
    expect(findPolicyConflicts([...rules].reverse()).map(conflict => conflict.ruleIds))
      .toEqual(expectedRuleIds);
  });

  it.each([
    ["blank name", "UPDATE policy_versions SET name = '   ' WHERE id = ? AND session_id = ?"],
    ["empty resolutions", "UPDATE policy_versions SET default_resolutions_json = '[]' WHERE id = ? AND session_id = ?"],
    ["duplicate resolutions", "UPDATE policy_versions SET default_resolutions_json = '[\"refund\",\"refund\"]' WHERE id = ? AND session_id = ?"],
  ])("rejects a malformed persisted draft header during activation: %s", async (_label, sql) => {
    const { service, context, session, draftId } = await fixture();
    const before = await db.prepare(
      "SELECT id, status, version FROM policy_versions WHERE session_id = ? ORDER BY id",
    ).bind(session.id).all<{ id: string; status: string; version: number }>();
    await db.prepare(sql).bind(draftId, session.id).run();

    await expect(service.activate({ id: draftId, expectedVersion: 1 }, context))
      .rejects.toMatchObject({ code: "INVALID_POLICY_VERSION", httpStatus: 500 });

    const after = await db.prepare(
      "SELECT id, status, version FROM policy_versions WHERE session_id = ? ORDER BY id",
    ).bind(session.id).all<{ id: string; status: string; version: number }>();
    const audit = await db.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ? AND entity_id = ? AND event_type = ?",
    ).bind(session.id, draftId, "policy.activated").first<{ count: number }>();
    expect(after.results).toEqual(before.results);
    expect(audit?.count).toBe(0);
  });

  it("activates the draft and retires the former active version in one guarded batch", async () => {
    const { service, context, session, draftId } = await fixture();
    const former = await db.prepare(
      "SELECT id FROM policy_versions WHERE session_id = ? AND status = 'active'",
    ).bind(session.id).first<{ id: string }>();
    if (former === null) throw new Error("missing former active policy");
    await service.updateDraft(update(draftId), context);
    const activated = await service.activate({ id: draftId, expectedVersion: 2 }, context);
    expect(activated.status).toBe("active");
    expect(activated.version).toBe(3);
    expect(await db.prepare(
      "SELECT status FROM policy_versions WHERE session_id = ? AND version_number = 1",
    ).bind(session.id).first()).toEqual({ status: "retired" });
    const audit = await db.prepare(
      "SELECT event_type, metadata_json FROM audit_events WHERE session_id = ? AND entity_id = ? AND event_type = ?",
    ).bind(session.id, draftId, "policy.activated").first<{
      event_type: string;
      metadata_json: string;
    }>();
    expect(audit?.event_type).toBe("policy.activated");
    expect(JSON.parse(audit?.metadata_json ?? "null")).toEqual({
      formerActivePolicyVersionId: former.id,
      version: 3,
    });
  });

  it("rejects stale version, reset races, active edits, and cross-session access", async () => {
    const first = await fixture();
    await expect(first.service.updateDraft(update(first.draftId, { expectedVersion: 9 }), first.context))
      .rejects.toMatchObject({ code: "ENTITY_VERSION_CONFLICT" });
    await db.prepare("UPDATE demo_sessions SET seed_version = seed_version + 1 WHERE id = ?")
      .bind(first.session.id).run();
    await expect(first.service.activate({ id: first.draftId, expectedVersion: 1 }, first.context))
      .rejects.toMatchObject({ code: "DEMO_SESSION_RESET" });

    const second = await fixture();
    await expect(second.service.validateDraft(first.draftId, second.context))
      .rejects.toMatchObject({ code: "POLICY_VERSION_NOT_FOUND", httpStatus: 404 });
    await expect(second.service.validateDraft("policy_draft_missing", second.context))
      .rejects.toMatchObject({ code: "POLICY_VERSION_NOT_FOUND", httpStatus: 404 });
    const activeId = await db.prepare(
      "SELECT id FROM policy_versions WHERE session_id = ? AND status = 'active'",
    ).bind(second.session.id).first<{ id: string }>();
    if (activeId === null) throw new Error("missing active policy");
    await expect(second.service.updateDraft(update(activeId.id), second.context))
      .rejects.toMatchObject({ code: "POLICY_NOT_DRAFT" });
  });
});
