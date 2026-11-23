/**
 * Per-device preferences (design SPEC §4.6 settings, §14.5): appearance, language and the side of Exact on a phone.
 * Kept in localStorage when the browser allows it; every read and write may fail (private mode, blocked storage),
 * and then the defaults apply. Nothing here reaches the server.
 */
import { setLang, type Lang } from "./i18n";

export type Theme = "system" | "light" | "dark";
export type ExactSide = "start" | "end";
export interface Prefs {
  theme: Theme;
  lang: Lang;
  /** Where Exact sits in the phone dock: "start" (the right in Hebrew) or "end", for left-handed use. */
  exactSide: ExactSide;
}

export const DEFAULT_PREFS: Prefs = { theme: "light", lang: "he", exactSide: "start" };
const KEY = "heocr-review.prefs.v1";
const CONTRIBUTOR_LANGUAGE_KEY = "heocr-review.contributor.language.v1";

type Store = Pick<Storage, "getItem" | "setItem">;
function store(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadPrefs(s: Store | null = store()): Prefs {
  try {
    const raw = s?.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const v = JSON.parse(raw) as Partial<Prefs>;
    return {
      theme: v.theme === "light" || v.theme === "dark" || v.theme === "system" ? v.theme : DEFAULT_PREFS.theme,
      lang: v.lang === "en" ? "en" : "he",
      exactSide: v.exactSide === "end" ? "end" : "start",
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Saves; returns false when the browser would not keep it (the setting still applies until the page is closed). */
export function savePrefs(p: Prefs, s: Store | null = store()): boolean {
  try {
    if (!s) return false;
    s.setItem(KEY, JSON.stringify(p));
    return true;
  } catch {
    return false;
  }
}

export function contributorLanguage(s: Store | null = store()): Lang {
  try {
    return s?.getItem(CONTRIBUTOR_LANGUAGE_KEY) === "en" ? "en" : "he";
  } catch {
    return "he";
  }
}

export function saveContributorLanguage(language: Lang, s: Store | null = store()): void {
  try { s?.setItem(CONTRIBUTOR_LANGUAGE_KEY, language); } catch { /* The current page keeps the chosen language. */ }
}

/** Apply to the page: data-theme on <html> (absent = follow the system), the language, and body.swap. */
export function applyPrefs(p: Prefs, doc: Document = document): void {
  const html = doc.documentElement;
  if (p.theme === "system") html.removeAttribute("data-theme");
  else html.setAttribute("data-theme", p.theme);
  setLang(p.lang, html);
  doc.body.classList.toggle("swap", p.exactSide === "end");
}
