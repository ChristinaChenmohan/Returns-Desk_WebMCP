import { test, expect } from "@playwright/test";
import { startUiCase, proposeUi, approveUi, facts } from "./helpers";
test("exchange commits one reservation and reduces replacement inventory", async ({ page }) => {
  const id = await startUiCase(page, "exchange"); const before = await facts(page, id);
  await proposeUi(page, "exchange"); await approveUi(page); const after = await facts(page, id);
  expect(after.completion?.effects.filter(e => e.entityType === "inventory_reservation")).toHaveLength(1);
  expect(after.order.items[0]!.replacementVariants[0]!.inventoryQuantity).toBe(before.order.items[0]!.replacementVariants[0]!.inventoryQuantity - 1);
});
