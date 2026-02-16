import { test, expect } from "@playwright/test";

test("load app shell and render sidebar", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/one-geo/i)).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByRole("button", { name: "Dashboard", exact: true })
  ).toBeVisible({ timeout: 15000 });
});
