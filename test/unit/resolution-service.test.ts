import { describe, expect, it } from "vitest";

import { ResolutionService } from "../../worker/domain/resolution-service";
import type { EligibilityCheckRecord } from "../../worker/repositories/eligibility-repository";

const baseOption = {
  customerOutcome: "Outcome",
  currency: "USD",
  returnRequired: true,
  customerConsentRequired: false,
  replacementVariantId: null,
  replacementSku: null,
  inventoryQuantity: null,
  inventoryVersion: null,
  recommendationReasons: [] as readonly string[],
};

function check(overrides: Partial<EligibilityCheckRecord> = {}): EligibilityCheckRecord {
  const decision = {
    status: "eligible" as const,
    policyVersionId: "policy_locked",
    policyName: "Locked",
    requestedQuantity: 1,
    remainingReturnableQuantity: 1,
    allowedResolutions: [
      { ...baseOption, type: "refund" as const, merchantCostCents: 2_000, amountCents: 2_000 },
      { ...baseOption, type: "store_credit" as const, merchantCostCents: 2_100, amountCents: 2_100 },
    ],
    returnRequired: true,
    returnShippingPayer: "merchant" as const,
    reasonCodes: [],
    matchedRules: [],
    missingInformation: [],
    windowEndsAt: "2026-09-10T00:00:00.000Z",
    elapsedDays: 1,
    expiresAt: "2026-08-29T08:00:00.000Z",
    inputHash: "hash",
    conflictEvidence: null,
    proposalSubmissionAllowed: true,
  };
  return {
    id: "check_1",
    sessionId: "session_1",
    caseId: "case_1",
    orderItemId: "item_1",
    policyVersionId: "policy_locked",
    requestedQuantity: 1,
    reasonCode: "wrong_size",
    conditionCode: "unopened",
    status: "eligible",
    returnRequired: true,
    returnShippingPayer: "merchant",
    inputHash: "hash",
    snapshot: {
      input: {
        sessionId: "session_1", caseId: "case_1", orderId: "order_1", orderItemId: "item_1",
        requestedQuantity: 1, reasonCode: "wrong_size", conditionCode: "unopened",
        policyVersionId: "policy_locked", orderedAt: "2026-08-01T00:00:00.000Z",
        fulfilledAt: "2026-08-02T00:00:00.000Z", deliveredAt: "2026-08-03T00:00:00.000Z",
        evaluatedAt: "2026-08-29T07:00:00.000Z", category: "footwear", finalSale: false,
        allowedReturnConditions: ["unopened"], fulfilledQuantity: 1, previouslyReturnedQuantity: 0,
        currency: "USD", unitPriceCents: 2_000, refundableAmountRemainingCents: 2_000,
        replacementVariant: null, storeCreditConsent: true, reviewSource: "engine",
      },
      decision,
      caseVersion: 1,
    },
    createdAt: "2026-08-29T07:00:00.000Z",
    expiresAt: "2026-08-29T08:00:00.000Z",
    ...overrides,
  };
}

describe("ResolutionService", () => {
  it("ranks only options already allowed by the immutable snapshot", async () => {
    const source = { findById: async () => check() };
    const result = await new ResolutionService(source, { now: () => new Date("2026-08-29T07:00:00.000Z") }).compare(
      { eligibilityCheckId: "check_1", preference: "customer_value" },
      { sessionId: "session_1" },
    );

    expect(result.options.map(option => option.type)).toEqual(["store_credit", "refund"]);
    expect(result.options).toHaveLength(2);
    expect(result.options.every(option => Number.isSafeInteger(option.merchantCostCents))).toBe(true);
  });

  it("uses merchant cost and a stable resolution-type tie breaker", async () => {
    const tied = check();
    tied.snapshot.decision.allowedResolutions = [
      { ...baseOption, type: "store_credit", merchantCostCents: 1_000, amountCents: 1_000 },
      { ...baseOption, type: "exchange", merchantCostCents: 1_000, amountCents: null },
      { ...baseOption, type: "refund", merchantCostCents: 1_000, amountCents: 1_000 },
    ];
    const result = await new ResolutionService(
      { findById: async () => tied },
      { now: () => new Date("2026-08-29T07:00:00.000Z") },
    ).compare(
      { eligibilityCheckId: "check_1", preference: "merchant_cost" },
      { sessionId: "session_1" },
    );
    expect(result.options.map(option => option.type)).toEqual(["exchange", "refund", "store_credit"]);
  });

  it("rejects missing, stale, and non-eligible snapshots without inventing options", async () => {
    await expect(new ResolutionService({ findById: async () => null }).compare(
      { eligibilityCheckId: "missing", preference: "customer_value" }, { sessionId: "session_1" },
    )).rejects.toMatchObject({ code: "ELIGIBILITY_CHECK_NOT_FOUND", httpStatus: 404 });

    const stale = check({ expiresAt: "2026-08-29T06:00:00.000Z" });
    await expect(new ResolutionService(
      { findById: async () => stale },
      { now: () => new Date("2026-08-29T07:00:00.000Z") },
    ).compare(
      { eligibilityCheckId: "check_1", preference: "customer_value" }, { sessionId: "session_1" },
    )).rejects.toMatchObject({ code: "ELIGIBILITY_CHECK_STALE" });

    const ineligible = check({ status: "ineligible" });
    ineligible.snapshot.decision.status = "ineligible";
    ineligible.snapshot.decision.allowedResolutions = [];
    await expect(new ResolutionService(
      { findById: async () => ineligible },
      { now: () => new Date("2026-08-29T07:00:00.000Z") },
    ).compare(
      { eligibilityCheckId: "check_1", preference: "customer_value" }, { sessionId: "session_1" },
    )).rejects.toMatchObject({ code: "ELIGIBILITY_NOT_ELIGIBLE" });
  });
});
