import type { ConfigResponse, MeResponse } from "../../shared/api";
import { post } from "../api";
import { h } from "../dom";
import { lang, t } from "../i18n";

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

/** Sign-in (design SPEC §4.6): one heading, two sentences, Google's own button (not restyled), the policy links. */
export function signInView(config: ConfigResponse, done: (me: MeResponse) => void): DocumentFragment {
  const msg = h("p", { class: "msg", role: "status" });
  const button = h("div", { class: "gsi" });
  const fail = (e: unknown) => {
    msg.textContent = t("signin_failed");
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
        google.accounts.id.renderButton(button, { theme: "outline", size: "large", text: "signin_with", shape: "pill", locale: lang() });
      })
      .catch(fail);
  } else if (!config.devAuth) {
    msg.textContent = t("signin_off");
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
  const page = document.createDocumentFragment();
  page.append(
    h("h1", {}, t("signin_h")),
    h("p", {}, t("signin_p")),
    button,
    ...(dev ? [dev] : []),
    msg,
    h("p", { class: "small muted" }, t("signin_why")),
    h("p", { class: "small" }, h("a", { href: "/privacy" }, t("privacy")), " · ", h("a", { href: "/terms" }, t("terms"))),
  );
  return page;
}
