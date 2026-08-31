import { describe, expect, it } from "vitest";

import { evaluateEligibility } from "../../worker/domain/policy/evaluate";
import type {
  EligibilityInput,
  PolicyDefinition,
} from "../../worker/domain/policy/types";

const HOUR = 60 * 60 * 1000;

function input(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    sessionId: "session_1",
    caseId: "case_1",
    orderId: "order_1",
    orderItemId: "item_1",
    requestedQuantity: 1,
    reasonCode: "wrong_size",
    conditionCode: "opened_unused",
    policyVersionId: "policy_1",
    orderedAt: "2026-07-01T00:00:00.000Z",
    fulfilledAt: "2026-07-02T00:00:00.000Z",
    deliveredAt: "2026-08-01T00:00:00.000Z",
    evaluatedAt: "2026-08-15T00:00:00.000Z",
    category: "footwear",
    finalSale: false,
    allowedReturnConditions: ["unopened", "opened_unused"],
    fulfilledQuantity: 2,
    previouslyReturnedQuantity: 0,
    currency: "USD",
    unitPriceCents: 1004,
    refundableAmountRemainingCents: 2008,
    replacementVariant: {
      id: "variant_2",
      sku: "SHOE-BLUE-9",
      active: true,
      inventoryQuantity: 3,
      inventoryVersion: 4,
      unitPriceCents: 1004,
    },
    storeCreditConsent: false,
    reviewSource: "engine",
    ...overrides,
  };
}

function policy(overrides: Partial<PolicyDefinition> = {}): PolicyDefinition {
  return {
    id: "policy_1",
    name: "Standard returns",
    versionNumber: 7,
    defaultWindowDays: 30,
    absoluteMaxWindowDays: 60,
    defaultReturnRequired: true,
    defaultResolutions: ["exchange", "refund", "store_credit"],
    returnShippingPayer: "merchant",
    eligibilityTtlMinutes: 15,
    rules: [],
    ...overrides,
  };
}

describe("evaluateEligibility hard facts and policy boundaries", () => {
  it.each([
    ["one millisecond before window end", "2026-08-30T23:59:59.999Z", "eligible", "WITHIN_RETURN_WINDOW"],
    ["exactly at exclusive window end", "2026-08-31T00:00:00.000Z", "ineligible", "RETURN_WINDOW_CLOSED"],
  ] as const)("handles %s", (_name, evaluatedAt, status, reasonCode) => {
    const result = evaluateEligibility(input({ evaluatedAt }), policy());

    expect(result.status).toBe(status);
    expect(result.reasonCodes).toContain(reasonCode);
    expect(result.windowEndsAt).toBe("2026-08-31T00:00:00.000Z");
  });

  it.each([
    ["undelivered order", { deliveredAt: null }, "ORDER_NOT_DELIVERED"],
    ["zero quantity", { requestedQuantity: 0 }, "INVALID_ELIGIBILITY_INPUT"],
    ["no remaining quantity", { fulfilledQuantity: 1, previouslyReturnedQuantity: 1 }, "NO_RETURNABLE_QUANTITY"],
    ["quantity exceeds remainder", { requestedQuantity: 2, fulfilledQuantity: 1 }, "NO_RETURNABLE_QUANTITY"],
  ] as const)("rejects %s", (_name, overrides, reasonCode) => {
    const result = evaluateEligibility(input(overrides), policy());

    expect(result.status).toBe("ineligible");
    expect(result.reasonCodes).toContain(reasonCode);
    expect(result.allowedResolutions).toEqual([]);
  });

  it.each(["changed_mind", "wrong_size"] as const)(
    "rejects Final Sale for normal reason %s",
    reasonCode => {
      const result = evaluateEligibility(input({ finalSale: true, reasonCode }), policy());

      expect(result.status).toBe("ineligible");
      expect(result.reasonCodes).toContain("FINAL_SALE_RESTRICTED");
    },
  );

  it.each(["damaged", "wrong_item", "not_as_described"] as const)(
    "routes Final Sale exception %s to human review",
    reasonCode => {
      const result = evaluateEligibility(input({ finalSale: true, reasonCode }), policy());

      expect(result.status).toBe("needs_review");
      expect(result.reasonCodes).toContain("MANUAL_REVIEW_REQUIRED");
      expect(result.proposalSubmissionAllowed).toBe(false);
    },
  );

  it("applies the layer-2 condition rejection before the layer-3 Final Sale damage exception", () => {
    const result = evaluateEligibility(input({
      finalSale: true,
      reasonCode: "damaged",
      conditionCode: "damaged",
    }), policy());

    expect(result.status).toBe("ineligible");
    expect(result.reasonCodes).toEqual(["CONDITION_NOT_ALLOWED"]);
  });

  it("routes contradictory reason and condition facts to review", () => {
    const result = evaluateEligibility(
      input({ reasonCode: "changed_mind", conditionCode: "damaged" }),
      policy(),
    );

    expect(result.status).toBe("needs_review");
    expect(result.reasonCodes).toEqual(["CONDITION_REASON_CONFLICT"]);
  });

  it("rejects a condition outside the product allowlist", () => {
    const result = evaluateEligibility(input({ conditionCode: "used" }), policy());

    expect(result.status).toBe("ineligible");
    expect(result.reasonCodes).toContain("CONDITION_NOT_ALLOWED");
  });

  it("uses UTC calendar boundaries for elapsed days and window end", () => {
    const result = evaluateEligibility(input({
      deliveredAt: "2026-08-01T23:30:00.000Z",
      evaluatedAt: "2026-08-02T00:15:00.000Z",
    }), policy());

    expect(result.elapsedDays).toBe(1);
    expect(result.windowEndsAt).toBe("2026-08-31T00:00:00.000Z");
  });

  it.each([
    ["evaluation", { evaluatedAt: "not-an-instant" }],
    ["delivery", { deliveredAt: "2026-99-99T00:00:00Z" }],
    ["calendar date", { deliveredAt: "2026-02-30T00:00:00Z" }],
    ["order", { orderedAt: "invalid" }],
  ] as const)("returns INVALID_ELIGIBILITY_INPUT for an invalid %s instant", (_name, overrides) => {
    const result = evaluateEligibility(input(overrides), policy());

    expect(result.status).toBe("ineligible");
    expect(result.reasonCodes).toEqual(["INVALID_ELIGIBILITY_INPUT"]);
  });

  it("hashes distinct invalid raw timestamps stably without changing their rejection", () => {
    const first = evaluateEligibility(input({ evaluatedAt: "not-an-instant" }), policy());
    const repeated = evaluateEligibility(input({ evaluatedAt: "not-an-instant" }), policy());
    const distinct = evaluateEligibility(input({ evaluatedAt: "still-not-an-instant" }), policy());

    expect(first.status).toBe("ineligible");
    expect(first.reasonCodes).toEqual(["INVALID_ELIGIBILITY_INPUT"]);
    expect(first.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(repeated.inputHash).toBe(first.inputHash);
    expect(distinct.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(distinct.inputHash).not.toBe(first.inputHash);
  });
});

describe("evaluateEligibility resolutions and money", () => {
  it("removes only exchange when target inventory is unavailable", () => {
    const result = evaluateEligibility(
      input({
        replacementVariant: {
          id: "variant_2",
          sku: "SHOE-BLUE-9",
          active: true,
          inventoryQuantity: 0,
          inventoryVersion: 5,
          unitPriceCents: 1004,
        },
      }),
      policy(),
    );

    expect(result.status).toBe("eligible");
    expect(result.allowedResolutions.map(option => option.type)).toEqual([
      "refund",
      "store_credit",
    ]);
    expect(result.reasonCodes).toContain("EXCHANGE_INVENTORY_UNAVAILABLE");
  });

  it("marks store-credit consent and rounds percentage bonuses to nearest cent", () => {
    const result = evaluateEligibility(
      input(),
      policy({
        rules: [{
          id: "bonus",
          ruleType: "store_credit_bonus",
          priority: 50,
          conditions: {},
          outcome: { storeCreditBonusBps: 1250 },
          explanation: "A 12.5% store-credit bonus applies.",
          active: true,
        }],
      }),
    );
    const credit = result.allowedResolutions.find(option => option.type === "store_credit");

    expect(credit).toMatchObject({
      amountCents: 1130,
      merchantCostCents: 1130,
      customerConsentRequired: true,
      returnRequired: true,
    });
    expect(result.returnRequired).toBe(true);
  });

  it("caps the base resolution amount at the remaining refundable amount", () => {
    const result = evaluateEligibility(
      input({ requestedQuantity: 2, refundableAmountRemainingCents: 1500 }),
      policy({ defaultResolutions: ["refund"] }),
    );

    expect(result.allowedResolutions).toEqual([expect.objectContaining({
      type: "refund",
      amountCents: 1500,
      merchantCostCents: 1500,
    })]);
  });
});

describe("eligibility input hash", () => {
  it("is stable across semantically irrelevant object and set ordering", () => {
    const left = evaluateEligibility(
      input({ allowedReturnConditions: ["opened_unused", "unopened"] }),
      policy({ defaultResolutions: ["store_credit", "refund", "exchange"] }),
    );
    const right = evaluateEligibility(input(), policy());

    expect(left.inputHash).toBe(right.inputHash);
    expect(left.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["inventory version", input({ replacementVariant: { id: "variant_2", sku: "SHOE-BLUE-9", active: true, inventoryQuantity: 3, inventoryVersion: 5, unitPriceCents: 1004 } }), policy()],
    ["consent", input({ storeCreditConsent: true }), policy()],
    ["policy version", input(), policy({ versionNumber: 8 })],
    ["policy rule", input(), policy({ rules: [{ id: "returnless", ruleType: "return_required", priority: 1, conditions: {}, outcome: { returnRequired: false }, explanation: "No return required.", active: true }] })],
    ["evaluation time", input({ evaluatedAt: new Date(new Date(input().evaluatedAt).getTime() + HOUR).toISOString() }), policy()],
  ] as const)("changes when %s changes", (_name, changedInput, changedPolicy) => {
    const baseline = evaluateEligibility(input(), policy());
    const changed = evaluateEligibility(changedInput, changedPolicy);

    expect(changed.inputHash).not.toBe(baseline.inputHash);
  });
});
