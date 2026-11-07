import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTACT_EMAIL, PRIVACY_VERSION, TERMS_STATUS, TERMS_VERSION } from "../../src/shared/terms";

const page = (name: string) => readFileSync(`public/${name}`, "utf8");

describe("public pages (Google branding URLs)", () => {
  it("versions are the approved 2026-11-07-v1", () => {
    expect(TERMS_VERSION).toBe("2026-11-07-v1");
    expect(PRIVACY_VERSION).toBe("2026-11-07-v1");
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
    for (const fact of ["HMAC-SHA256", "__Host-hr_session", "No analytics", "Cloudflare D1", "CC BY-SA 4.0", "Deletion", "do not store"]) {
      expect(html).toContain(fact);
    }
  });

  it("the terms carry the contribution terms", () => {
    const html = page("terms.html");
    for (const fact of ["CC BY-SA 4.0", "pseudonym", "No warranty", "suspend or remove accounts"]) expect(html).toContain(fact);
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
