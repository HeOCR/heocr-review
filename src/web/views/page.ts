/**
 * The page review screen (task type page_review): the whole scan beside its pre-filled lines. The reviewer corrects
 * the lines in place; lines flagged "look here" (eval's tier A, and on the first pass Claude's hints) must each be
 * looked at (Enter on the line, an edit or an action) before the page can be confirmed. A hint never shows Claude's
 * reading, only where to look. Lines can be marked (print has niqqud, not on the page, unreadable),
 * merged, split, moved and added. Unsaved corrections are kept in memory and saved on the server as a draft
 * (debounced, and at once when a line is left), so a reload or another device restores them; nothing goes in browser
 * storage. A draft is not a decision: confirming or rejecting the page deletes it.
 *
 * Keys in a line: Enter looked, next flagged line · ↑/↓ previous/next line · Alt+Enter split at the cursor ·
 * Alt+J merge with the next · Alt+N niqqud · Alt+X not on the page · Alt+U unreadable · Alt+↑/↓ move · Alt+A add a line
 * below · Alt+- en dash · Ctrl+Enter confirm the page.
 */
import type { BatchSummary, NextResponse, PageDraftRow, PageReviewLine, PageReviewView, Progress, ProposalView } from "../../shared/api";
import { hasNiqqud } from "../../shared/niqqud";
import { ApiFailure, del, get, post, put } from "../api";
import { h, mount } from "../dom";
import { lang, t } from "../i18n";
import { icon, type IconName } from "../icons";
import { DESKTOP_QUERY, canDecidePage } from "../linerules";
import { failureHandler, prefetch, type ReviewHooks, type ReviewScreen } from "./common";
import { boxedImage, progressLine, stateScreen } from "./taskparts";
import { viewer } from "./viewer";
import { CONVENTIONS } from "./conventions";

type Action = "correct" | "edit" | "print_has_niqqud" | "not_on_page" | "unreadable" | "merge" | "split" | "added";

interface Row {
  key: number;
  src: number[];
  text: string;
  action: Action;
  /** The pre-fill line this row came from (null for merged and added rows). */
  orig: string | null;
  tierA: boolean;
  bidiRisk: boolean;
  mismatch: boolean;
  /** Claude's hints: its reading differs here; text the pre-fill lacks is next to this line. */
  ai: boolean;
  aiMissing: boolean;
  looked: boolean;
}

/** A row the reviewer must look at before confirming: eval's tier A or one of Claude's hints. */
const mustLook = (r: Row) => r.tierA || r.ai || r.aiMissing;

interface Draft {
  rows: Row[];
  readingOrder: boolean;
}

const TEXTLESS: Action[] = ["not_on_page", "unreadable"];

/** How long typing pauses before the draft is saved (leaving a line saves at once). */
const SAVE_DELAY_MS = 1200;
type SaveState = "idle" | "saving" | "saved" | "failed" | "stale";
const SAVE_LABEL = (state: SaveState): string =>
  ({ idle: "", saving: t("saving"), saved: t("p_draft"), failed: t("p_draft_failed"), stale: t("p_stale") })[state];
const HIDDEN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u00ad\u200b-\u200d\ufeff]/;

const ACTION_LABEL = (a: Action): string =>
  a === "correct" ? "" : t(({ edit: "st_edit", print_has_niqqud: "t_niq", not_on_page: "t_nop", unreadable: "t_unr", merge: "st_merge", split: "st_split", added: "st_added" } as const)[a]);

/** The typing conventions (eval, 2026-11-12): what to type for marks that have no key of their own. */

/** Unsaved corrections per page while the app is open (memory only, gone on reload). */
const drafts = new Map<string, Draft>();
let conventionsOpen = true;

function flagText(r: Row): string {
  return [r.mismatch ? t("p_mismatch") : null, r.bidiRisk || !r.mismatch ? t("digits") : null].filter(Boolean).join(" · ");
}

function aiText(r: Row): string {
  return [r.ai ? t("ai_differs") : null, r.aiMissing ? t("ai_missing") : null].filter(Boolean).join(" · ");
}

/** `startAt` opens one page first (link #p/<id>); then the queue continues. `subset`: serve only that subset's pages. */
export function pageReviewView(batch: BatchSummary, hooks: ReviewHooks, startAt?: number, subset?: string): ReviewScreen {
  const root = h("div", { class: "review pagereview" });
  const history: number[] = [];
  let current: ProposalView | null = null;
  let progress: Progress = batch.progress;
  let rows: Row[] = [];
  let readingOrder = false;
  let nextKey = 1;
  let busy = false;
  // The server draft: the latest unsent one, a timer, and a chain that sends one at a time, in order.
  let pending: { id: number; body: Record<string, unknown> } | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveChain: Promise<void> = Promise.resolve();
  let retryMs = 0;
  let saveState: SaveState = "idle";
  let ready = false; // the scan has loaded: confirming a page nobody could see would be blind
  const fail = failureHandler(root, hooks);

  const view = (): PageReviewView | null => (current && current.view.kind === "page_review" ? current.view : null);
  const status = (text: string) => {
    const msg = root.querySelector(".msg");
    if (msg) msg.textContent = text;
  };
  const draftKey = () => (current && view() ? `${current.id}:${view()!.prefillSha256}` : null);

  function rowFrom(l: PageReviewLine): Row {
    return { key: nextKey++, src: [l.i], text: l.text, action: "correct", orig: l.text, tierA: l.tierA, bidiRisk: l.bidiRisk, mismatch: l.mismatch, ai: l.aiDisagrees, aiMissing: l.aiMissingNear, looked: false };
  }

  /** The rows a page starts with: the reviewer's own decision when revisiting, else their draft, else the pre-fill. */
  function initialRows(p: ProposalView, v: PageReviewView): void {
    const byIndex = new Map(v.lines.map((l) => [l.i, l]));
    readingOrder = false;
    if (p.mine?.value === "confirm" && p.mine.text) {
      try {
        const d = JSON.parse(p.mine.text) as { lines: { i_src: number[]; action: Action; text: string | null }[]; reading_order_verified: boolean | null };
        rows = d.lines.map((r) => {
          const first = byIndex.get(r.i_src[0]!);
          const anyA = r.i_src.some((i) => byIndex.get(i)?.tierA);
          return {
            key: nextKey++,
            src: [...r.i_src],
            text: r.text ?? first?.text ?? "",
            action: r.action,
            orig: r.i_src.length === 1 ? (first?.text ?? null) : null,
            tierA: anyA,
            bidiRisk: r.i_src.some((i) => byIndex.get(i)?.bidiRisk),
            mismatch: r.i_src.some((i) => byIndex.get(i)?.mismatch),
            ai: r.i_src.some((i) => byIndex.get(i)?.aiDisagrees),
            aiMissing: r.i_src.some((i) => byIndex.get(i)?.aiMissingNear),
            looked: true,
          };
        });
        readingOrder = d.reading_order_verified === true;
        return;
      } catch {
        /* fall through to the pre-fill */
      }
    }
    const key = draftKey();
    const draft = key ? drafts.get(key) : undefined;
    if (draft) {
      rows = draft.rows.map((r) => ({ ...r, src: [...r.src], key: nextKey++ }));
      readingOrder = draft.readingOrder;
      return;
    }
    // The draft saved on the server (after a reload, or from another device), made on this same pre-fill.
    const saved = p.draft && p.draft.prefillSha256 === v.prefillSha256 ? p.draft : null;
    if (saved) {
      rows = saved.rows.map((r) => fromDraftRow(r, byIndex));
      readingOrder = saved.readingOrder;
      return;
    }
    rows = v.lines.map(rowFrom);
  }

  function fromDraftRow(r: PageDraftRow, byIndex: Map<number, PageReviewLine>): Row {
    const first = byIndex.get(r.src[0]!);
    const any = (f: (l: PageReviewLine) => boolean) => r.src.some((i) => byIndex.has(i) && f(byIndex.get(i)!));
    return {
      key: nextKey++,
      src: [...r.src],
      text: r.text ?? (r.src.length === 1 ? (first?.text ?? "") : ""),
      action: r.action as Action,
      orig: r.src.length === 1 ? (first?.text ?? null) : null,
      tierA: any((l) => l.tierA),
      bidiRisk: any((l) => l.bidiRisk),
      mismatch: any((l) => l.mismatch),
      ai: any((l) => l.aiDisagrees),
      aiMissing: any((l) => l.aiMissingNear),
      looked: r.looked,
    };
  }

  function saveDraft(): void {
    const key = draftKey();
    if (!key || current?.mine) return;
    drafts.set(key, { rows: rows.map((r) => ({ ...r, src: [...r.src] })), readingOrder });
    queueSave();
  }

  function dropDraft(id: number, sha: string): void {
    drafts.delete(`${id}:${sha}`);
  }

  // --- the server draft ----------------------------------------------------------------------------------------

  function showSave(state: SaveState): void {
    saveState = state;
    const el = root.querySelector(".savestate") as HTMLElement | null;
    if (!el) return;
    el.textContent = SAVE_LABEL(state);
    el.dataset.state = state;
  }

  function draftBody(): Record<string, unknown> {
    return {
      prefillSha256: view()!.prefillSha256,
      readingOrder,
      rows: rows.map((r) => ({ src: r.src, action: r.action, text: TEXTLESS.includes(r.action) || r.action === "correct" ? null : r.text, looked: r.looked })),
    };
  }

  /** Save the current page's draft after a pause in typing. */
  function queueSave(): void {
    if (!current || current.mine || !view()) return;
    pending = { id: current.id, body: draftBody() };
    showSave("saving");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flushSave(), SAVE_DELAY_MS);
  }

  /** Send the latest unsent draft now (one request at a time); a failure is retried with growing pauses. */
  function flushSave(): Promise<void> {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    saveChain = saveChain.then(async () => {
      const job = pending;
      pending = null;
      if (!job) return;
      try {
        await put(`/api/proposals/${job.id}/draft`, job.body);
        retryMs = 0;
        if (!pending && current?.id === job.id) showSave("saved");
      } catch (err) {
        const code = err instanceof ApiFailure ? err.code : "";
        if (code === "stale_draft") {
          if (current?.id === job.id) showSave("stale");
          return;
        }
        if (code === "decided" || code === "not_found" || code === "not_open") return; // nothing left to keep
        pending ??= job;
        retryMs = Math.min(retryMs ? retryMs * 2 : 2000, 30_000);
        if (current?.id === job.id) showSave("failed");
        saveTimer = setTimeout(() => void flushSave(), retryMs);
      }
    });
    return saveChain;
  }

  /** Before a decision on page `id`: its unsent draft is moot, and any save in flight lands first. */
  async function settleSaves(id: number): Promise<void> {
    if (pending?.id === id) {
      pending = null;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
    }
    await saveChain;
  }

  const unsaved = (e: BeforeUnloadEvent) => {
    if (pending || saveState === "saving" || saveState === "failed") e.preventDefault();
  };
  window.addEventListener("beforeunload", unsaved);

  async function loadNext(): Promise<void> {
    await flushSave();
    const res = await get<NextResponse>(`/api/batches/${encodeURIComponent(batch.id)}/next${subset ? `?subset=${encodeURIComponent(subset)}` : ""}`);
    progress = res.progress;
    prefetch(res.prefetch);
    current = res.proposal;
    if (current) render(false);
    else renderDone();
  }

  async function open(id: number): Promise<void> {
    await flushSave();
    const res = await get<{ proposal: ProposalView }>(`/api/proposals/${id}`);
    current = res.proposal;
    render(true);
  }

  async function send(value: "confirm" | "reject", body: Record<string, unknown>): Promise<void> {
    // A phone never decides a page (SPEC §9, §14.6): the hand-off has no decision, and this holds for keys too.
    if (!canDecidePage(matchMedia(DESKTOP_QUERY).matches)) return status(t("pp_title"));
    if (!current || busy) return;
    busy = true;
    const id = current.id;
    const sha = view()!.prefillSha256;
    const req = { value, text: JSON.stringify(body) };
    try {
      await settleSaves(id); // a draft save still in flight must not land after the decision deletes the draft
      try {
        await post(`/api/proposals/${id}/decision`, req);
      } catch (err) {
        if (!(err instanceof ApiFailure && err.code === "terms_required")) throw err;
        await hooks.needTerms();
        await post(`/api/proposals/${id}/decision`, req);
      }
      dropDraft(id, sha);
      if (history[history.length - 1] !== id) history.push(id);
      await loadNext();
    } catch (err) {
      if (current?.id === id && !current.mine) queueSave(); // not decided: keep the draft
      fail(err);
    } finally {
      busy = false;
    }
  }

  const pendingA = () => rows.filter((r) => mustLook(r) && !r.looked);

  function confirmPage(): void {
    const v = view();
    if (!v) return;
    if (!ready) return status("הסריקה עוד נטענת. / The scan is still loading.");
    const left = pendingA();
    if (left.length) {
      focusRow(left[0]!.key);
      return status(`נשארו ${left.length} שורות מסומנות לבדיקה. / ${left.length} flagged line(s) left to look at.`);
    }
    if (!rows.length) return status("אין שורות. הוסיפו את שורות העמוד, או פסלו אותו (עמוד ריק). / No lines: add the page's lines, or reject it as blank.");
    const empty = rows.find((r) => !TEXTLESS.includes(r.action) && r.text.trim() === "");
    if (empty) {
      focusRow(empty.key);
      return status("שורה ריקה: הקלידו אותה, או סמנו \"לא בעמוד\". / An empty line: type it, or mark it not on the page.");
    }
    const pointed = rows.find((r) => r.action === "print_has_niqqud" && hasNiqqud(r.text));
    if (pointed) {
      focusRow(pointed.key);
      return status("בשורה עם \"ניקוד בדפוס\" מקלידים אותיות בלבד, בלי ניקוד. / With print has niqqud, type letters only.");
    }
    if (v.readingOrderCheck && !readingOrder) return status("סמנו שסדר הקריאה נבדק (או פסלו את העמוד). / Confirm the reading order first.");
    void send("confirm", {
      lines: rows.map((r) => ({ src: r.src, action: r.action, text: TEXTLESS.includes(r.action) || r.action === "correct" ? null : r.text })),
      reading_order_verified: v.readingOrderCheck ? true : null,
      ai_flags_sha256: v.aiFlagsSha256,
    });
  }

  function rejectPage(): void {
    const reason = (root.querySelector(".rejreason") as HTMLSelectElement | null)?.value ?? "";
    const note = (root.querySelector(".rejnote") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!reason) return status("בחרו סיבה לפסילה. / Choose why the page is rejected.");
    if (reason === "other" && !note) return status("כתבו בקצרה למה. / Say briefly why.");
    void send("reject", { reject_reason: reason, reject_note: note || null, ai_flags_sha256: view()?.aiFlagsSha256 ?? null });
  }

  async function doSkip(): Promise<void> {
    if (!current || busy) return;
    busy = true;
    try {
      await post(`/api/proposals/${current.id}/skip`);
      history.push(current.id);
      await loadNext();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
  }

  function back(): void {
    const id = history.pop();
    if (id !== undefined) open(id).catch(fail);
  }

  // --- row operations --------------------------------------------------------------------------------------

  const indexOf = (key: number) => rows.findIndex((r) => r.key === key);

  /** A split's pieces move and merge as one group: the consecutive rows split from the same line. */
  function groupAt(k: number): [number, number] {
    const r = rows[k]!;
    if (r.action !== "split") return [k, k];
    let a = k;
    let b = k;
    while (a > 0 && rows[a - 1]!.action === "split" && rows[a - 1]!.src[0] === r.src[0]) a--;
    while (b < rows.length - 1 && rows[b + 1]!.action === "split" && rows[b + 1]!.src[0] === r.src[0]) b++;
    return [a, b];
  }

  function textChanged(r: Row, text: string): void {
    r.text = text;
    r.looked = true;
    if (r.action === "correct" || r.action === "edit") r.action = r.orig !== null && text.trim() === r.orig.trim() ? "correct" : "edit";
  }

  function toggle(key: number, action: "print_has_niqqud" | "not_on_page" | "unreadable"): void {
    const r = rows[indexOf(key)];
    if (!r) return;
    if (r.action === "merge" || r.action === "split" || r.action === "added") {
      if (action !== "print_has_niqqud") return status("שורה מאוחדת, מפוצלת או נוספת: מחקו או בטלו את הפעולה קודם. / Undo the merge, split or addition first.");
    }
    if (r.src.length !== 1 && action === "print_has_niqqud") return status("סמנו ניקוד על שורה אחת. / Mark niqqud on one line.");
    r.looked = true;
    if (r.action === action) r.action = r.orig !== null && r.text.trim() === r.orig.trim() ? "correct" : "edit";
    else r.action = action;
    renderLines(key);
  }

  function mergeNext(key: number): void {
    const k = indexOf(key);
    const cur = rows[k];
    const next = rows[k + 1];
    if (!cur) return;
    if (!next) return status("אין שורה אחרי זו. / There is no next line.");
    if (cur.action === "added" || next.action === "added") return status("אי אפשר לאחד שורה שנוספה; ערכו אותה. / Edit an added line instead of merging it.");
    if ([cur, next].some((r) => TEXTLESS.includes(r.action) || r.action === "print_has_niqqud")) {
      return status("בטלו קודם את הסימון של השורה. / Unmark the line first.");
    }
    const text = `${cur.text.trim()} ${next.text.trim()}`.trim();
    if (cur.action === "split" || next.action === "split") {
      // Joining two pieces of one split line undoes that much of the split.
      if (!(cur.action === "split" && next.action === "split" && cur.src[0] === next.src[0])) {
        return status("חלק של שורה מפוצלת מתאחד רק עם החלקים שלה. / A split piece merges only with its own pieces.");
      }
      // A line split inside a word joins back without the space.
      const tight = `${cur.text.trim()}${next.text.trim()}`;
      const joined: Row = { ...cur, key: nextKey++, text: cur.orig !== null && cur.orig.trim().includes(tight) ? tight : text, looked: true };
      rows.splice(k, 2, joined);
      if (rows.filter((r) => r.action === "split" && r.src[0] === joined.src[0]).length === 1) {
        joined.action = joined.orig !== null && joined.text === joined.orig.trim() ? "correct" : "edit";
      }
      return renderLines(joined.key);
    }
    const joined: Row = {
      key: nextKey++,
      src: [...cur.src, ...next.src],
      text,
      action: "merge",
      orig: null,
      tierA: cur.tierA || next.tierA,
      bidiRisk: cur.bidiRisk || next.bidiRisk,
      mismatch: cur.mismatch || next.mismatch,
      ai: cur.ai || next.ai,
      aiMissing: cur.aiMissing || next.aiMissing,
      looked: true,
    };
    rows.splice(k, 2, joined);
    renderLines(joined.key);
  }

  function splitAt(key: number, caret: number): void {
    const k = indexOf(key);
    const r = rows[k];
    if (!r) return;
    if (r.src.length !== 1 || r.action === "added" || TEXTLESS.includes(r.action) || r.action === "print_has_niqqud") {
      return status("אפשר לפצל רק שורה אחת מהטקסט המוכן. / Only one pre-filled line can be split.");
    }
    const before = r.text.slice(0, caret).trim();
    const after = r.text.slice(caret).trim();
    if (!before || !after) return status("שימו את הסמן במקום שבו השורה נשברת. / Put the cursor where the line breaks.");
    const piece = (text: string): Row => ({ ...r, key: nextKey++, text, action: "split", looked: true });
    const a = piece(before);
    const b = piece(after);
    rows.splice(k, 1, a, b);
    renderLines(b.key, 0);
  }

  function move(key: number, dir: -1 | 1): void {
    const k = indexOf(key);
    if (k < 0) return;
    const [a, b] = groupAt(k);
    if (dir < 0 && a === 0) return;
    if (dir > 0 && b === rows.length - 1) return;
    const [na, nb] = dir < 0 ? groupAt(a - 1) : groupAt(b + 1);
    const mine = rows.slice(a, b + 1);
    const other = rows.slice(na, nb + 1);
    const start = Math.min(a, na);
    rows.splice(start, mine.length + other.length, ...(dir < 0 ? [...mine, ...other] : [...other, ...mine]));
    for (const r of mine) r.looked = true;
    renderLines(key);
  }

  function addBelow(key: number | null): void {
    const k = key === null ? rows.length - 1 : groupAt(indexOf(key))[1];
    const r: Row = { key: nextKey++, src: [], text: "", action: "added", orig: null, tierA: false, bidiRisk: false, mismatch: false, ai: false, aiMissing: false, looked: true };
    rows.splice(k + 1, 0, r);
    renderLines(r.key);
  }

  function removeAdded(key: number): void {
    const k = indexOf(key);
    if (k < 0 || rows[k]!.action !== "added") return;
    const near = rows[k + 1]?.key ?? rows[k - 1]?.key ?? null;
    rows.splice(k, 1);
    renderLines(near);
  }

  function resetPage(): void {
    const v = view();
    if (!v || !confirm("לחזור לטקסט המוכן ולמחוק את התיקונים בעמוד הזה? / Discard this page's corrections?")) return;
    rows = v.lines.map(rowFrom);
    readingOrder = false;
    const key = draftKey();
    if (key) drafts.delete(key);
    const id = current!.id;
    void settleSaves(id)
      .then(() => del(`/api/proposals/${id}/draft`))
      .then(() => showSave("idle"))
      .catch(fail);
    renderLines(rows[0]?.key ?? null, undefined, false);
  }

  function focusRow(key: number | null, caret?: number): void {
    if (key === null) return;
    const input = root.querySelector(`input[data-key="${key}"]`) as HTMLInputElement | null;
    if (!input) return;
    input.focus();
    const at = caret ?? input.value.length;
    input.setSelectionRange(at, at);
    input.closest("li")?.scrollIntoView({ block: "nearest" });
  }

  /** Enter: this line is looked at; on to the next flagged line still to look at, else the next line. */
  function lookedAndNext(key: number): void {
    const k = indexOf(key);
    const r = rows[k];
    if (!r) return;
    r.looked = true;
    updateRow(r);
    const nextA = rows.slice(k + 1).find((x) => mustLook(x) && !x.looked) ?? rows.find((x) => mustLook(x) && !x.looked);
    focusRow(nextA?.key ?? rows[k + 1]?.key ?? null);
    updateSummary();
    saveDraft();
  }

  function insertAtCaret(input: HTMLInputElement, text: string): void {
    const s = input.selectionStart ?? input.value.length;
    const e = input.selectionEnd ?? s;
    input.setRangeText(text, s, e, "end");
    input.dispatchEvent(new Event("input"));
  }

  // --- rendering -------------------------------------------------------------------------------------------

  function updateRow(r: Row): void {
    const li = root.querySelector(`li[data-key="${r.key}"]`) as HTMLElement | null;
    if (!li) return;
    li.classList.toggle("tiera", mustLook(r));
    li.classList.toggle("looked", r.looked);
    li.classList.toggle("excluded", TEXTLESS.includes(r.action));
    const chip = li.querySelector(".state") as HTMLElement;
    chip.textContent = ACTION_LABEL(r.action);
    chip.hidden = r.action === "correct";
    chip.dataset.action = r.action;
    const hidden = li.querySelector(".hidden") as HTMLElement;
    hidden.hidden = !HIDDEN.test(r.text);
  }

  function updateSummary(): void {
    const left = pendingA().length;
    const el = root.querySelector(".pending");
    if (el) {
      el.replaceChildren(icon(left ? "flag" : "exact", { sm: true }), " ", left ? t("p_pending", { n: left }) : t("p_all_looked"));
      el.classList.toggle("ok", left === 0);
    }
    // Confirm waits while flagged lines remain, with the count stated above the list (SPEC §4.5).
    const btn = root.querySelector(".confirmbtn") as HTMLButtonElement | null;
    if (btn) btn.disabled = left > 0;
  }

  function lineEl(r: Row, n: number): HTMLElement {
    const input = h("input", {
      type: "text",
      class: "lt",
      dir: "rtl",
      lang: "he",
      spellcheck: "false",
      autocomplete: "off",
      autocapitalize: "off",
      maxlength: 1000,
      "data-key": r.key,
      "aria-label": t("p_line", { n }),
    }) as HTMLInputElement;
    input.value = r.text;
    input.addEventListener("input", () => {
      if (/[\r\n]/.test(input.value)) input.value = input.value.replace(/[\r\n]+/g, " ");
      textChanged(r, input.value);
      updateRow(r);
      updateSummary();
      saveDraft();
    });
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      const fn = lineKey(e, r, input);
      if (fn) {
        e.preventDefault();
        fn();
      }
    });
    // A line's tools, with their key caps (SPEC §4.5); mousedown keeps the focus in the line.
    const tool = (label: string | Node, key: string, fn: () => void, ic?: IconName, title?: string) =>
      h(
        "button",
        { type: "button", class: "act quiet", tabindex: "-1", ...(title ? { title, "aria-label": title } : {}), onmousedown: (e: Event) => e.preventDefault(), onclick: fn },
        ic ? icon(ic, { sm: true }) : null,
        label,
        key ? h("kbd", {}, key) : null,
      );
    const li = h(
      "li",
      { class: "prline", "data-key": r.key },
      h("span", { class: "num muted", dir: "ltr" }, String(n)),
      h(
        "div",
        { class: "lbody" },
        h(
          "div",
          { class: "lhead" },
          r.tierA ? h("span", { class: "flag" }, icon("flag", { sm: true }), `${t("p_check")}: ${flagText(r)}`) : null,
          r.ai || r.aiMissing ? h("span", { class: "flag ai", title: t("p_ai_title") }, icon("flag", { sm: true }), `${t("p_check")}: ${aiText(r)}`) : null,
          h("span", { class: "state" }),
          h("span", { class: "hidden", title: t("p_hidden_title") }, t("p_hidden")),
        ),
        input,
        h(
          "div",
          { class: "tools" },
          tool(t("p_looked"), "Enter", () => lookedAndNext(r.key), "exact"),
          tool(t("t_niq"), "Alt+N", () => toggle(r.key, "print_has_niqqud"), "niqqud"),
          tool(t("t_nop"), "Alt+X", () => toggle(r.key, "not_on_page"), "not-on-page"),
          tool(t("t_unr"), "Alt+U", () => toggle(r.key, "unreadable"), "unreadable"),
          tool(t("t_split"), "Alt+Enter", () => splitAt(r.key, input.selectionStart ?? Math.floor(input.value.length / 2)), "split"),
          tool(t("t_merge"), "Alt+J", () => mergeNext(r.key), "merge"),
          tool("", "Alt+↑", () => move(r.key, -1), "move-up", t("p_up")),
          tool("", "Alt+↓", () => move(r.key, 1), "move-down", t("p_down")),
          tool(t("t_add"), "Alt+A", () => addBelow(r.key), "add-line"),
          tool("–", "Alt+-", () => insertAtCaret(input, "–"), undefined, t("p_dash")),
          r.action === "added" ? tool(t("p_delete"), "", () => removeAdded(r.key), "close") : null,
        ),
      ),
    );
    return li;
  }

  function lineKey(e: KeyboardEvent, r: Row, input: HTMLInputElement): (() => void) | null {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === "Enter") return confirmPage;
    if (e.altKey) {
      const map: Record<string, () => void> = {
        Enter: () => splitAt(r.key, input.selectionStart ?? 0),
        KeyJ: () => mergeNext(r.key),
        KeyN: () => toggle(r.key, "print_has_niqqud"),
        KeyX: () => toggle(r.key, "not_on_page"),
        KeyU: () => toggle(r.key, "unreadable"),
        ArrowUp: () => move(r.key, -1),
        ArrowDown: () => move(r.key, 1),
        KeyA: () => addBelow(r.key),
        Minus: () => insertAtCaret(input, "–"),
      };
      return map[e.code] ?? null;
    }
    if (mod) return null;
    if (e.key === "Enter") return () => lookedAndNext(r.key);
    const k = indexOf(r.key);
    if (e.key === "ArrowUp") return () => focusRow(rows[k - 1]?.key ?? null);
    if (e.key === "ArrowDown") return () => focusRow(rows[k + 1]?.key ?? null);
    return null;
  }

  function renderLines(focusKey: number | null, caret?: number, save = true): void {
    const list = root.querySelector(".prlines") as HTMLElement | null;
    if (!list) return;
    list.replaceChildren(...rows.map((r, k) => lineEl(r, k + 1)));
    for (const r of rows) updateRow(r);
    updateSummary();
    if (save) saveDraft();
    if (focusKey !== null) focusRow(focusKey, caret);
  }

  function render(revisiting: boolean): void {
    const p = current!;
    const v = view();
    if (!v) throw new Error(`pageReviewView cannot show ${p.view.kind}`);
    ready = false;
    initialRows(p, v);
    const scan = v.page ? viewer(null, v.page) : null;
    const markReady = () => (ready = true);
    if (!v.page) ready = true;
    const watch = () => {
      const i = root.querySelector(".scan img") as HTMLImageElement | null;
      if (!i) return;
      if (i.complete && i.naturalWidth) markReady();
      else {
        i.addEventListener("load", markReady, { once: true });
        i.addEventListener("error", markReady, { once: true });
      }
    };
    const conventions = h(
      "details",
      { class: "conventions", open: conventionsOpen },
      h("summary", {}, t("conv_h_short")),
      h("p", { class: "small" }, t("conv_p")),
      h("dl", { class: "small", lang: "he", dir: "rtl" }, ...CONVENTIONS.flatMap(([what, type]) => [h("dt", {}, what), h("dd", { dir: "auto" }, type)])),
    );
    conventions.addEventListener("toggle", () => (conventionsOpen = conventions.open));
    const mine = p.mine;
    hooks.where?.(p.itemTitle); // the page's own title (document text), under the batch title
    mount(
      root,
      progressLine(progress),
      handoff(p, v),
      h(
        "div",
        { class: "prgrid" },
        h("section", { class: "scan" }, scan ? scan.el : h("p", { class: "muted" }, t("p_no_image"))),
        h(
          "section",
          { class: "lines" },
          h(
            "div",
            { class: "row" },
            h("span", { class: "tag" }, v.series.label[lang()]),
            v.period ? h("span", { class: "tag", dir: "ltr" }, v.period) : null,
            v.pass === 2 ? h("span", { class: "tag" }, t("p_pass2")) : null,
            v.aiFlagsSha256 ? h("span", { class: "tag", title: t("p_ai_title") }, t("p_ai_tag")) : null,
          ),
          conventions,
          h("p", { class: "ask" }, t("p_ask")),
          h("p", { class: "pending", role: "status" }),
          revisiting && mine ? h("p", { class: "mine" }, t("p_mine", { v: mine.value === "confirm" ? t("p_confirmed") : t("p_rejected") })) : null,
          v.lines.length === 0 && rows.length === 0 ? h("p", { class: "muted" }, t("p_no_prefill")) : null,
          h("ol", {
            class: "prlines",
            onfocusout: () => {
              if (pending) void flushSave(); // a line was left: save now
            },
          }),
          h(
            "div",
            { class: "row" },
            h("button", { type: "button", class: "act quiet", onclick: () => addBelow(null) }, icon("add-line", { sm: true }), t("p_add")),
            h("button", { type: "button", class: "act quiet", onclick: resetPage }, icon("reset", { sm: true }), t("p_reset")),
            h("button", { type: "button", class: "act quiet", onclick: () => void doSkip() }, icon("skip", { sm: true }), t("p_skip")),
            h("button", { type: "button", class: "act quiet", onclick: back, disabled: history.length === 0 }, icon("previous", { sm: true }), t("p_prev")),
            revisiting ? h("button", { type: "button", class: "act quiet", onclick: () => void loadNext().catch(fail) }, t("to_queue")) : null,
          ),
          v.readingOrderCheck
            ? h(
                "label",
                { class: "check roc" },
                (() => {
                  const cb = h("input", { type: "checkbox" }) as HTMLInputElement;
                  cb.checked = readingOrder;
                  cb.addEventListener("change", () => {
                    readingOrder = cb.checked;
                    saveDraft();
                  });
                  return cb;
                })(),
                t("p_reading_order"),
              )
            : null,
          h(
            "div",
            { class: "decide" },
            h("button", { type: "button", class: "act primary confirmbtn", onclick: confirmPage }, t("p_confirm"), " ", h("kbd", {}, "Ctrl+Enter")),
            h("span", { class: "savestate", role: "status", "aria-live": "polite" }),
          ),
          h(
            "details",
            { class: "reject" },
            h("summary", {}, t("p_reject")),
            h(
              "div",
              { class: "row" },
              h("select", { class: "rejreason", "aria-label": t("p_reason") }, h("option", { value: "" }, t("p_reason")), ...v.rejectReasons.map((r) => h("option", { value: r.value }, r.label[lang()]))),
              h("input", { type: "text", class: "rejnote", maxlength: 500, placeholder: t("p_note_ph"), dir: "auto" }),
              h("button", { type: "button", class: "act", onclick: rejectPage }, t("p_reject_btn")),
            ),
          ),
          h("p", { class: "msg", role: "status" }),
          h("p", { class: "attrib" }, h("bdi", { dir: "auto" }, v.attribution), " · ", `${t("licence")}: `, h("bdi", { dir: "auto" }, v.textLicense)),
        ),
      ),
    );
    watch();
    const firstA = rows.find((r) => mustLook(r) && !r.looked) ?? null;
    renderLines(null, undefined, false); // nothing changed yet: no draft until the reviewer acts
    showSave(pending?.id === p.id ? saveState : !p.mine && p.draft?.prefillSha256 === v.prefillSha256 ? "saved" : "idle");
    if (firstA) focusRow(firstA.key);
  }

  function renderDone(): void {
    hooks.where?.(null);
    mount(
      root,
      stateScreen(
        "exact",
        subset ? t("p_done_set") : t("p_done"),
        t("p_done_pass2"),
        progress.skippedByMe ? h("button", { type: "button", class: "act primary", onclick: () => void post(`/api/batches/${encodeURIComponent(batch.id)}/skips/clear`).then(loadNext).catch(fail) }, t("p_done_skips", { n: progress.skippedByMe })) : null,
        history.length ? h("button", { type: "button", class: "act", onclick: back }, icon("previous", { sm: true }), t("done_last")) : null,
        h("a", { class: "act quiet", href: "#tasks" }, t("all_tasks")),
      ),
    );
  }

  /**
   * The phone's hand-off (SPEC §9, §14.6): page review is done on a computer. The phone shows why, a link to copy, a
   * way to a line task, and the page with its pre-fill to read. Nothing here can decide or change the page.
   */
  function handoff(p: ProposalView, v: PageReviewView): HTMLElement {
    const link = `${location.origin}${location.pathname}#p/${p.id}`;
    const copy = h("button", { type: "button", class: "act primary" }, icon("copy", { sm: true }), t("pp_copy"));
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(link).then(
        () => toast(t("pp_copied")),
        () => toast(link),
      );
    });
    return h(
      "div",
      { class: "phone-only state handoff" },
      h("span", { class: "mark" }, icon("desktop")),
      h("h2", {}, t("pp_title")),
      h("p", {}, t("pp_body")),
      h("div", { class: "stack" }, copy, h("a", { class: "btn act", href: "#tasks" }, t("pp_lines"))),
      h(
        "details",
        {},
        h("summary", {}, t("pp_view")),
        v.page ? h("div", { class: "ctxbox" }, boxedImage(v.page, p.itemTitle)) : null,
        ...v.lines.map((l) => h("p", { class: "txt", lang: "he", dir: "rtl" }, l.text)),
      ),
    );
  }

  function toast(text: string): void {
    root.querySelector(".toast")?.remove();
    const el = h("div", { class: "toast", role: "status" }, text);
    root.append(el);
    setTimeout(() => el.remove(), 2500);
  }


  mount(root, h("p", { class: "muted" }, "טוען… / Loading…"));
  (startAt === undefined ? loadNext() : open(startAt)).catch(fail);
  return {
    el: root,
    dispose: () => {
      window.removeEventListener("beforeunload", unsaved);
      void flushSave();
    },
  };
}
