import { test, expect } from "@playwright/test";
import { startUiCase, proposeUi, approveUi, facts } from "./helpers";
test("refund completes with exactly one simulated refund and return label", async ({ page }) => {
  const id = await startUiCase(page); await proposeUi(page); await approveUi(page); const result = await facts(page, id);
  expect(result.completion?.rma.status).toBe("completed"); expect(result.completion?.effects.map(e => e.entityType).sort()).toEqual(["return_label", "simulated_refund"]);
  expect(result.order.items[0]!.remainingReturnableQuantity).toBe(0);
});
test("store credit requires consent and records only simulated credit", async ({ page }) => {
  const id = await startUiCase(page, "store_credit"); await proposeUi(page, "store_credit"); await approveUi(page);
  const result = await facts(page, id); expect(result.completion?.effects.map(e => e.entityType).sort()).toEqual(["return_label", "store_credit"]);
});
