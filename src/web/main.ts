import type { BatchSummary, ConfigResponse, MeResponse, ProposalView } from "../shared/api";
import { ApiFailure, get } from "./api";
import { h, mount } from "./dom";
import { adminView } from "./views/admin";
import type { ReviewScreen } from "./views/common";
import { lineVerifyView } from "./views/line";
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
    const chosen = /^b\/([A-Za-z0-9._-]{1,100})$/.exec(hash);
    let batch: BatchSummary | undefined;
    if (linked) {
      const { proposal } = await get<{ proposal: ProposalView }>(`/api/proposals/${linked[1]}`);
      batch = batches.find((b) => b.id === proposal.batchId);
    } else if (chosen) batch = batches.find((b) => b.id === chosen[1]);
    else if (batches.length === 1) batch = batches[0];
    if (!batch) {
      if (!batches.length) return show(h("section", { class: "card" }, h("p", {}, "אין כרגע משימות פתוחות. / No open tasks right now.")));
      return show(picker(batches));
    }
    const open = batch.taskType === "line_verify" ? lineVerifyView : reviewView;
    const view: ReviewScreen = open(batch, { needTerms, signedOut }, linked ? Number(linked[1]) : undefined);
    show(
      h(
        "div",
        { class: "batchhead" },
        h("h1", { class: "batchtitle" }, batch.title),
        batches.length > 1 ? h("a", { href: "#tasks", class: "small" }, "כל המשימות / All tasks") : null,
      ),
      view.el,
    );
    dispose = view.dispose;
  } catch (err) {
    if (err instanceof ApiFailure && err.status === 401) return signedOut();
    show(h("p", { class: "msg" }, "שגיאה בטעינה. / Failed to load."));
  }
}

/** Every open batch, the ones with work left for this reviewer first. */
function picker(batches: BatchSummary[]): HTMLElement {
  const sorted = [...batches].sort((a, b) => Number(b.progress.remainingForMe > 0) - Number(a.progress.remainingForMe > 0));
  return h(
    "section",
    { class: "picker" },
    h("h1", {}, "בחרו משימה ", h("span", { class: "muted small", lang: "en", dir: "ltr" }, "Choose a task")),
    ...sorted.map((b) =>
      h(
        "a",
        { class: "card pick", href: `#b/${encodeURIComponent(b.id)}` },
        h("strong", {}, b.taskLabel.he),
        h("span", { class: "muted small", lang: "en", dir: "ltr" }, ` ${b.taskLabel.en}`),
        h("span", { class: "small block", dir: "auto" }, b.title),
        h(
          "span",
          { class: "small muted block" },
          `נשארו לך ${b.progress.remainingForMe} · נבדקו ${b.progress.covered} מתוך ${b.progress.total}`,
        ),
      ),
    ),
  );
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
