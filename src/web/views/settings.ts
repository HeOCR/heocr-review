import type { MeResponse } from "../../shared/api";
import { displayNameProblem, MAX_DISPLAY_NAME } from "../../shared/displayName";
import { ApiFailure, post } from "../api";
import { h } from "../dom";

export function settingsView(me: MeResponse, changed: (me: MeResponse) => void, signedOut: () => void): HTMLElement {
  const msg = h("p", { class: "msg", role: "status" });
  const name = h("input", { type: "text", maxlength: MAX_DISPLAY_NAME, value: me.displayName ?? "", dir: "auto", autocomplete: "nickname" });
  const consent = h("input", { type: "checkbox" });
  const save = async (displayName: string | null) => {
    try {
      changed(await post<MeResponse>("/api/me/display-name", { displayName, consent: displayName !== null && consent.checked }));
      msg.textContent = "נשמר / saved";
    } catch (err) {
      msg.textContent = err instanceof ApiFailure ? (err.message ?? err.code) : "שגיאה";
    }
  };
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "הגדרות"),
    h("p", {}, "המזהה שלך: ", h("bdi", { dir: "ltr", class: "mono" }, me.reviewerId)),
    h("p", { class: "muted small" }, "כך יופיעו ההחלטות שלך בייצוא, אלא אם בחרת שם תצוגה לקרדיט."),
    h("h3", {}, "קרדיט בשם (רשות)"),
    h("p", {}, me.displayName ? ["שם התצוגה הנוכחי: ", h("bdi", {}, me.displayName)] : "כרגע אין שם תצוגה: הקרדיט הוא בכינוי בלבד."),
    name,
    h("label", { class: "optin" }, consent, " אני מסכים/ה שהשם הזה יופיע כקרדיט לתרומות שלי (CC BY-SA 4.0)."),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          type: "button",
          class: "primary",
          onclick: () => {
            const problem = displayNameProblem(name.value);
            if (problem) msg.textContent = problem;
            else if (!consent.checked) msg.textContent = "יש לסמן הסכמה.";
            else void save(name.value);
          },
        },
        "שמירת שם",
      ),
      me.displayName ? h("button", { type: "button", onclick: () => void save(null) }, "הסרת השם") : null,
    ),
    msg,
    h("hr", {}),
    h("button", { type: "button", onclick: () => void post("/api/auth/logout").then(signedOut, signedOut) }, "התנתקות"),
  );
}
