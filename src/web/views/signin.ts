import type { ConfigResponse, MeResponse } from "../../shared/api";
import { post } from "../api";
import { h } from "../dom";

const GIS_SRC = "https://accounts.google.com/gsi/client";

interface Gis {
  accounts: {
    id: {
      initialize(opts: Record<string, unknown>): void;
      renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
      disableAutoSelect(): void;
    };
  };
}

function loadGis(): Promise<Gis> {
  const w = window as unknown as { google?: Gis };
  if (w.google?.accounts?.id) return Promise.resolve(w.google);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => (w.google ? resolve(w.google) : reject(new Error("gis")));
    s.onerror = () => reject(new Error("gis"));
    document.head.append(s);
  });
}

export function signInView(config: ConfigResponse, done: (me: MeResponse) => void): HTMLElement {
  const msg = h("p", { class: "msg", role: "status" });
  const button = h("div", { class: "gsi" });
  const fail = (e: unknown) => {
    msg.textContent = "ההתחברות נכשלה. נסו שוב. / Sign-in failed, please try again.";
    console.warn(e);
  };
  if (config.googleClientId) {
    loadGis()
      .then((google) => {
        google.accounts.id.initialize({
          client_id: config.googleClientId,
          ux_mode: "popup",
          context: "signin",
          itp_support: true,
          use_fedcm_for_button: true,
          callback: (resp: { credential?: string }) => {
            if (!resp.credential) return fail("no credential");
            post<MeResponse>("/api/auth/google", { credential: resp.credential }).then(done, fail);
          },
        });
        google.accounts.id.renderButton(button, { theme: "outline", size: "large", text: "signin_with", shape: "pill", locale: "he" });
      })
      .catch(fail);
  } else if (!config.devAuth) {
    msg.textContent = "ההתחברות עדיין לא הוגדרה. / Sign-in is not configured yet.";
  }
  let dev: HTMLElement | null = null;
  if (config.devAuth) {
    const input = h("input", { type: "text", value: "dev-1", dir: "ltr", "aria-label": "dev subject", autocomplete: "off" });
    dev = h(
      "form",
      {
        class: "dev",
        onsubmit: (e: Event) => {
          e.preventDefault();
          post<MeResponse>("/api/auth/dev", { subject: input.value }).then(done, fail);
        },
      },
      h("strong", {}, "DEV sign-in (local only) "),
      input,
      h("button", { type: "submit" }, "Sign in"),
    );
  }
  return h(
    "section",
    { class: "card intro" },
    h("h1", {}, "HeOCR Review"),
    h("p", {}, "עוזרים לשפר זיהוי טקסט עברי: בודקים הצעות לתיקון מול סריקות של דפים מודפסים."),
    h("p", { dir: "ltr", lang: "en", class: "muted" }, "Help Hebrew OCR: check proposed text corrections against scans of printed pages."),
    button,
    dev,
    msg,
    h(
      "p",
      { class: "muted small" },
      "ההתחברות דרך גוגל משמשת רק לזיהוי קבוע. איננו שומרים דוא״ל או שם, ואין באתר אנליטיקה. ",
      h("a", { href: "/privacy" }, "מדיניות הפרטיות"),
      " · ",
      h("a", { href: "/terms" }, "תנאי השימוש"),
    ),
  );
}
