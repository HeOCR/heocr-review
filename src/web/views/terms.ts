import type { MeResponse } from "../../shared/api";
import { displayNameProblem, MAX_DISPLAY_NAME } from "../../shared/displayName";
import { TERMS_EN, TERMS_HE, TERMS_LICENSE, TERMS_LICENSE_URL, TERMS_VERSION, type TermsText } from "../../shared/terms";
import { ApiFailure, post } from "../api";
import { h } from "../dom";
import { t } from "../i18n";

function block(t: TermsText, lang: "he" | "en"): HTMLElement {
  return h("div", { lang, dir: lang === "he" ? "rtl" : "ltr", class: "terms" }, h("h2", {}, t.title), ...t.paragraphs.map((p) => h("p", {}, p)));
}

export function termsView(me: MeResponse, done: (me: MeResponse) => void): HTMLElement {
  const msg = h("p", { class: "msg", role: "status" });
  const optIn = h("input", { type: "checkbox", id: "credit" });
  const name = h("input", { type: "text", id: "credit-name", maxlength: MAX_DISPLAY_NAME, autocomplete: "nickname", dir: "auto", disabled: true });
  optIn.addEventListener("change", () => {
    name.disabled = !optIn.checked;
    if (optIn.checked) name.focus();
  });
  const submit = async (e: Event) => {
    e.preventDefault();
    const displayName = optIn.checked ? name.value : null;
    if (displayName !== null) {
      const problem = displayNameProblem(displayName);
      if (problem) {
        msg.textContent = problem;
        return;
      }
    }
    try {
      done(await post<MeResponse>("/api/me/terms", { termsVersion: TERMS_VERSION, accept: true, displayName }));
    } catch (err) {
      msg.textContent = err instanceof ApiFailure ? (err.message ?? err.code) : t("error_short");
    }
  };
  // The terms stay bilingual, as approved (maintainer's exception to one language at a time, 2026-11-19): the
  // wording is the approved text, and only the layout follows the design.
  return h(
    "form",
    { class: "termsform", style: "display: contents", onsubmit: submit },
    h("h1", {}, t("terms_h")),
    h("div", { class: "card terms" }, block(TERMS_HE, "he"), block(TERMS_EN, "en")),
    h("p", { class: "small muted" }, `${t("pseud")}: `, h("bdi", { dir: "ltr", class: "mono" }, me.reviewerId)),
    h("label", { class: "check" }, optIn, h("span", {}, h("span", { lang: "he", dir: "rtl" }, TERMS_HE.creditOptIn), " ", h("span", { class: "muted", lang: "en", dir: "ltr" }, `(${TERMS_EN.creditOptIn})`))),
    h("div", { class: "field" }, h("label", { for: "credit-name" }, t("name")), name),
    h("button", { type: "submit", class: "act primary" }, h("span", { lang: "he" }, TERMS_HE.accept), " · ", h("span", { lang: "en" }, TERMS_EN.accept)),
    msg,
    h(
      "p",
      { class: "small" },
      h("a", { href: "/terms", target: "_blank" }, t("terms")),
      " · ",
      h("a", { href: "/privacy", target: "_blank" }, t("privacy")),
      " · ",
      h("a", { href: TERMS_LICENSE_URL, rel: "noopener", target: "_blank" }, TERMS_LICENSE),
      " · ",
      h("bdi", { dir: "ltr", class: "mono" }, `terms ${TERMS_VERSION}`),
    ),
  );
}
