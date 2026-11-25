import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const line = "fixture_line_verify_v1";
const audit = "fixture_reference_audit_v1";
const pages = "newprinted_midcentury_v0";
// A one-pixel white PNG, supplied only for the synthetic fixture media paths.
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXsAAAAASUVORK5CYII=", "base64");

async function signIn(page: Page, name: string, batch: string) {
  await page.route("**/media/fixture/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: image }));
  await page.goto(`/app/#b/${batch}`);
  await page.getByLabel("dev subject").fill(name);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".termsform")).toBeVisible();
  await page.locator(".termsform button[type=submit]").click();
}

test("line answers, More, and keyboard help", async ({ page }) => {
  await signIn(page, "line-e2e", line);
  await expect(page.locator(".txt.cand")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator(".txt.cand")).toHaveAttribute("dir", "rtl");
  await page.keyboard.press("?");
  await expect(page.locator(".keys-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".keys-panel")).toHaveCount(0);
  const save = page.waitForResponse((r) => /\/decision$/.test(r.url()) && r.request().method() === "POST");
  await page.locator('.dock [data-value="exact"]').click();
  expect((await save).ok()).toBeTruthy();
  await page.locator('.dock [data-value="edited"]').click();
  await page.locator(".editbox textarea").fill("טקסט מתוקן לדוגמה");
  const edit = page.waitForResponse((r) => /\/decision$/.test(r.url()) && r.request().method() === "POST");
  await page.locator('.editbox [data-value="edited"]').click();
  expect((await edit).ok()).toBeTruthy();
  const skip = page.waitForResponse((r) => /\/skip$/.test(r.url()));
  await page.locator('.moregroup [data-value="skip"]').click();
  expect((await skip).ok()).toBeTruthy();
});

test("keeps an offline save and resends it", async ({ page, context }) => {
  await signIn(page, "offline-e2e", line);
  await expect(page.locator(".txt.cand")).toBeVisible();
  await context.setOffline(true);
  await page.locator('.dock [data-value="exact"]').click();
  await expect(page.locator(".failed")).toBeVisible();
  const saved = page.waitForResponse((r) => /\/decision$/.test(r.url()) && r.request().method() === "POST" && r.ok());
  const pending = await page.evaluate(() => JSON.parse(localStorage.getItem("heocr-review.pending.v1") || "[]"));
  expect(pending).toHaveLength(1);
  expect(pending[0].value).toBe("exact");
  await context.setOffline(false);
  expect((await saved).request().postDataJSON()).toEqual({ value: "exact" });
  await expect(page.locator(".failed")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("heocr-review.pending.v1") || "[]").length)).toBe(0);
});

test("daily quota message on 429", async ({ page }) => {
  await signIn(page, "quota-e2e", line);
  await expect(page.locator(".txt.cand")).toBeVisible();
  await page.route("**/api/proposals/*/decision", (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "daily_limit" }) }));
  await page.locator('.dock [data-value="exact"]').click();
  await expect(page.locator(".failed")).toContainText("היום");
});

test("audit and accessibility", async ({ page }) => {
  await signIn(page, "audit-e2e", audit);
  await expect(page.locator(".review")).toBeVisible();
  // The progress bars carry an accessible name now: no WCAG A/AA violations remain.
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => [v.id, v.nodes.map((n) => n.target)])).toEqual([]);
  const save = page.waitForResponse((r) => /\/decision$/.test(r.url()) && r.ok());
  await page.locator('.dock [data-value="accepted"]').click();
  await save;
});

test("desktop page review", async ({ page }) => {
  await signIn(page, "page-e2e", pages);
  await expect(page.locator(".prlines input").first()).toBeVisible();
  await expect(page.locator(".scan img")).toBeVisible();
  const draft = page.waitForResponse((r) => /\/draft$/.test(r.url()) && r.request().method() === "PUT" && r.ok());
  await page.locator(".prlines input").first().fill("שורה מתוקנת");
  await page.locator(".prlines input").first().blur();
  await draft;
  await page.reload();
  await expect(page.locator(".prlines input").first()).toHaveValue("שורה מתוקנת");
});

test("phone hand-off and More sheet", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await signIn(page, "phone-e2e", pages);
  await expect(page.locator(".handoff")).toBeVisible();
  await expect(page.locator(".prlines input").first()).toBeHidden();
  await page.locator(".handoff details summary").click();
  await expect(page.locator(".handoff .txt").first()).toBeVisible();
  await page.goto(`/app/#b/${line}`);
  await expect(page.locator(".txt.cand")).toBeVisible();
  await page.locator(".more-btn").click();
  await expect(page.locator(".more-btn")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(".more-btn")).toHaveAttribute("aria-expanded", "false");
});


test("physical keyboard answers, previous and typed-line K", async ({ page }) => {
  await signIn(page, "keys-e2e", line);
  await expect(page.locator(".txt.cand")).toBeVisible();
  const first = await page.locator(".txt.cand").textContent();
  let response = page.waitForResponse((r) => /\/decision$/.test(r.url()) && r.ok());
  await page.keyboard.press("1");
  expect((await response).request().postDataJSON().value).toBe("exact");
  await expect(page.locator(".txt.cand")).not.toHaveText(first!);
  await page.keyboard.press("2");
  await expect(page.locator(".editbox textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".editbox textarea")).toHaveCount(0);
  const second = await page.locator(".txt.cand").textContent();
  response = page.waitForResponse((r) => /\/decision$/.test(r.url()) && r.ok());
  await page.keyboard.press("3");
  expect((await response).request().postDataJSON().value).toBe("unreadable");
  await expect(page.locator(".txt.cand")).not.toHaveText(second!);
  await page.keyboard.press("b");
  await expect(page.locator(".mine")).toBeVisible();

  await page.goto("/app/#b/fixture_line_verify_v12");
  await expect(page.locator(".precheck")).toBeVisible();
  for (let i = 0; i < 4; i++) {
    await expect(page.locator(".txt.cand")).toBeVisible();
    const before = await page.locator(".txt.cand").textContent();
    const skipped = page.waitForResponse((r) => /\/skip$/.test(r.url()) && r.ok());
    const next = page.waitForResponse((r) => /\/next$/.test(r.url()) && r.ok());
    await page.keyboard.press("s");
    await skipped;
    await next;
    if (i < 3) await expect(page.locator(".txt.cand")).not.toHaveText(before!);
    else await expect(page.locator(".editbox textarea")).toBeVisible();
  }
  await expect(page.locator(".editbox textarea")).toBeVisible();
  await page.locator(".editbox textarea").blur();
  response = page.waitForResponse((r) => /\/decision$/.test(r.url()) && r.ok());
  await page.keyboard.press("k");
  expect((await response).request().postDataJSON().value).toBe("continued");
});
