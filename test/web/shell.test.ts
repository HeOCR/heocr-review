import { afterEach, describe, expect, it } from "vitest";
import STRINGS from "../../src/web/strings.json";
import { lang, setLang, t } from "../../src/web/i18n";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "../../src/web/prefs";

describe("strings (one language at a time)", () => {
  afterEach(() => setLang("he", { lang: "", dir: "" }));

  it("has a Hebrew and an English string for every key", () => {
    for (const [key, value] of Object.entries(STRINGS)) {
      if (key === "_note") continue;
      expect(Array.isArray(value), key).toBe(true);
      const [he, en] = value as string[];
      expect(he?.trim(), key).toBeTruthy();
      expect(en?.trim(), key).toBeTruthy();
    }
  });

  it("returns the current language, fills placeholders and mirrors the page", () => {
    const root = { lang: "", dir: "" };
    setLang("en", root);
    expect(lang()).toBe("en");
    expect(root).toEqual({ lang: "en", dir: "ltr" });
    expect(t("today_line", { n: 12 })).toBe("Today you decided 12 lines.");
    setLang("he", root);
    expect(root).toEqual({ lang: "he", dir: "rtl" });
    expect(t("today_line", { n: 12 })).toBe("היום החלטת על 12 שורות.");
    expect(t("settings")).toBe("הגדרות");
  });
});

describe("preferences (kept on this device only)", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };

  it("defaults to light, Hebrew, and Exact on the start side", () => {
    expect(loadPrefs(memory())).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS).toEqual({ theme: "light", lang: "he", exactSide: "start" });
  });

  it("round-trips through storage", () => {
    const s = memory();
    expect(savePrefs({ theme: "dark", lang: "en", exactSide: "end" }, s)).toBe(true);
    expect(loadPrefs(s)).toEqual({ theme: "dark", lang: "en", exactSide: "end" });
  });

  it("works without storage: blocked, missing, or holding junk", () => {
    expect(loadPrefs(throwing)).toEqual(DEFAULT_PREFS);
    expect(savePrefs(DEFAULT_PREFS, throwing)).toBe(false);
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(savePrefs(DEFAULT_PREFS, null)).toBe(false);
    const junk = memory();
    junk.setItem("heocr-review.prefs.v1", "{not json");
    expect(loadPrefs(junk)).toEqual(DEFAULT_PREFS);
    junk.setItem("heocr-review.prefs.v1", JSON.stringify({ theme: "neon", lang: "fr", exactSide: 3 }));
    expect(loadPrefs(junk)).toEqual(DEFAULT_PREFS);
  });
});
