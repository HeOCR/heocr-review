import type { MeResponse } from "../../shared/api";
import { displayNameProblem, MAX_DISPLAY_NAME } from "../../shared/displayName";
import { ApiFailure, post } from "../api";
import { h } from "../dom";
import { t, type StringKey } from "../i18n";
import { icon } from "../icons";
import type { Prefs } from "../prefs";

export interface SettingsHooks {
  changed(me: MeResponse): void;
  prefsChanged(prefs: Prefs): void;
  signedOut(): void;
}

/** A labelled segmented choice (design `.seg-control`): one button per value, the current one pressed. */
function choice<V extends string>(label: StringKey, options: [V, StringKey][], value: V, pick: (v: V) => void): HTMLElement {
  const lab = h("span", { class: "lab", id: `set-${label}` }, t(label));
  return h(
    "div",
    { class: "field" },
    lab,
    h(
      "div",
      { class: "seg-control", role: "group", "aria-labelledby": `set-${label}` },
      ...options.map(([v, text]) => h("button", { type: "button", "aria-pressed": String(v === value), onclick: () => pick(v) }, t(text))),
    ),
  );
}

/**
 * Settings (design SPEC §4.6): appearance, language and the side of Exact are kept on this device; the named credit
 * is stored on the server, only with the consent below (its wording is the consent statement, unchanged).
 */
export function settingsView(me: MeResponse, prefs: Prefs, hooks: SettingsHooks): HTMLElement {
  const msg = h("p", { class: "msg", role: "status" });
  const name = h("input", { type: "text", id: "set-name", maxlength: MAX_DISPLAY_NAME, value: me.displayName ?? "", dir: "auto", autocomplete: "nickname" });
  const consent = h("input", { type: "checkbox" });
  // display: contents keeps main.doc's column gap between the fields.
  const root = h("div", { class: "settings", style: "display: contents" });
  const render = (p: Prefs) => {
    const set = (next: Partial<Prefs>) => {
      const merged = { ...p, ...next };
      hooks.prefsChanged(merged);
      render(merged);
    };
    root.replaceChildren(
      h("h1", {}, t("set_h")),
      h("p", { class: "small muted" }, `${t("pseud")}: `, h("bdi", { dir: "ltr", class: "mono" }, me.reviewerId)),
      h("p", { class: "small muted" }, t("pseud_note")),
      choice("set_theme", [["system", "th_sys"], ["light", "th_light"], ["dark", "th_night"]], p.theme, (theme) => set({ theme })),
      choice("set_lang", [["he", "lang_he"], ["en", "lang_en"]], p.lang, (lang) => set({ lang })),
      // "start" is the right in Hebrew and the left in English: the labels name the physical side.
      choice("set_side", p.lang === "he" ? [["start", "side_r"], ["end", "side_l"]] : [["end", "side_r"], ["start", "side_l"]], p.exactSide, (exactSide) => set({ exactSide })),
      credit(),
      h("div", { class: "row" }, h("button", { type: "button", class: "act", onclick: () => void post("/api/auth/logout").then(hooks.signedOut, hooks.signedOut) }, icon("sign-out"), t("signout"))),
    );
  };
  const save = async (displayName: string | null) => {
    try {
      const next = await post<MeResponse>("/api/me/display-name", { displayName, consent: displayName !== null && consent.checked });
      me = next;
      hooks.changed(next);
      msg.textContent = t("saved_short");
    } catch (err) {
      msg.textContent = err instanceof ApiFailure ? (err.message ?? err.code) : t("error_short");
    }
  };
  const credit = () =>
    h(
      "div",
      { class: "card" },
      h("h3", {}, t("set_credit")),
      h("p", { class: "small muted" }, me.displayName ? [`${t("credit_now")} `, h("bdi", {}, me.displayName)] : t("set_credit_p")),
      h("div", { class: "field" }, h("label", { for: "set-name" }, t("name")), name),
      h("label", { class: "check" }, consent, " ", t("credit_consent")),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            type: "button",
            class: "act primary",
            onclick: () => {
              const problem = displayNameProblem(name.value);
              if (problem) msg.textContent = problem;
              else if (!consent.checked) msg.textContent = t("consent_needed");
              else void save(name.value);
            },
          },
          t("set_save"),
        ),
        me.displayName ? h("button", { type: "button", class: "act", onclick: () => void save(null) }, t("credit_remove")) : null,
      ),
      msg,
    );
  render(prefs);
  return root;
}
