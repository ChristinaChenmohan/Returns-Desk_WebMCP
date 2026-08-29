import { describe, expect, it } from "vitest";
import { checkEligibilityInput, submitProposalInput, toolNames } from "../../src/shared/contracts/tools";

describe("tool contracts", () => {
  it("contains exactly the six approved tools", () => {
    expect(toolNames).toEqual([
      "search_orders", "get_return_policy", "check_return_eligibility",
      "compare_resolution_options", "draft_customer_message", "submit_rma_for_approval",
    ]);
  });

  it("rejects unknown fields and zero quantity", () => {
    expect(() => checkEligibilityInput.parse({
      orderId: "ord_1", orderItemId: "item_1", requestedQuantity: 0,
      reasonCode: "wrong_size", conditionCode: "opened_unused",
      idempotencyKey: "eligibility-1", unexpected: true,
    })).toThrow();
  });

  it("requires a proposal idempotency key", () => {
    expect(submitProposalInput.safeParse({}).success).toBe(false);
  });
});
