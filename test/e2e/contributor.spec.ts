import { expect, test } from "@playwright/test";
import { CONTRIBUTOR_API, requiredPrintModes, type ContributorProfile, type ContributorQueue, type PrintCapture } from "../../src/shared/contributor";

const writer = "cw-" + "a".repeat(32);
const writerPath = `${CONTRIBUTOR_API}/writers/${writer}`;
const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/R8kAAAAASUVORK5CYII=", "base64");

test("handwriting signup on a phone offers only the sets from the assigned split", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const copy = { text: "Invented fixture wording", sha256: "1".repeat(64) };
  const policy = { version: "fixture", guardian: { he: copy, en: copy } };
  const who = { inviteCode: "2".repeat(32), ageBand: "10_12" };
  const profile: ContributorProfile = {
    role: "writer", writer, ageBand: "10_12", state: "guardian", receipt: null,
    licence: "cc0_open", version: "fixture", copy: { he: copy, en: copy }, queues: [],
  };
  await page.route("**/api/config", async route => {
    const response = await route.fetch();
    return route.fulfill({ response, json: { ...await response.json(), contributorEnabled: true } });
  });
  await page.route(`**${CONTRIBUTOR_API}/enrolments**`, async route => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: { enrolments: [], signup: policy } });
    if (new URL(request.url()).pathname.endsWith("/options")) {
      expect(request.postDataJSON()).toEqual(who);
      return route.fulfill({ json: { split: "eval_open", sets: ["D"] } });
    }
    expect(request.postDataJSON()).toEqual({ ...who, split: "eval_open", set: "D" });
    return route.fulfill({ json: profile });
  });
  await page.goto("/app/#contributor");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("הרשמה לכתיבה ביד")).toBeVisible();
  await expect(page.getByLabel("סט להעתקה")).toHaveCount(0);
  await page.getByLabel("קוד הזמנה").fill(who.inviteCode);
  await page.getByLabel("קבוצת גיל").selectOption(who.ageBand);
  await page.getByRole("button", { name: "המשך", exact: true }).click();
  const set = page.getByLabel("סט להעתקה");
  await expect(set.locator("option")).toHaveCount(1);
  await expect(set).toHaveValue("D");
  await page.getByRole("button", { name: "הרשמה", exact: true }).click();
  await expect(page.getByText("המשימות ייפתחו אחרי אישור", { exact: false })).toBeVisible();
});

test("contributor invitation shows only sign-in then the Hebrew assigned walkthroughs", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.addInitScript(() => localStorage.setItem("heocr-review.prefs.v1", JSON.stringify({ lang: "en" })));
  const copy = { text: "Invented fixture wording", sha256: "1".repeat(64) };
  const modes = [...requiredPrintModes, "shadow" as const];
  let saved = 0;
  const capture = (mode: PrintCapture["mode"]): PrintCapture => ({ id: mode, kind: "print", page: "TRN-PRINT-01",
    mode, variant: "kids", sheet: `${writerPath}/tasks/${mode}/sheet`, captureSteps: modes.map((mode, index) => ({ mode, saved: index < saved })) });
  const printQueue = (): ContributorQueue => ({ kind: "print", total: 5, done: Math.min(saved, 5),
    next: saved < 5 ? capture(requiredPrintModes[saved]!) : null,
    ...(saved === 5 ? { optionalPrint: [capture("shadow")] } : {}) });
  const profile: ContributorProfile = {
    role: "writer", writer, ageBand: "10_12", state: "ready", receipt: null,
    licence: "cc0_open", version: "fixture", copy: { he: copy, en: copy },
    queues: [
      printQueue(),
      { kind: "form", total: 1, done: 0, next: { id: "form", kind: "form", page: "F01", sheet: `${writerPath}/tasks/form/sheet`,
        fields: [{ id: "code", label: "קוד לדוגמה", value: "F-123" }], referenceSha256: "2".repeat(64) } },
      { kind: "handwriting", total: 1, done: 0, next: { id: "copy", kind: "handwriting", page: "H01",
        prompt: "הילדה ציירה ענן.\nהגשם כבר פסק.", rights: "PD: invented fixture", referenceSha256: "3".repeat(64) } },
    ],
  };
  let requests = 0;
  await page.route("**/api/config", async route => {
    const response = await route.fetch();
    return route.fulfill({ response, json: { ...await response.json(), contributorEnabled: true } });
  });
  await page.route(`**${CONTRIBUTOR_API}/**`, async route => {
    requests++;
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/enrolments")) return route.fulfill({ json: { enrolments: [{ writer, role: "writer", ageBand: "10_12" }] } });
    if (path === writerPath) return route.fulfill({ json: profile });
    if (path === `${writerPath}/tasks/${modes[saved]}/submit`) {
      expect(route.request().postDataBuffer()).toEqual(original);
      expect(route.request().headers()["x-contributor-privacy"]).toBe("confirmed");
      saved++;
      profile.queues[0] = printQueue();
      return route.fulfill({ json: profile });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });

  await page.goto("/app/#contributor");
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(signIn).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("header.top")).toBeHidden();
  await expect(page.locator("footer")).toBeHidden();
  await expect(page.getByRole("link")).toHaveCount(0);
  expect(requests).toBe(0);

  await signIn.click();
  const queues = page.locator(".contributor-queue");
  await expect(queues.locator("h2")).toHaveText(["צילום דפים מודפסים", "מילוי טפסים לדוגמה", "כתיבה ביד"]);
  await expect(page.locator("#nav a")).toHaveCount(2);
  await expect(page.locator("a[href='#tasks'], a[href='#conventions']")).toHaveCount(0);
  await queues.filter({ hasText: "צילום דפים מודפסים" }).getByRole("button").click();
  await expect(page.locator(".contributor-guide > li")).toHaveCount(7);
  await expect(page.getByRole("link", { name: "הורדה והדפסה" })).toHaveAttribute("href", `${writerPath}/tasks/flat/sheet`);
  await expect(page.getByText("בכ־30 מעלות", { exact: false })).toBeVisible();
  await expect(page.getByText("כבו שמירת מיקום", { exact: false })).toBeVisible();
  await expect(page.getByText("בקשו ממבוגר לעזור", { exact: false })).toBeVisible();
  const current = page.locator("[aria-current='step']");
  for (const mode of requiredPrintModes) {
    await expect(current.getByText("הרחיקו ידיים ופנים", { exact: false })).toBeVisible();
    await expect(current.locator(`.guide-art-${mode}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "בחירת צילום" })).toHaveCount(1);
    const chooser = page.waitForEvent("filechooser");
    await current.getByRole("button", { name: "בחירת צילום" }).click();
    await (await chooser).setFiles({ name: "fixture.png", mimeType: "image/png", buffer: original });
    await expect(current.getByRole("img", { name: "תצוגה מקדימה של הצילום שנבחר" })).toBeVisible();
    await current.getByRole("checkbox").check();
    await current.getByRole("button", { name: "העלאת צילום" }).click();
  }
  await expect(current.locator(".guide-art-shadow")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("הצילום נשמר.");
  await page.getByRole("button", { name: "ממשיכים בלי הצילום הזה" }).click();
  await expect(queues.first().locator("progress")).toHaveAttribute("value", "5");
  await expect(queues.first().getByRole("button", { name: /צילום רשות/ })).toBeVisible();
  expect(saved).toBe(5);
  await queues.filter({ hasText: "מילוי טפסים לדוגמה" }).getByRole("button").click();
  await expect(page.locator(".contributor-guide > li")).toHaveCount(5);
  await expect(page.locator(".contributor-persona")).toContainText("F-123");
  await expect(page.getByText("המומצאים שבכרטיס", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "משימות תרומה" }).click();
  await queues.filter({ hasText: "כתיבה ביד" }).getByRole("button").click();
  await expect(page.getByRole("button", { name: "הדפסת דף כתיבה" })).toBeVisible();
  await expect(page.locator(".contributor-prompt li")).toHaveText(["הילדה ציירה ענן.", "הגשם כבר פסק."]);
  await page.emulateMedia({ media: "print" });
  const print = await page.getByRole("button", { name: "הדפסת דף כתיבה" }).evaluate((button: HTMLButtonElement) => {
    const originalPrint = window.print;
    let content;
    window.print = () => {
      const visible = (selector: string) => document.querySelector(selector)!.getClientRects().length > 0;
      content = { prompt: visible(".contributor-prompt"), instructions: visible(".contributor-print-help"),
        illustration: visible(".guide-art"), upload: visible(".contributor-upload") };
    };
    try { button.click(); } finally { window.print = originalPrint; }
    return content;
  });
  expect(print).toEqual({ prompt: true, instructions: true, illustration: false, upload: false });
  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize({ width: 320, height: 740 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(queues.locator("h2")).toHaveText(["Photograph printed pages", "Fill in sample forms", "Write by hand"]);
  await page.getByRole("button", { name: "עברית" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.getByRole("link", { name: "הגדרות" }).click();
  await page.getByRole("button", { name: "התנתקות" }).click();
  await expect(signIn).toBeVisible();
  await expect(page.locator("header.top")).toBeHidden();
  await expect(page.locator("#app .contributor")).toHaveCount(0);
});
