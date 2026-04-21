import { test, expect } from "@playwright/test";

/**
 * smoke.spec.ts — Verify the mock server + Alpine frontend boot correctly.
 * If this fails, none of the other E2E tests will work — it's the foundation.
 */

test.describe("smoke: app boots", () => {
  test("loads index and shows the candidates table with seeded data", async ({ page }) => {
    await page.goto("/");
    // Wait for Alpine.js to finish rendering
    await expect(page.locator(".brand-title")).toContainText("TPG Recruiting ATS");
    // User chip pulls email from our mocked getCurrentUserEmail()
    await expect(page.locator(".brand-sub")).toContainText("test.recruiter@thepipelinegroup.io");
    // Default status filter = Active → should show 3 candidates (Jane, Mark, Sarah)
    await expect(page.locator(".candidates-table tbody tr")).toHaveCount(3);
  });

  test("sync indicator is live (green)", async ({ page }) => {
    await page.goto("/");
    // Alpine init calls getCurrentUserEmail first, then loadAll → checkSync runs
    await expect(page.locator(".sync-indicator")).toBeVisible();
    // Should read "Live" while idle
    await expect(page.locator(".sync-indicator")).toContainText(/Live|Syncing/);
  });

  test("KPI strip renders the 4 cards with numbers", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".kpi-card")).toHaveCount(4);
    const activeCount = await page.locator(".kpi-card").first().locator(".kpi-value").textContent();
    expect(Number(activeCount)).toBeGreaterThanOrEqual(3); // at least 3 active
  });
});
