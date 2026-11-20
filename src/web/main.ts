import type { BatchSummary, ConfigResponse, MeResponse, ProposalView } from "../shared/api";
import { ApiFailure, get } from "./api";
import { h, mount } from "./dom";
import { lang, t } from "./i18n";
import { icon, mark, type IconName } from "./icons";
import { applyPrefs, loadPrefs, savePrefs, type Prefs } from "./prefs";
import { adminView } from "./views/admin";
import type { ReviewScreen } from "./views/common";
import { lineConsensusView } from "./views/consensus";
import { CONVENTIONS } from "./views/conventions";
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
let prefs: Prefs = loadPrefs();

/**
 * Screens adopted to the design render in main.doc (general pages) or main.task with body.task (task screens: line
 * verification, volunteer lines, reference audit). Page review renders in main.legacy, styled by css/bridge.css,
 * until its design-adoption step (HeOCR/heocr-review#58); admin stays there (desktop only, not adapted: SPEC §9).
 */
type Look = "doc" | "task" | "legacy";
function show(look: Look, ...nodes: Node[]): void {
  dispose?.();
  dispose = null;
  app.className = look;
  document.body.classList.toggle("task", look === "task");
  // The legacy views are Hebrew-first and laid out right to left; they keep that until they are adopted.
  if (look === "legacy") {
    app.lang = "he";
    app.dir = "rtl";
  } else {
    app.removeAttribute("lang");
    app.removeAttribute("dir");
    setWhere(null);
  }
  mount(app, ...nodes);
  window.scrollTo(0, 0);
}

/** The top bar's middle: the open batch's title (isolated: it is document text) and, on a task, where in it. */
let whereTitle: string | null = null;
function setWhere(title: string | null, line: string | null = null): void {
  whereTitle = title;
  where.replaceChildren(...(title ? [h("b", {}, h("bdi", {}, title)), ...(line ? [h("span", {}, line)] : [])] : []));
}

function renderNav(): void {
  const current = location.hash.replace(/^#/, "");
  const link = (href: string, ic: IconName | null, label: string) =>
    h("a", { href: `#${href}`, "aria-label": label, ...(current === href ? { "aria-current": "page" } : {}) }, ic ? icon(ic, { sm: true }) : null, h("span", {}, label));
  if (!me) return nav.replaceChildren(link("conventions", "conventions", t("conv")));
  const links = [link("tasks", "tasks", t("tasks")), link("conventions", "conventions", t("conv"))];
  if (me.isAdmin) links.push(link("admin", null, t("admin")));
  links.push(link("settings", "settings", t("settings")));
  nav.replaceChildren(...links);
}

/** The footer in the interface language (the static page carries both until the app starts). */
function renderFoot(): void {
  const foot = document.getElementById("foot");
  if (!foot) return;
  const sep = () => " · ";
  foot.replaceChildren(
    h("a", { href: "/" }, t("about")),
    sep(),
    h("a", { href: "/privacy" }, t("privacy")),
    sep(),
    h("a", { href: "/terms" }, t("terms")),
    sep(),
    h("a", { href: "https://github.com/HeOCR/heocr-review", rel: "noopener" }, "GitHub"),
    sep(),
    h("span", {}, t("no_analytics")),
  );
}

/** A preference changed in settings: apply it, keep it, and redraw what depends on the language. */
function setPrefs(next: Prefs): void {
  prefs = next;
  savePrefs(prefs);
  applyPrefs(prefs);
  renderNav();
  renderFoot();
}

/** The typing conventions (eval's registered Hebrew sheet: what to type for marks that have no key). */
function conventionsView(): HTMLElement {
  return h(
    "section",
    { class: "card" },
    h("h1", {}, t("conv_h")),
    h("p", {}, t("conv_p")),
    h("dl", { class: "conventions", lang: "he", dir: "rtl" }, ...CONVENTIONS.flatMap(([what, type]) => [h("dt", {}, what), h("dd", {}, type)])),
  );
}

function signedIn(next: MeResponse): void {
  me = next;
  renderNav();
  route();
}

function signedOut(): void {
  me = null;
  renderNav();
  show("doc", signInView(config, signedIn));
}

/** The terms changed mid-session: show them over the review, then put the review back as it was. */
function needTerms(): Promise<void> {
  return new Promise((resolve) => {
    const kept = Array.from(app.childNodes);
    const keptLook = { className: app.className, task: document.body.classList.contains("task") };
    // The terms are a general page: shown in main.doc over the task, which comes back as it was.
    app.className = "doc";
    document.body.classList.remove("task");
    mount(
      app,
      termsView(me!, (next) => {
        me = next;
        renderNav();
        app.className = keptLook.className;
        document.body.classList.toggle("task", keptLook.task);
        mount(app, ...kept);
        resolve();
      }),
    );
  });
}

async function route(): Promise<void> {
  renderNav();
  const hash = location.hash.replace(/^#/, "");
  if (hash === "conventions") return show("doc", conventionsView());
  if (!me) return signedOut();
  if (hash === "settings") return show("doc", settingsView(me, prefs, { changed: (next) => ((me = next), renderNav()), prefsChanged: setPrefs, signedOut }));
  if (hash === "admin" && me.isAdmin) return show("legacy", adminView());
  if (!me.termsCurrent) {
    return show("doc", termsView(me, (next) => signedIn(next)));
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
      if (!batches.length) return show("doc", stateScreen("tasks", t("empty_h"), t("empty_p")));
      return show("doc", picker(batches));
    }
    const subset = chosen?.[2] ? (batch.subsets.find((s) => s.id === chosen[2]) ?? null) : null;
    const hooks = { needTerms, signedOut, where: (line: string | null) => setWhere(whereTitle, line) };
    const startAt = linked ? Number(linked[1]) : undefined;
    const view: ReviewScreen =
      batch.taskType === "page_review"
        ? pageReviewView(batch, hooks, startAt, subset?.id)
        : batch.taskType === "line_consensus"
          ? lineConsensusView(batch, hooks, startAt)
          : (batch.taskType === "line_verify" ? lineVerifyView : reviewView)(batch, hooks, startAt);
    show(batch.taskType === "page_review" ? "legacy" : "task", ...(batch.subsets.length ? [h("div", { class: "batchhead" }, subsetNav(batch, linked ? undefined : (subset?.id ?? "")))] : []), view.el);
    setWhere(batch.title);
    dispose = view.dispose;
  } catch (err) {
    if (err instanceof ApiFailure && err.status === 401) return signedOut();
    show("doc", stateScreen("warning", t("load_failed"), t("e_srv_hint"), true));
  }
}

/** The design's whole-screen state: a framed icon, a title, one sentence, and (on failure) a way to try again. */
function stateScreen(ic: IconName, title: string, text: string, retry = false): HTMLElement {
  return h(
    "section",
    { class: "state" },
    h("span", { class: "mark" }, icon(ic)),
    h("h1", {}, title),
    h("p", { class: "muted" }, text),
    retry ? h("div", { class: "stack" }, h("button", { type: "button", class: "act primary", onclick: () => void route() }, t("retry"))) : null,
  );
}

/** All pages, or one of the batch's subsets ("" = all pages; undefined = a page opened by link). */
function subsetNav(batch: BatchSummary, current: string | undefined): HTMLElement {
  const link = (id: string, label: string) =>
    h("a", { href: id ? `#b/${encodeURIComponent(batch.id)}/s/${encodeURIComponent(id)}` : `#b/${encodeURIComponent(batch.id)}`, ...(current === id ? { "aria-current": "page", class: "on" } : {}) }, label);
  return h(
    "nav",
    { class: "subsetnav small", "aria-label": t("filter") },
    link("", t("all_pages")),
    ...batch.subsets.map((s) => link(s.id, `${s.title} (${s.size})`)),
  );
}

/** Every open batch, the ones with work left for this reviewer first. */
function picker(batches: BatchSummary[]): HTMLElement {
  const sorted = [...batches].sort((a, b) => Number(b.progress.remainingForMe > 0) - Number(a.progress.remainingForMe > 0));
  return h(
    "div",
    { class: "picker" },
    h("h1", {}, t("pick_h")),
    ...sorted.map((b) => {
      const p = b.progress;
      // A volunteer batch shows the volunteer's own count only (nothing about other volunteers' work).
      const own = p.ownOnly === true;
      const pct = !own && p.total ? Math.round((p.covered / p.total) * 100) : 0;
      return h(
        "a",
        { class: "card pick", href: `#b/${encodeURIComponent(b.id)}` },
        h("strong", {}, b.taskLabel[lang()]),
        own
          ? h("span", { class: "count" }, h("strong", { class: "num" }, String(p.decidedByMe)), ` ${t("decided")}`)
          : h("span", { class: "count" }, h("strong", { class: "num" }, String(p.remainingForMe)), ` ${t("remain")}`),
        h(
          "span",
          { class: "meta" },
          h("bdi", {}, b.title),
          b.taskType === "page_review" ? h("span", { class: "tag" }, icon("desktop", { sm: true }), t("on_desktop")) : null,
        ),
        own ? null : h("span", { class: "bar", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct }, h("i", { style: `width:${pct}%` })),
      );
    }),
  );
}

async function start(): Promise<void> {
  applyPrefs(prefs);
  document.querySelector(".top .home")?.append(mark());
  renderFoot();
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

start().catch(() => show("doc", stateScreen("warning", t("load_failed"), t("e_srv_hint"), true)));
