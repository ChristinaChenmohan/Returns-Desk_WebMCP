import { test, expect } from "@playwright/test";
import { startUiCase, facts } from "./helpers";
test("human review creates a child eligibility snapshot", async ({ page }) => {
  const id = await startUiCase(page, "refund", "ORD-1002"); const before = await facts(page, id);
  expect(before.latestEligibility?.status).toBe("needs_review"); await expect(page.getByText("Prepare proposal", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Review eligibility", exact: true }).click(); await page.getByRole("combobox", { name: "Review decision" }).selectOption("eligible_exception_approved");
  await page.getByRole("combobox", { name: "Reason code" }).selectOption("EVIDENCE_VERIFIED"); await page.getByRole("dialog").getByRole("button", { name: "Review eligibility", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0); const after = await facts(page, id);
  expect(after.latestEligibility?.status).toBe("eligible"); expect(after.latestEligibility?.eligibilityCheckId).not.toBe(before.latestEligibility?.eligibilityCheckId);
});

