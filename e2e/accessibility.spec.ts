import { test, expect } from "@playwright/test";
test("supports keyboard navigation and returns focus after closing reset", async ({ page }) => {
  await page.goto("/"); await expect(page.getByRole("heading", { level: 1 })).toHaveText("Good returns. Better resolutions.");
  await page.keyboard.press("Tab"); await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  const reset = page.getByRole("button", { name: "Reset demo", exact: true }); await reset.click(); await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(reset).toBeFocused();
});
