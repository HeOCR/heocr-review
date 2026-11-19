import type { BatchSummary, ConfigResponse, MeResponse, ProposalView } from "../shared/api";
import { ApiFailure, get } from "./api";
import { h, mount } from "./dom";
import { icon, mark, type IconName } from "./icons";
import { adminView } from "./views/admin";
import type { ReviewScreen } from "./views/common";
import { lineConsensusView } from "./views/consensus";
import { lineVerifyView } from "./views/line";
import { pageReviewView } from "./views/page";
import { reviewView } from "./views/review";
import { settingsView } from "./views/settings";
import { signInView } from "./views/signin";
import { termsView } from "./views/terms";

const app = document.getElementById("app")!;
const nav = document.getElementById("nav")!;
const where = document.querySelector<HTMLElement>(".top .where")!;
let config: ConfigResponse;
let me: MeResponse | null = null;
let dispose: (() => void) | null = null;

/**
 * The task list and the state screens render in the design's main.doc. Everything else (the task views, sign-in,
 * terms, settings, admin) renders in main.legacy, right to left, styled by css/bridge.css, until its
 * design-adoption step (HeOCR/heocr-review#54-#58; settings and one language with #53's second part).
 */
type Look = "doc" | "legacy";
function show(look: Look, ...nodes: Node[]): void {
  dispose?.();
  dispose = null;
  app.className = look;
  if (look === "legacy") {
    app.lang = "he";
    app.dir = "rtl";
  } else {
    app.removeAttribute("lang");
    app.removeAttribute("dir");
  }
  setWhere(null);
  mount(app, ...nodes);
  window.scrollTo(0, 0);
}

/** The top bar's middle: the open batch's title (isolated: it is document text), or nothing. */
function setWhere(title: string | null): void {
  where.replaceChildren(...(title ? [h("b", {}, h("bdi", {}, title))] : []));
}

function renderNav(): void {
  if (!me) return nav.replaceChildren();
  const current = location.hash.replace(/^#/, "");
  const link = (href: string, ic: IconName | null, label: string | Node, title?: string) =>
    h(
      "a",
      { href: `#${href}`, ...(title ? { title } : {}), ...(current === href ? { "aria-current": "page" } : {}) },
      ic ? icon(ic, { sm: true }) : null,
      h("span", {}, label),
    );
  const links = [link("tasks", "tasks", "סקירה")];
  if (me.isAdmin) links.push(link("admin", null, "ניהול"));
  links.push(link("settings", "settings", me.displayName ?? h("bdi", { dir: "ltr" }, me.reviewerId), me.reviewerId));
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
  show("legacy", signInView(config, signedIn));
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
  renderNav();
  if (!me) return signedOut();
  const hash = location.hash.replace(/^#/, "");
  if (hash === "settings") return show("legacy", settingsView(me, (next) => ((me = next), renderNav()), signedOut));
  if (hash === "admin" && me.isAdmin) return show("legacy", adminView());
  if (!me.termsCurrent) {
    return show("legacy", termsView(me, (next) => signedIn(next)));
  }
  try {
    const { batches } = await get<{ batches: BatchSummary[] }>("/api/batches");
    const linked = /^p\/(\d{1,12})$/.exec(hash);
    // #b/<batch>, or #b/<batch>/s/<subset> to work through one subset of it (a filter on the queue).
    const chosen = /^b\/([A-Za-z0-9._-]{1,100})(?:\/s\/([A-Za-z0-9._-]{1,100}))?$/.exec(hash);
    let batch: BatchSummary | undefined;
    if (linked) {
      const { proposal } = await get<{ proposal: ProposalView }>(`/api/proposals/${linked[1]}`);
      batch = batches.find((b) => b.id === proposal.batchId);
    } else if (chosen) batch = batches.find((b) => b.id === chosen[1]);
    else if (batches.length === 1 && hash !== "tasks") batch = batches[0];
    if (!batch) {
      if (!batches.length) return show("doc", stateScreen("tasks", "אין כרגע משימות פתוחות. / No open tasks right now."));
      return show("doc", picker(batches));
    }
    const subset = chosen?.[2] ? (batch.subsets.find((s) => s.id === chosen[2]) ?? null) : null;
    const hooks = { needTerms, signedOut };
    const startAt = linked ? Number(linked[1]) : undefined;
    const view: ReviewScreen =
      batch.taskType === "page_review"
        ? pageReviewView(batch, hooks, startAt, subset?.id)
        : batch.taskType === "line_consensus"
          ? lineConsensusView(batch, hooks, startAt)
          : (batch.taskType === "line_verify" ? lineVerifyView : reviewView)(batch, hooks, startAt);
    show("legacy", ...(batch.subsets.length ? [h("div", { class: "batchhead" }, subsetNav(batch, linked ? undefined : (subset?.id ?? "")))] : []), view.el);
    setWhere(batch.title);
    dispose = view.dispose;
  } catch (err) {
    if (err instanceof ApiFailure && err.status === 401) return signedOut();
    show("doc", stateScreen("warning", "שגיאה בטעינה. / Failed to load.", true));
  }
}

/** The design's whole-screen state: a framed icon, a title, and (on failure) a way to try again. */
function stateScreen(ic: IconName, title: string, retry = false): HTMLElement {
  return h(
    "section",
    { class: "state" },
    h("span", { class: "mark" }, icon(ic)),
    h("h1", {}, title),
    retry ? h("div", { class: "stack" }, h("button", { type: "button", class: "act primary", onclick: () => void route() }, "שוב / Try again")) : null,
  );
}

/** All pages, or one of the batch's subsets ("" = all pages; undefined = a page opened by link). */
function subsetNav(batch: BatchSummary, current: string | undefined): HTMLElement {
  const link = (id: string, label: string) =>
    h("a", { href: id ? `#b/${encodeURIComponent(batch.id)}/s/${encodeURIComponent(id)}` : `#b/${encodeURIComponent(batch.id)}`, ...(current === id ? { "aria-current": "page", class: "on" } : {}) }, label);
  return h(
    "nav",
    { class: "subsetnav small", "aria-label": "סינון / Filter" },
    link("", "כל העמודים"),
    ...batch.subsets.map((s) => link(s.id, `${s.title} (${s.size})`)),
  );
}

/** Every open batch, the ones with work left for this reviewer first. */
function picker(batches: BatchSummary[]): HTMLElement {
  const sorted = [...batches].sort((a, b) => Number(b.progress.remainingForMe > 0) - Number(a.progress.remainingForMe > 0));
  return h(
    "div",
    { class: "picker" },
    h("h1", {}, "בחרו משימה ", h("span", { class: "muted small", lang: "en", dir: "ltr" }, "Choose a task")),
    ...sorted.map((b) => {
      const p = b.progress;
      // A volunteer batch shows the volunteer's own count only (nothing about other volunteers' work).
      const own = p.ownOnly === true;
      const pct = !own && p.total ? Math.round((p.covered / p.total) * 100) : 0;
      return h(
        "a",
        { class: "card pick", href: `#b/${encodeURIComponent(b.id)}` },
        h("strong", {}, b.taskLabel.he, h("span", { class: "muted small", lang: "en", dir: "ltr" }, ` ${b.taskLabel.en}`)),
        own
          ? h("span", { class: "count" }, h("strong", { class: "num" }, String(p.decidedByMe)), " החלטת / decided")
          : h("span", { class: "count" }, h("strong", { class: "num" }, String(p.remainingForMe)), " נשארו / left"),
        h(
          "span",
          { class: "meta" },
          h("bdi", {}, b.title),
          b.taskType === "page_review" ? h("span", { class: "tag" }, icon("desktop", { sm: true }), "במחשב / On a computer") : null,
        ),
        own ? null : h("span", { class: "bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct }, h("i", { style: `width:${pct}%` })),
      );
    }),
  );
}

async function start(): Promise<void> {
  document.querySelector(".top .home")?.append(mark());
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

start().catch(() => show("doc", stateScreen("warning", "שגיאה בטעינה. / Failed to load.", true)));
