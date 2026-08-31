import { describe, expect, it } from "vitest";

import { evaluateEligibility } from "../../worker/domain/policy/evaluate";
import type {
  EligibilityInput,
  PolicyDefinition,
  PolicyRule,
} from "../../worker/domain/policy/types";

function input(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    sessionId: "session_matrix",
    caseId: "case_matrix",
    orderId: "order_matrix",
    orderItemId: "item_matrix",
    requestedQuantity: 1,
    reasonCode: "wrong_size",
    conditionCode: "unopened",
    policyVersionId: "policy_matrix",
    orderedAt: "2026-07-01T00:00:00.000Z",
    fulfilledAt: "2026-07-03T00:00:00.000Z",
    deliveredAt: "2026-08-01T00:00:00.000Z",
    evaluatedAt: "2026-08-20T00:00:00.000Z",
    category: "footwear",
    finalSale: false,
    allowedReturnConditions: ["unopened", "opened_unused"],
    fulfilledQuantity: 1,
    previouslyReturnedQuantity: 0,
    currency: "USD",
    unitPriceCents: 5000,
    refundableAmountRemainingCents: 5000,
    replacementVariant: null,
    storeCreditConsent: true,
    reviewSource: "engine",
    ...overrides,
  };
}

function rule(rule: Partial<PolicyRule> & Pick<PolicyRule, "id" | "ruleType">): PolicyRule {
  return {
    priority: 100,
    conditions: {},
    outcome: {},
    explanation: rule.id,
    active: true,
    ...rule,
  };
}

function policy(rules: readonly PolicyRule[]): PolicyDefinition {
  return {
    id: "policy_matrix",
    name: "Matrix policy",
    versionNumber: 1,
    defaultWindowDays: 30,
    absoluteMaxWindowDays: 60,
    defaultReturnRequired: true,
    defaultResolutions: ["refund", "store_credit"],
    returnShippingPayer: "merchant",
    eligibilityTtlMinutes: 15,
    rules,
  };
}

describe("five-layer deterministic rule matrix", () => {
  it("sorts matching evidence by fixed layer, descending priority, then ascending ID", () => {
    const result = evaluateEligibility(input(), policy([
      rule({ id: "z-default", ruleType: "resolution_allowlist", priority: 1, outcome: { allowedResolutions: ["refund"] } }),
      rule({ id: "z-adjust", ruleType: "return_required", priority: 100, outcome: { returnRequired: false } }),
      rule({ id: "a-adjust", ruleType: "return_shipping", priority: 100, outcome: { returnShippingPayer: "customer" } }),
    ]));

    expect(result.matchedRules.map(match => match.ruleId)).toEqual([
      "a-adjust",
      "z-adjust",
      "z-default",
    ]);
  });

  it("lets a higher-priority adjustment override a lower-priority value with evidence", () => {
    const result = evaluateEligibility(input(), policy([
      rule({ id: "lower", ruleType: "return_required", priority: 10, outcome: { returnRequired: true } }),
      rule({ id: "higher", ruleType: "return_required", priority: 20, outcome: { returnRequired: false } }),
    ]));

    expect(result.status).toBe("eligible");
    expect(result.returnRequired).toBe(false);
    expect(result.matchedRules.find(match => match.ruleId === "lower")?.effect).toBe("overridden");
  });

  it("uses only the highest-priority terminal conclusion within a layer", () => {
    const result = evaluateEligibility(input(), policy([
      rule({ id: "lower-deny", ruleType: "manual_review", priority: 10, outcome: { eligibility: "ineligible", reasonCode: "LOWER_DENY" } }),
      rule({ id: "higher-review", ruleType: "manual_review", priority: 20, outcome: { eligibility: "needs_review", reasonCode: "HIGHER_REVIEW" } }),
    ]));

    expect(result.status).toBe("needs_review");
    expect(result.reasonCodes).toContain("HIGHER_REVIEW");
    expect(result.reasonCodes).not.toContain("LOWER_DENY");
  });

  it("keeps an earlier-layer terminal conclusion ahead of a later-layer conflict", () => {
    const result = evaluateEligibility(input(), policy([
      rule({ id: "early-deny", ruleType: "condition_requirement", priority: 1, outcome: { eligibility: "ineligible", reasonCode: "EARLY_DENY" } }),
      rule({ id: "later-a", ruleType: "return_required", priority: 40, outcome: { returnRequired: true } }),
      rule({ id: "later-b", ruleType: "return_required", priority: 40, outcome: { returnRequired: false } }),
    ]));

    expect(result.status).toBe("ineligible");
    expect(result.reasonCodes).toEqual(["EARLY_DENY"]);
    expect(result.conflictEvidence).toBeNull();
  });

  it("keeps a configured layer-1 terminal ahead of a later built-in exception", () => {
    const result = evaluateEligibility(input({
      finalSale: true,
      reasonCode: "damaged",
      conditionCode: "damaged",
      allowedReturnConditions: ["damaged"],
    }), policy([
      rule({
        id: "layer-one-deny",
        ruleType: "quantity_limit",
        priority: 10,
        outcome: { eligibility: "ineligible", reasonCode: "LAYER_ONE_DENY" },
      }),
    ]));

    expect(result.status).toBe("ineligible");
    expect(result.reasonCodes).toEqual(["LAYER_ONE_DENY"]);
  });

  it("routes same-priority terminal conflicts to deterministic review", () => {
    const result = evaluateEligibility(input(), policy([
      rule({ id: "a-deny", ruleType: "manual_review", priority: 20, outcome: { eligibility: "ineligible", reasonCode: "A_DENY" } }),
      rule({ id: "b-review", ruleType: "manual_review", priority: 20, outcome: { eligibility: "needs_review", reasonCode: "B_REVIEW" } }),
    ]));

    expect(result.status).toBe("needs_review");
    expect(result.reasonCodes).toEqual(["POLICY_RULE_CONFLICT"]);
    expect(result.conflictEvidence).toEqual({
      layer: 3,
      priority: 20,
      field: "eligibility",
      ruleIds: ["a-deny", "b-review"],
      values: ["ineligible", "needs_review"],
    });
  });

  it("routes same-status same-priority reason conflicts to deterministic review", () => {
    const result = evaluateEligibility(input(), policy([
      rule({ id: "a-review", ruleType: "manual_review", priority: 20, outcome: { eligibility: "needs_review", reasonCode: "A_REASON" } }),
      rule({ id: "b-review", ruleType: "manual_review", priority: 20, outcome: { eligibility: "needs_review", reasonCode: "B_REASON" } }),
    ]));

    expect(result.status).toBe("needs_review");
    expect(result.reasonCodes).toEqual(["POLICY_RULE_CONFLICT"]);
    expect(result.conflictEvidence).toEqual({
      layer: 3,
      priority: 20,
      field: "reasonCode",
      ruleIds: ["a-review", "b-review"],
      values: ["A_REASON", "B_REASON"],
    });
  });

  it("routes same-priority field conflicts to deterministic review independent of input order", () => {
    const first = rule({ id: "rule-b", ruleType: "return_required", priority: 40, outcome: { returnRequired: true } });
    const second = rule({ id: "rule-a", ruleType: "return_required", priority: 40, outcome: { returnRequired: false } });

    const left = evaluateEligibility(input(), policy([first, second]));
    const right = evaluateEligibility(input(), policy([second, first]));

    expect(left.status).toBe("needs_review");
    expect(left.reasonCodes).toEqual(["POLICY_RULE_CONFLICT"]);
    expect(left.conflictEvidence).toEqual({
      layer: 4,
      priority: 40,
      field: "returnRequired",
      ruleIds: ["rule-a", "rule-b"],
      values: [false, true],
    });
    expect(left.returnRequired).toBe(true);
    expect(right).toEqual(left);
  });

  it("applies a category window but clamps it to the absolute maximum", () => {
    const result = evaluateEligibility(
      input({ evaluatedAt: "2026-09-29T23:59:59.999Z" }),
      policy([rule({
        id: "long-window",
        ruleType: "category_window",
        conditions: { category: "footwear" },
        outcome: { returnWindowDays: 90 },
      })]),
    );

    expect(result.status).toBe("eligible");
    expect(result.windowEndsAt).toBe("2026-09-30T00:00:00.000Z");
  });

  it("returns ineligible when policy filtering leaves no usable resolution", () => {
    const result = evaluateEligibility(input(), policy([
      rule({ id: "exchange-only", ruleType: "resolution_allowlist", outcome: { allowedResolutions: ["exchange"] } }),
    ]));

    expect(result.status).toBe("ineligible");
    expect(result.reasonCodes).toContain("EXCHANGE_INVENTORY_UNAVAILABLE");
    expect(result.allowedResolutions).toEqual([]);
  });

  it("honors structured reason and amount conditions", () => {
    const result = evaluateEligibility(input(), policy([
      rule({
        id: "returnless-low-value-damage",
        ruleType: "return_required",
        conditions: { reasonCodes: ["damaged"], maxRefundableAmountCents: 6000 },
        outcome: { returnRequired: false },
      }),
    ]));
    const damaged = evaluateEligibility(input({
      reasonCode: "damaged",
      conditionCode: "damaged",
      allowedReturnConditions: ["unopened", "opened_unused", "damaged"],
    }), policy([
      rule({
        id: "returnless-low-value-damage",
        ruleType: "return_required",
        conditions: { reasonCodes: ["damaged"], maxRefundableAmountCents: 6000 },
        outcome: { returnRequired: false },
      }),
    ]));

    expect(result.returnRequired).toBe(true);
    expect(damaged.returnRequired).toBe(false);
  });
});
