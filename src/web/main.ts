import type { BatchSummary, ConfigResponse, MeResponse } from "../shared/api";
import { ApiFailure, get } from "./api";
import { h, mount } from "./dom";
import { adminView } from "./views/admin";
import { reviewView } from "./views/review";
import { settingsView } from "./views/settings";
import { signInView } from "./views/signin";
import { termsView } from "./views/terms";

const app = document.getElementById("app")!;
const nav = document.getElementById("nav")!;
let config: ConfigResponse;
let me: MeResponse | null = null;
let dispose: (() => void) | null = null;

function show(...nodes: Node[]): void {
  dispose?.();
  dispose = null;
  mount(app, ...nodes);
  window.scrollTo(0, 0);
}

function renderNav(): void {
  if (!me) return nav.replaceChildren();
  const links = [h("a", { href: "#" }, "סקירה")];
  if (me.isAdmin) links.push(h("a", { href: "#admin" }, "ניהול"));
  links.push(h("a", { href: "#settings", title: me.reviewerId }, me.displayName ?? h("bdi", { dir: "ltr" }, me.reviewerId)));
  nav.replaceChildren(...links);
}

function signedIn(next: MeResponse): void {
  me = next;
  renderNav();
  route();
}

function signedOut(): void {
  me = null;
  renderNav();
  show(signInView(config, signedIn));
}

/** The terms changed mid-session: show them over the review, then put the review back as it was. */
function needTerms(): Promise<void> {
  return new Promise((resolve) => {
    const kept = Array.from(app.childNodes);
    mount(
      app,
      termsView(me!, (next) => {
        me = next;
        renderNav();
        mount(app, ...kept);
        resolve();
      }),
    );
  });
}

async function route(): Promise<void> {
  if (!me) return signedOut();
  const hash = location.hash.replace(/^#/, "");
  if (hash === "settings") return show(settingsView(me, (next) => ((me = next), renderNav()), signedOut));
  if (hash === "admin" && me.isAdmin) return show(adminView());
  if (!me.termsCurrent) {
    return show(termsView(me, (next) => signedIn(next)));
  }
  try {
    const { batches } = await get<{ batches: BatchSummary[] }>("/api/batches");
    const linked = /^p\/(\d{1,12})$/.exec(hash);
    const batch = batches.find((b) => b.progress.remainingForMe > 0) ?? batches[0];
    if (!batch) return show(h("section", { class: "card" }, h("p", {}, "אין כרגע משימות פתוחות. / No open tasks right now.")));
    const view = reviewView(batch, { needTerms, signedOut }, linked ? Number(linked[1]) : undefined);
    show(h("h1", { class: "batchtitle" }, batch.title), view.el);
    dispose = view.dispose;
  } catch (err) {
    if (err instanceof ApiFailure && err.status === 401) return signedOut();
    show(h("p", { class: "msg" }, "שגיאה בטעינה. / Failed to load."));
  }
}

async function start(): Promise<void> {
  config = await get<ConfigResponse>("/api/config");
  if (config.environment !== "production") {
    document.body.dataset.env = config.environment;
    document.querySelector(".brand")?.setAttribute("data-env", config.environment);
  }
  try {
    me = await get<MeResponse>("/api/me");
  } catch {
    me = null;
  }
  renderNav();
  window.addEventListener("hashchange", () => void route());
  await route();
}

start().catch(() => show(h("p", { class: "msg" }, "שגיאה בטעינה. / Failed to load.")));
