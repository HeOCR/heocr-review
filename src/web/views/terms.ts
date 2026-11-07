import type { MeResponse } from "../../shared/api";
import { displayNameProblem, MAX_DISPLAY_NAME } from "../../shared/displayName";
import { TERMS_EN, TERMS_HE, TERMS_LICENSE_URL, TERMS_STATUS, TERMS_VERSION, type TermsText } from "../../shared/terms";
import { ApiFailure, post } from "../api";
import { h } from "../dom";

function block(t: TermsText, lang: "he" | "en"): HTMLElement {
  return h("div", { lang, dir: lang === "he" ? "rtl" : "ltr", class: "terms" }, h("h2", {}, t.title), ...t.paragraphs.map((p) => h("p", {}, p)));
}

export function termsView(me: MeResponse, done: (me: MeResponse) => void): HTMLElement {
  const msg = h("p", { class: "msg", role: "status" });
  const optIn = h("input", { type: "checkbox", id: "credit" });
  const name = h("input", { type: "text", maxlength: MAX_DISPLAY_NAME, autocomplete: "nickname", dir: "auto", disabled: true });
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
      msg.textContent = err instanceof ApiFailure ? (err.message ?? err.code) : "שגיאה / error";
    }
  };
  return h(
    "form",
    { class: "card", onsubmit: submit },
    TERMS_STATUS === "DRAFT" ? h("p", { class: "draft", dir: "ltr" }, "DRAFT · טיוטה — terms pending maintainer approval") : null,
    block(TERMS_HE, "he"),
    block(TERMS_EN, "en"),
    h(
      "p",
      { class: "small" },
      h("a", { href: "/terms", target: "_blank" }, "תנאי השימוש / Terms"),
      " · ",
      h("a", { href: "/privacy", target: "_blank" }, "מדיניות הפרטיות / Privacy"),
      " · ",
      h("a", { href: TERMS_LICENSE_URL, rel: "noopener", target: "_blank" }, "CC BY-SA 4.0"),
      " · ",
      h("bdi", { dir: "ltr" }, `terms ${TERMS_VERSION}`),
    ),
    h("p", { class: "muted small" }, "המזהה שלכם / your pseudonym: ", h("bdi", { dir: "ltr" }, me.reviewerId)),
    h("label", { class: "optin" }, optIn, " ", TERMS_HE.creditOptIn, h("span", { class: "muted", lang: "en" }, ` (${TERMS_EN.creditOptIn})`)),
    name,
    h("button", { type: "submit", class: "primary big" }, TERMS_HE.accept, h("span", { lang: "en", class: "sub" }, TERMS_EN.accept)),
    msg,
  );
}
