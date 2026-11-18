import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTACT_EMAIL, PRIVACY_VERSION, TERMS_STATUS, TERMS_VERSION } from "../../src/shared/terms";
import { CONTRIBUTION_LICENCES } from "../../src/tasks/export";

const page = (name: string) => readFileSync(`public/${name}`, "utf8");

describe("public pages (Google branding URLs)", () => {
  it("versions are the approved ones: terms 2026-11-18-v1, privacy 2026-11-18-v3", () => {
    expect(TERMS_VERSION).toBe("2026-11-18-v1");
    expect(PRIVACY_VERSION).toBe("2026-11-18-v3");
  });

  it("home says what it is, who runs it, the contact and the repo, without sign-in or scripts", () => {
    const html = page("index.html");
    expect(html).toContain(TERMS_VERSION);
    expect(html).not.toMatch(/draft|טיוטה/i);
    expect(html).toContain("HeOCR open-source project");
    expect(html).toContain(CONTACT_EMAIL);
    expect(html).toContain("https://github.com/HeOCR/heocr-review");
    expect(html).not.toMatch(/<script/i);
  });

  it.each([
    ["privacy.html", PRIVACY_VERSION],
    ["terms.html", TERMS_VERSION],
  ])("%s is bilingual, shows its approved version, carries no draft marker and has no scripts", (name, version) => {
    const html = page(name);
    expect(html).toContain('lang="he" dir="rtl"');
    expect(html).toContain('lang="en" dir="ltr"');
    expect(TERMS_STATUS).toBe("APPROVED");
    expect(html).not.toMatch(/draft|טיוטה/i);
    expect(html).toContain(version);
    expect(html).toContain(CONTACT_EMAIL);
    expect(html).not.toMatch(/<script/i);
  });

  it("the privacy policy states what the app does", () => {
    const html = page("privacy.html");
    for (const fact of [
      "HMAC-SHA256",
      "__Host-hr_session",
      "No analytics",
      "Cloudflare D1",
      "CC0 1.0",
      "Deletion",
      "do not store",
      "corrections you have not yet confirmed or rejected",
      "תיקונים שעוד לא אישרתם או פסלתם",
    ]) {
      expect(html).toContain(fact);
    }
  });

  it("the deletion item gives the choice for unpublished decisions, in both languages (2026-11-16-v2)", () => {
    const html = page("privacy.html");
    for (const fact of [
      "על ההחלטות שלכם שעוד לא פורסמו תחליטו אתם: למחוק אותן, או להשאיר אותן בלי שום קשר אליכם (בלי כינוי ובלי שם)",
      "אם לא תבחרו, נשאיר אותן בלי קשר אליכם.",
      "החלטה ששימשה כבר בסט הערכה רשום נשארת בכל מקרה, בלי קשר אליכם, כדי שאפשר יהיה לשחזר תוצאות שפורסמו.",
      "For your decisions that are not yet published, you choose: we delete them, or we keep them with no link to you (no pseudonym and no name)",
      "If you don't choose, we keep them with no link to you.",
      "A decision already used in a registered evaluation set stays in any case, with no link to you, so published results can be reproduced.",
      "Decisions already published in public releases stay there, under your pseudonym only.",
      '<a href="mailto:heocrproject@gmail.com" dir="ltr">heocrproject@gmail.com</a>',
      '<a href="mailto:heocrproject@gmail.com">heocrproject@gmail.com</a>',
    ]) {
      expect(html).toContain(fact);
    }
    expect(html).not.toContain("2026-11-16-v1");
    expect(readFileSync("public/index.html", "utf8")).toContain(PRIVACY_VERSION);
  });

  it("the check-lines item says what is compared, who sees it and what stops counting, in both languages (2026-11-18-v3)", () => {
    const html = page("privacy.html");
    for (const fact of [
      "חלק מהשורות הן שורות שהתשובה עליהן ידועה",
      "הדיוק גלוי רק למנהלים ולא מתפרסם",
      "ההחלטות שלכם לא נספרות בהסכמה בין מתנדבים (הן נשמרות, ואפשר לשוב ולהיספר)",
      "some lines have a known answer",
      "It is visible to admins only and never published.",
      "your decisions stop counting toward agreement between volunteers (they are kept, and you can count again)",
    ]) {
      expect(html).toContain(fact);
    }
    // After "Contributions are public", in each language.
    expect(html.indexOf("Check lines")).toBeGreaterThan(html.indexOf("Contributions are public"));
    expect(html.indexOf("שורות בדיקה")).toBeGreaterThan(html.indexOf("התרומות ציבוריות"));
  });

  it("the terms carry the contribution terms", () => {
    const html = page("terms.html");
    for (const fact of ["CC0 1.0", "pseudonym", "No warranty", "suspend or remove accounts"]) expect(html).toContain(fact);
  });

  it("every page and the app link the privacy policy and terms from the footer", () => {
    for (const name of ["index.html", "privacy.html", "terms.html", "404.html", "app/index.html"]) {
      const html = page(name);
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/terms"');
    }
    const consent = readFileSync("src/web/views/terms.ts", "utf8");
    expect(consent).toContain('href: "/terms"');
    expect(consent).toContain('href: "/privacy"');
  });
});

describe("contribution licences", () => {
  it("every terms version names its licence, and the current one is CC0", () => {
    expect(CONTRIBUTION_LICENCES[TERMS_VERSION]).toBe("CC0-1.0");
  });
});
