import { expect, test } from "@playwright/test";
import type { BatchSummary } from "../../src/shared/api";

function batch(id: string, title: string, remaining: number, extra: Partial<BatchSummary> = {}): BatchSummary {
  return {
    id, title, taskType: "line_verify", taskLabel: { he: "בדיקת שורות", en: "Line verification" }, subsets: [],
    progress: { total: 10, covered: 10 - remaining, minReviewers: 1, decidedByMe: 10 - remaining,
      skippedByMe: 0, remainingForMe: remaining },
    ...extra,
  };
}

test("hides completed tasks by default and remembers the choice for only the current reviewer", async ({ page }) => {
  let reviewerId = "rv_00000001";
  const done = batch("completed", "משימה שהושלמה", 0);
  let batches = [
    done,
    batch("active", "משימה פעילה", 4),
    batch("page-only", "סריקת עמוד לסקירה", 0, { pageSweep: { remainingPages: 1 } }),
    batch("fix-only", "תיקוני שולחן עבודה", 0, { triage: { triage: 0, fix: 2 } }),
    batch("lines-only", "שורות שנותרו", 3, { pageSweep: { remainingPages: 0 } }),
    batch("own-only", "משימת מתנדבים", 0, { progress: { ...done.progress, ownOnly: true } }),
  ];
  await page.route("**/api/me", route => route.fulfill({ json: { reviewerId, termsCurrent: true, isAdmin: true } }));
  await page.route("**/api/batches", route => route.fulfill({ json: { batches } }));
  await page.goto("/app/#tasks");

  const toggle = page.getByRole("checkbox", { name: "הסתרת משימות שהושלמו" });
  const cards = page.locator(".pick");
  const completed = page.locator('a[href="#b/completed"]');
  await expect(toggle).toBeChecked();
  await expect(cards).toHaveCount(5);
  await expect(completed).toHaveCount(0);
  await expect(page.locator('a[href="#b/lines-only"] .count')).toContainText("3");

  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeFocused();
  await expect(toggle).not.toBeChecked();
  await expect(completed).toBeVisible();
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await expect(completed).toBeVisible();

  reviewerId = "rv_00000002";
  batches = [done];
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole("status")).toHaveText("לא נשארו לך משימות להשלמה");
  await expect(cards).toHaveCount(0);
  await toggle.click();
  await expect(completed).toBeVisible();

  await page.evaluate(() => localStorage.setItem("heocr-review.prefs.v1", JSON.stringify({ lang: "en" })));
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Hide completed tasks" })).not.toBeChecked();
  await expect(completed).toBeVisible();
});
