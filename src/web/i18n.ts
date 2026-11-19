/**
 * One interface language at a time (design SPEC §14.2). Strings are [Hebrew, English] in strings.json, keyed as in
 * design/review/strings.json. Text from documents is never translated; batch titles stay as they are.
 */
import STRINGS from "./strings.json";

export type Lang = "he" | "en";
export type StringKey = Exclude<keyof typeof STRINGS, "_note">;

let current: Lang = "he";

export function lang(): Lang {
  return current;
}

/** The string for `key` in the current language, with {name} placeholders filled in. */
export function t(key: StringKey, vars: Record<string, string | number> = {}): string {
  const pair: readonly string[] = STRINGS[key];
  const text = pair[current === "he" ? 0 : 1] ?? pair[0] ?? key;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** Set the language and mirror the page: Hebrew is right to left. */
export function setLang(next: Lang, root: { lang: string; dir: string } = document.documentElement): void {
  current = next;
  root.lang = next;
  root.dir = next === "he" ? "rtl" : "ltr";
}
