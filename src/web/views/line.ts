/**
 * The line verification screen (task type line_verify), in the design's layout (design/review SPEC §3, §4.1, §4.2):
 * the line cut from the scan, the candidate under it on the same edges, one slot for rare notices, and every answer in
 * the dock (Exact and Correct it; the rare answers in More, a sheet on a phone and part of the row on a desktop).
 * The page is beside the line on a desktop and a full-screen view on a phone.
 *
 * Rules kept from before: a line is not decided before its image has loaded; a line the agent pre-check flagged is
 * not marked exact before its full page has been seen (on a desktop the page beside it counts, on a phone it has to
 * be opened: linerules.ts); a blind second pass ("type" mode) shows no candidate and is final once saved; a held key
 * never repeats a decision. A decision that fails to save is kept on this device and resent (SPEC §6).
 */
import type { AttentionRun } from "../../shared/attention";
import type { BatchSummary, DecisionOption, LineVerifyView, NextResponse, PageCheckView, Progress, ProposalView } from "../../shared/api";
import { diffText } from "../../shared/diff";
import type { Box, ImageView } from "../../shared/media";
import { visibleTokens } from "../../shared/visible";
import { hasNiqqud } from "../../shared/niqqud";
import { ApiFailure, del, get, post } from "../api";
import { pageScreen } from "./pagecheck";
import { h, mount } from "../dom";
import { lang, t, tRich, type StringKey } from "../i18n";
import { icon, type IconName } from "../icons";
import {
  DESKTOP_QUERY,
  clearDraft,
  dropPending,
  exactNeedsPage,
  failureKind,
  keepPending,
  keepable,
  pendingFor,
  readDraft,
  writeDraft,
} from "../linerules";
import { compare } from "../text";
import { prefetch, type ReviewHooks, type ReviewScreen } from "./common";
import {
  boxedImage,
  contextBand as ctxBand,
  failedNotice,
  markSaving,
  moreButton,
  moreIsOpen,
  pageColumn,
  progressLine,
  renderSaveState as paintSaveState,
  setMoreOpen,
  type Failure,
  type PageColumn,
  type SaveState,
} from "./taskparts";

/** Displayed height of the line's ink, in CSS pixels, per zoom step. */
const LINE_HEIGHTS = [40, 52, 66, 84, 108, 140];
const MAX_SEGMENTS = 4;

/** The smallest ink height (CSS px) at which a line is still read comfortably as one continuous strip. */
export const MIN_LEGIBLE_INK = 18;

/** The line's padded width and ink height in image pixels, as lineStrip cuts it. */
function stripGeometry(img: ImageView, box: Box): { lw: number; lh: number } {
  const lh = Math.max(1, (box[3] - box[1]) * img.height);
  const x0 = Math.max(0, box[0] * img.width - 0.4 * lh);
  const x1 = Math.min(img.width, box[2] * img.width + 0.4 * lh);
  return { lw: Math.max(1, x1 - x0), lh };
}

/**
 * How many pieces to cut the line into. A desktop shows one continuous strip whenever the whole line fits the column
 * at a legible ink height (a split line is read in two halves, which is slower); it splits only when it can't. A phone
 * shows two pieces, or one with "Fit width".
 */
export function stripPieces(img: ImageView, box: Box, width: number, desktop: boolean, fitWidth: boolean): number {
  if (!desktop) return fitWidth ? 1 : 2;
  const { lw, lh } = stripGeometry(img, box);
  return (width * lh) / lw >= MIN_LEGIBLE_INK ? 1 : 2;
}

/**
 * The line, cut from its context crop on the client and shown large. A line too long for the screen at that size
 * is wrapped into stacked pieces (at most `maxPieces`, shrinking the ink height if it must), right piece first
 * (Hebrew reads right to left), with a little overlap so no letter is lost at a cut. Every piece shows the same image
 * file, so the browser fetches it once.
 */
export function lineStrip(img: ImageView, box: Box, inkHeight: number, width: number, onLoad: () => void, maxPieces = MAX_SEGMENTS, label = "השורה בסריקה / the line on the scan"): HTMLElement {
  const W = img.width;
  const H = img.height;
  const lh = Math.max(1, (box[3] - box[1]) * H);
  const padY = 0.22 * lh;
  const padX = 0.4 * lh;
  const x0 = Math.max(0, box[0] * W - padX);
  const x1 = Math.min(W, box[2] * W + padX);
  const y0 = Math.max(0, box[1] * H - padY);
  const y1 = Math.min(H, box[3] * H + padY);
  const lw = x1 - x0;
  const pieceW = Math.max(120, width);
  // Shrink the ink so the line fits in maxPieces at this width ("Fit width" is maxPieces 1).
  const ink = Math.min(inkHeight, (maxPieces * pieceW * lh) / lw);
  const natural = (lw * ink) / lh;
  const n = Math.max(1, Math.min(maxPieces, Math.ceil(natural / pieceW - 1e-9)));
  const overlap = n > 1 ? 0.025 * lw : 0;
  const strip = h("div", { class: "linestrip", dir: "ltr", "aria-label": label, role: "img" });
  let loaded = false;
  const done = () => {
    if (!loaded) {
      loaded = true;
      onLoad();
    }
  };
  for (let k = 0; k < n; k++) {
    const right = Math.min(W, x1 - (k * lw) / n + overlap);
    const left = Math.max(0, x1 - ((k + 1) * lw) / n - overlap);
    const segW = right - left;
    const scale = Math.min(width / segW, ink / lh);
    const image = h("img", { src: img.url, alt: "", decoding: "async", draggable: "false" });
    image.style.cssText = `width:${W * scale}px;left:${-left * scale}px;top:${-y0 * scale}px`;
    if (k === 0) {
      image.addEventListener("load", done);
      image.addEventListener("error", done);
      if (image.complete) queueMicrotask(done);
    }
    const seg = h("div", { class: "seg" }, image);
    seg.style.cssText = `width:${segW * scale}px;height:${(y1 - y0) * scale}px`;
    strip.append(seg);
  }
  return strip;
}

const ATTN_TITLE = {
  ocr: { mark: "מנועי ה-OCR קראו כאן אחרת / OCR engines read this differently", caret: "כאן מנועי ה-OCR קראו תו נוסף / OCR read an extra character here" },
  precheck: { mark: "הבדיקה המוקדמת: בדקו כאן / Pre-check: look here", caret: "הבדיקה המוקדמת: ייתכן שחסר כאן תו / Pre-check: a character may be missing here" },
};

/**
 * The candidate with attention runs marked; odd spaces (doubled, leading, trailing) and invisible characters shown.
 * `from` says who marked the runs: the OCR engines (v1), or the agent pre-check (a flagged v1.1 line).
 */
export function candidateNodes(runs: AttentionRun[], from: keyof typeof ATTN_TITLE = "ocr"): Node[] {
  const titles = ATTN_TITLE[from];
  const chars = Array.from(runs.map((r) => r.text).join(""));
  const odd = chars.map((c, i) => c === " " && (i === 0 || i === chars.length - 1 || chars[i - 1] === " " || chars[i + 1] === " "));
  let at = 0;
  return runs.map((run) => {
    if (run.text === "") return h("span", { class: "caret attn", title: titles.caret }, "‸");
    const inner: Node[] = visibleTokens(run.text).map((tok) => {
      const here = at;
      at += Array.from(tok.raw).length;
      if (tok.kind === "text") return document.createTextNode(tok.shown);
      if (tok.kind === "space") return odd[here] ? h("bdi", { class: "ws", title: tok.label ?? "" }, "␣") : document.createTextNode(" ");
      return h("bdi", { class: "sp", title: tok.label ?? "", dir: /^[⟨]/.test(tok.shown) ? "ltr" : "auto" }, tok.shown);
    });
    return run.attention ? h("mark", { class: "attn", title: titles.mark }, ...inner) : h("span", {}, ...inner);
  });
}

/** The keys of the typing screen's answers without text: [shown, e.code]. */
const TYPING_KEYS: Record<string, [string, string]> = {
  unreadable: ["U", "KeyU"],
  misaligned: ["M", "KeyM"],
  not_one_line: ["J", "KeyJ"],
  no_text: ["T", "KeyT"],
  continued: ["K", "KeyK"],
};

/** The key list behind "?" (SPEC §7, as the code has it). */
const KEY_LIST: [string, StringKey][] = [
  ["Enter · 1", "exact"],
  ["E · 2", "fix"],
  ["N", "niqqud"],
  ["U · 3", "unread"],
  ["M · 4", "misal"],
  ["S · 5", "skip"],
  ["B", "prev"],
  ["+ / − · Z / X", "zoom_in"],
  ["P", "page"],
  ["Esc", "close"],
];

/** The more-sheet answers on the verify screen: [value, label, explanation, icon, key]. */
const MORE: [string, StringKey, StringKey, IconName, string][] = [
  ["pointed_print", "niqqud", "niqqud_sub", "niqqud", "N"],
  ["unreadable", "unread", "unread_sub", "unreadable", "U"],
  ["misaligned", "misal", "misal_sub", "misaligned", "M"],
];

/** `startAt` opens one line first (link #p/<id>); then the queue continues. */
/**
 * `queue` (a triage batch, migrations/0012_triage.sql): "triage" serves lines with a candidate as three answers and no
 * editing (correct, different, niqqud_mismatch), on any screen; "fix" serves the reviewer's "different" lines and the
 * lines without a candidate in the usual screen, on a desktop only (a phone is told how many wait there).
 */
export function lineVerifyView(batch: BatchSummary, hooks: ReviewHooks, startAt?: number, queue?: "triage" | "fix"): ReviewScreen {
  const root = h("div", { class: "taskroot" });
  const desktopMq = matchMedia(DESKTOP_QUERY);
  const history: number[] = [];
  let current: ProposalView | null = null;
  let revisiting = false;
  let progress: Progress = batch.progress;
  let editing: HTMLTextAreaElement | null = null;
  let busy = false;
  let ready = false; // the line's image has loaded: confirming a line nobody could see would be a blind "exact"
  // A desktop starts at the largest ink height, so a long line fills the column as one strip (the zoom buttons step
  // down); a phone starts at its two-piece size.
  let zoom = desktopMq.matches ? LINE_HEIGHTS.length - 1 : 2;
  let fitWidth = false; // phone: the whole line across the width ("Fit width") instead of two pieces
  let pageOpened = false; // phone: the full page was opened on this line
  let failure: Failure | null = null;
  let saveState: SaveState = null;
  let page: PageColumn | null = null;
  let keysOpen = false;

  const view = (): LineVerifyView | null => (current && current.view.kind === "line_verify" ? current.view : null);
  let waiting = batch.triage ?? { triage: 0, fix: 0 };
  let pageDispose: (() => void) | null = null;
  /** This line is answered by triage: the triage queue, pass 1, with a candidate (the server's own test, triage.ts). */
  const triaging = (): boolean => {
    const v = view();
    return queue === "triage" && v !== null && v.pass === 1 && v.candidate !== "";
  };
  const desktop = () => desktopMq.matches;
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const status = (nodes: string | Node[]) => {
    const msg = q(".msg");
    if (msg) msg.replaceChildren(...(typeof nodes === "string" ? [nodes] : nodes));
  };
  const body = document.body.classList;

  async function loadNext(): Promise<void> {
    // The fix queue is the desktop's: a phone is told what waits there instead.
    if (queue === "fix" && !desktop()) return renderFixOnDesktop();
    const res = await get<NextResponse>(`/api/batches/${encodeURIComponent(batch.id)}/next${queue ? `?queue=${queue}` : ""}`);
    if (res.triage) {
      waiting = { triage: res.triage.triage, fix: res.triage.fix };
      paintQueueCounts();
    }
    progress = res.progress;
    prefetch(res.prefetch);
    current = res.proposal;
    revisiting = false;
    failure = null;
    pageDispose?.();
    pageDispose = null;
    if (res.page) renderPage(res.page);
    else if (current) render();
    else renderDone();
  }

  async function open(id: number): Promise<void> {
    const res = await get<{ proposal: ProposalView }>(`/api/proposals/${id}${queue === "triage" ? "?queue=triage" : ""}`);
    current = res.proposal;
    revisiting = true;
    failure = null;
    render();
  }

  /** Errors outside a save (loading a line): the whole screen says so, with a way to try again. */
  function failScreen(err: unknown): void {
    if (err instanceof ApiFailure && err.status === 401) return hooks.signedOut();
    const kind = failureKind(err, navigator.onLine);
    const [title, text] =
      kind === "offline" ? (["e_off_h", "e_off_p"] as const) : kind === "rate_limited" ? (["e_rate_h", "e_rate_p"] as const) : kind === "daily_limit" ? (["e_quota_h", "e_quota_p"] as const) : (["e_srv_h", "e_srv_hint"] as const);
    mount(
      root,
      h(
        "section",
        { class: "state", role: "alert" },
        h("span", { class: "mark" }, icon(kind === "offline" ? "offline" : kind === "rate_limited" ? "clock" : "warning")),
        h("h1", {}, t(title)),
        h("p", { class: "muted" }, t(text)),
        h("div", { class: "stack" }, h("button", { type: "button", class: "act primary", onclick: () => void loadNext().catch(failScreen) }, t("retry"))),
      ),
    );
    console.warn(err);
  }

  /** Post one decision; the terms may need accepting first. */
  async function send(id: number, value: string, text?: string): Promise<void> {
    const payload = text === undefined ? { value } : { value, text };
    try {
      await post(`/api/proposals/${id}/decision`, payload);
    } catch (err) {
      if (!(err instanceof ApiFailure && err.code === "terms_required")) throw err;
      await hooks.needTerms();
      await post(`/api/proposals/${id}/decision`, payload);
    }
  }

  async function act(value: string, text?: string): Promise<void> {
    if (!current || busy) return;
    const v = view();
    if (["exact", "pointed_print", "typed", "correct", "niqqud_mismatch"].includes(value) && !ready) return status(t("img_loading"));
    if ((value === "exact" || value === "correct") && v && exactNeedsPage(Boolean(v.precheck), pageOpened, desktop())) return status(t("flag_phone"));
    busy = true;
    const id = current.id;
    setSaving(value);
    try {
      await send(id, value, text);
      dropPending(id);
      clearDraft(id);
      if (history[history.length - 1] !== id) history.push(id);
      saveState = "saved";
      await loadNext();
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 401) return hooks.signedOut();
      const kind = failureKind(err, navigator.onLine);
      const kept = keepable(kind) && keepPending({ proposalId: id, batchId: batch.id, value, ...(text === undefined ? {} : { text }), keptAt: new Date().toISOString() });
      failure = { kind, kept, value, ...(text === undefined ? {} : { text }), ...(err instanceof ApiFailure && err.message ? { reason: err.message } : {}) };
      saveState = "failed";
      render();
      console.warn(err);
    } finally {
      busy = false;
    }
  }

  /** Resend the decisions kept on this device (a failed save, or one from before a reload), oldest first, once. */
  async function resendKept(): Promise<void> {
    if (busy) return;
    const kept = pendingFor(batch.id);
    if (!kept.length) return;
    busy = true;
    let currentSent = false;
    try {
      for (const p of kept) {
        try {
          await send(p.proposalId, p.value, p.text);
          dropPending(p.proposalId);
          clearDraft(p.proposalId);
          if (current?.id === p.proposalId) currentSent = true;
        } catch (err) {
          if (!keepable(failureKind(err, navigator.onLine))) dropPending(p.proposalId); // the server refused it: drop it
          else break; // still failing: try again on the next chance
        }
      }
    } finally {
      busy = false;
    }
    if (currentSent) {
      saveState = "saved";
      await loadNext().catch(failScreen);
    } else if (!pendingFor(batch.id).length && failure) {
      failure = null;
      saveState = "saved";
      render();
    }
  }

  async function doSkip(): Promise<void> {
    if (!current || busy) return;
    busy = true;
    setSaving("skip");
    try {
      await post(`/api/proposals/${current.id}/skip`);
      history.push(current.id);
      await loadNext();
    } catch (err) {
      busy = false;
      if (err instanceof ApiFailure && err.status === 401) return hooks.signedOut();
      render();
      status(t("e_srv_h"));
      console.warn(err);
    } finally {
      busy = false;
    }
  }

  /** Back to the previous line, where any new decision replaces the one made there (the undo). */
  function back(): void {
    const id = history.pop();
    if (id !== undefined) open(id).catch(failScreen);
  }

  function setSaving(value: string): void {
    markSaving(root, value);
    saveState = "saving";
    renderSaveState();
  }
  const renderSaveState = () => paintSaveState(q(".savestate"), saveState);
  const setMore = (open: boolean) => setMoreOpen(root, open);
  const moreOpen = () => moreIsOpen(root);

  /** Phone: the page full screen; opening it is what a flagged line asks for before "Exact". */
  function setPageOpen(open: boolean): void {
    if (open) page?.open();
    else page?.close();
  }
  const toggleEnlarged = () => page?.toggleEnlarged();

  /** A flagged line: on a phone, "Exact" waits until the page has been opened (SPEC §4.1, §14.3). */
  function updateFlag(): void {
    const v = view();
    const exact = q<HTMLButtonElement>('.dock .act[data-value="exact"]');
    const needs = Boolean(v) && exactNeedsPage(Boolean(v!.precheck), pageOpened, desktop());
    if (exact) {
      if (needs) {
        exact.dataset.needsPage = "";
        exact.setAttribute("aria-describedby", "lv-flag");
      } else {
        delete exact.dataset.needsPage;
        exact.removeAttribute("aria-describedby");
      }
    }
    q(".ctxbox")?.classList.toggle("ask-open", needs);
  }

  // ---------- the crop and the candidate ----------
  function renderStrip(): void {
    const v = view();
    const holder = q(".linebox .strip");
    if (!v || !holder) return;
    if (!v.crop || !v.crop.box) {
      ready = true;
      holder.replaceChildren(h("p", { class: "muted" }, t("no_image")));
      return;
    }
    const width = Math.max(200, holder.clientWidth || root.clientWidth || 360);
    // A phone shows two pieces (or one, "Fit width"); a desktop one strip when it fits, else two.
    const pieces = stripPieces(v.crop, v.crop.box, width, desktop(), fitWidth);
    const strip = lineStrip(v.crop, v.crop.box, LINE_HEIGHTS[zoom]!, width, () => (ready = true), pieces, t("line_on_scan"));
    holder.replaceChildren(strip);
    fitCandidate(strip.children.length);
  }

  /**
   * SPEC §14.7: pick the candidate's size (19–25 px on a phone, 22–31 on a desktop) so it breaks into as many lines as
   * the crop has pieces, when it can: the largest size that does, else the smallest.
   */
  function fitCandidate(pieces: number): void {
    const el = q(".txt.cand");
    if (!el || !el.textContent) return;
    const [lo, hi] = desktop() ? [22, 31] : [19, 25];
    const lines = (px: number) => {
      el.style.fontSize = `${px}px`;
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || px * 1.65;
      const content = el.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      return Math.round(content / lh);
    };
    el.style.minHeight = "0";
    let size = lo;
    for (let px = hi; px >= lo; px--) {
      if (lines(px) <= pieces) {
        size = px;
        break;
      }
    }
    el.style.fontSize = `${size}px`;
    el.style.minHeight = "";
  }

  function setZoom(step: number): void {
    zoom = Math.max(0, Math.min(LINE_HEIGHTS.length - 1, zoom + step));
    renderStrip();
  }

  function setFit(fit: boolean): void {
    fitWidth = fit;
    for (const b of root.querySelectorAll<HTMLButtonElement>(".cropbar button")) b.setAttribute("aria-pressed", String((b.dataset.mode === "fit") === fit));
    renderStrip();
  }

  // ---------- editing ----------
  function closeEditor(): void {
    editing = null;
    body.remove("editing");
    const box = q(".editbox");
    if (box) {
      box.replaceChildren();
      box.hidden = true;
    }
  }

  /** "You changed": the removed text struck through, the inserted text underlined, in one line (SPEC §4.2). */
  function changesLine(from: string, to: string): (Node | string)[] {
    const segs = diffText(from, to).filter((s) => s.op !== "equal");
    if (!segs.length) return [];
    const parts: (Node | string)[] = [];
    for (const s of segs) {
      if (parts.length) parts.push(" ");
      parts.push(s.op === "delete" ? h("del", {}, s.text) : h("ins", {}, s.text));
    }
    return [`${t("changed")} `, h("bdi", { dir: "rtl" }, ...parts)];
  }

  /**
   * The edit box. `asMisaligned` (a v1.2 verify line whose candidate is not this line): a blank box; the decision is
   * misaligned with the line as typed (heocr-eval: every line needs a text, and the count measures the aligner).
   */
  function startEdit(asMisaligned = false): void {
    const v = view();
    if (editing) return editing.focus();
    if (!v || !current) return;
    const typing = v.mode === "type";
    if (typing && current.mine && v.pass === 2) return; // a blind pass is final
    const p = current;
    const box = q(".editbox")!;
    const area = h("textarea", {
      dir: "rtl",
      lang: "he",
      rows: 3,
      spellcheck: "false",
      autocomplete: "off",
      autocapitalize: "off",
      maxlength: 1000,
      "aria-label": asMisaligned || typing ? t("mis_title") : t("edit_title"),
      ...(typing ? { placeholder: t("type_ph") } : {}),
    });
    const mineText = p.mine && ["edited", "pointed_print", "typed", "misaligned"].includes(p.mine.value) && p.mine.text !== null ? p.mine.text : null;
    // "" on a blind pass; a typed line's draft (v.draft) starts the box until the reviewer has saved their own text.
    const start = asMisaligned ? (p.mine?.value === "misaligned" ? (mineText ?? "") : "") : (mineText ?? v.candidate);
    area.value = readDraft(p.id) ?? start;
    const pointed = h("input", { type: "checkbox", id: "lv-pointed" }) as HTMLInputElement;
    pointed.checked = p.mine?.value === "pointed_print";
    const changes = h("p", { class: "changes", role: "status" });
    const preview = h("div", { class: "preview desktop-only" });
    const update = () => {
      // A line is one line: a pasted line break becomes a space.
      if (/[\r\n]/.test(area.value)) area.value = area.value.replace(/[\r\n]+/g, " ");
      writeDraft(p.id, area.value);
      if (typing || asMisaligned) return; // nothing to compare with: the candidate is never sent on a blind pass
      changes.replaceChildren(...changesLine(v.candidate, area.value));
      preview.replaceChildren(compare(v.candidate, area.value, "", "").codes);
    };
    const save = () => {
      const text = area.value;
      if (asMisaligned) {
        if (!text.trim()) return status(t("type_line"));
        if (hasNiqqud(text)) return status(t("type_letters"));
        return void act("misaligned", text);
      }
      if (pointed.checked && hasNiqqud(text)) return status(t("nq_letters"));
      if (typing && hasNiqqud(text)) return status(t("type_letters"));
      if (typing && !text.trim()) return status(t("type_line"));
      void act(typing ? (pointed.checked ? "pointed_print" : "typed") : pointed.checked ? "pointed_print" : "edited", text);
    };
    const cancel = () => {
      clearDraft(p.id);
      closeEditor();
      q<HTMLButtonElement>(".dock .act")?.focus();
    };
    area.addEventListener("input", update);
    area.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      } else if (e.key === "Enter") {
        e.preventDefault(); // no line breaks in a line
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (typing) area.blur();
        else cancel();
      }
    });
    const saveLabel = asMisaligned ? t("mis_save") : typing ? (v.pass === 2 ? t("type_save_final") : t("type_save")) : t("save");
    const drafted = typing && v.draft && !asMisaligned;
    box.replaceChildren(
      ...(asMisaligned ? [h("p", { class: "muted small" }, t("mis_hint"))] : []),
      ...(drafted ? [h("p", { class: "muted small draftnote" }, t("draft_note"))] : []),
      area,
      ...(typing || asMisaligned ? [] : [changes]),
      h(
        "div",
        { class: "edittools" },
        (typing && !drafted) || asMisaligned
          ? null
          : h("button", { type: "button", class: "act quiet", onclick: () => ((area.value = v.candidate), update(), area.focus()) }, icon("reset", { sm: true }), t(drafted ? "draft_reset" : "reset")),
        asMisaligned || v.draftVerification ? null : h("label", { class: "check", for: "lv-pointed" }, pointed, t("nq")),
      ),
      ...(typing || asMisaligned ? [] : [preview]),
      h(
        "div",
        { class: "savebar" },
        h("button", { type: "button", class: "act primary", "data-value": asMisaligned ? "misaligned" : "edited", onclick: save }, h("span", {}, saveLabel), " ", h("kbd", {}, "Ctrl+Enter")),
        typing ? null : h("button", { type: "button", class: "act", onclick: cancel }, t("cancel"), " ", h("kbd", {}, "Esc")),
      ),
    );
    box.hidden = false;
    body.add("editing");
    editing = area;
    update();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  /** Misaligned: with a typed text where the line needs one (v1.2 verify lines), else a verdict alone. */
  function misaligned(): void {
    setMore(false);
    if (current?.options.find((o) => o.value === "misaligned")?.withText) startEdit(true);
    else void act("misaligned");
  }

  // ---------- the screen ----------
  function slotNodes(p: ProposalView, v: LineVerifyView, mine: DecisionOption | undefined): Node[] {
    const out: Node[] = [];
    if (v.precheck) {
      const reasons = v.precheck.reasons.map((r) => r.label[lang()]).join(", ");
      out.push(
        h(
          "p",
          { class: "precheck", id: "lv-flag" },
          icon("flag"),
          h("span", {}, ...tRich("flag", { reasons }), h("span", { class: "block phone-only muted" }, t("flag_phone"))),
        ),
      );
    }
    if (failure) out.push(failedNotice(failure, () => (failure!.kept ? void resendKept() : void act(failure!.value, failure!.text))));
    if (revisiting && mine) {
      const final = v.mode === "type" && v.pass === 2;
      out.push(h("p", { class: "mine" }, t(final ? "mine_final" : "mine", { v: mine.label[lang()] }), p.mine?.text ? ` («${p.mine.text}»)` : "", final ? "" : ` · ${t("mine_replace")}`));
    }
    if (keysOpen) {
      const keys = v.draftVerification ? KEY_LIST.filter(([, key]) => key !== "niqqud" && key !== "unread" && key !== "misal") : KEY_LIST;
      out.push(
        h(
          "div",
          { class: "notice keys-panel", role: "dialog", "aria-label": t("keys_h") },
          icon("conventions"),
          h("div", {}, h("strong", {}, t("keys_h")), h("dl", {}, ...keys.flatMap(([k, s]) => [h("dt", {}, h("kbd", {}, k)), h("dd", {}, t(s))]))),
        ),
      );
    }
    out.push(h("p", { class: "msg", role: "status" }));
    return out;
  }

  function render(): void {
    const p = current!;
    const v = view();
    if (!v) throw new Error(`lineVerifyView cannot show ${p.view.kind}`);
    closeEditor();
    ready = false;
    pageOpened = false;
    keysOpen = false;
    const triage = triaging();
    const typing = v.mode === "type" && !triage;
    body.toggle("typing", typing);
    const option = (value: string) => p.options.find((o) => o.value === value);
    const mine = p.mine ? option(p.mine.value) : undefined;
    hooks.where?.(t("where", { line: v.lineIndex, page: v.pageLabel || "–" }));
    const where = v.pageLabel ? t("src", { book: v.bookTitle, page: v.pageLabel }) : v.bookTitle || p.itemTitle;
    const credit = v.draftVerification && !v.attribution && !v.textLicense
      ? [] : [h("bdi", {}, v.attribution), " · ", `${t("licence")}: `, h("bdi", {}, v.textLicense)];
    page = pageColumn(v.page, where, credit, () => ((pageOpened = true), updateFlag()), () => q<HTMLButtonElement>(".ctxbox .open")?.focus());

    // Triage: three answers, big, and nothing to edit (the maintainer, 2026-11-20).
    const answers = triage
      ? [
          h("button", { type: "button", class: "act primary tri", "data-value": "correct", onclick: () => void act("correct") }, h("span", {}, t("tri_correct")), h("kbd", {}, "1")),
          h("button", { type: "button", class: "act tri", "data-value": "different", onclick: () => void act("different") }, h("span", {}, t("tri_different")), h("kbd", {}, "2")),
          h("button", { type: "button", class: "act tri", "data-value": "niqqud_mismatch", onclick: () => void act("niqqud_mismatch") }, h("span", {}, t(hasNiqqud(v.candidate) ? "tri_no_niqqud" : "niqqud")), h("kbd", {}, "3")),
        ]
      : typing
      ? []
      : [
          h("button", { type: "button", class: "act primary", "data-value": "exact", onclick: () => void act("exact") }, h("span", {}, t("exact")), h("kbd", {}, "Enter")),
          h("button", { type: "button", class: "act", "data-value": "edited", onclick: () => startEdit() }, h("span", {}, t("fix")), h("kbd", {}, "E")),
        ];
    // Triage has the three answers only (no skip, no rarer answers); Back stays.
    const rare = triage
      ? []
      : typing
      ? [
          ...p.options.filter((o) => !o.withText).map((o) => moreButton(o.value, o.label[lang()], null, o.value === "unreadable" ? "unreadable" : o.value === "misaligned" ? "misaligned" : null, TYPING_KEYS[o.value]?.[0] ?? "", () => (setMore(false), void act(o.value)))),
          moreButton("skip", t("skip"), t("skip_sub"), "skip", "S", () => (setMore(false), void doSkip())),
        ]
      : [
          ...MORE.filter(([value]) => option(value)).map(([value, text, sub, ic, key]) =>
            moreButton(value, t(text), t(sub), ic, key, () => (setMore(false), value === "misaligned" ? misaligned() : void act(value))),
          ),
          moreButton("skip", t("skip"), t("skip_sub"), "skip", "S", () => (setMore(false), void doSkip())),
        ];

    const work = h(
      "div",
      { class: `review lineverify${triage ? " triage" : ""}` },
      h("p", { class: "ask" }, typing ? [t("type_ask"), " ", v.pass === 2 ? t("type_ask_final") : t("type_ask_more")] : t("ask")),
      h(
        "div",
        { class: "linebox" },
        h("div", { class: "strip" }),
        h(
          "div",
          { class: "cropbar" },
          h("button", { type: "button", "data-mode": "pieces", "aria-pressed": String(!fitWidth), onclick: () => setFit(false) }, icon("pieces", { sm: true }), t("pieces")),
          h("button", { type: "button", "data-mode": "fit", "aria-pressed": String(fitWidth), onclick: () => setFit(true) }, icon("fit", { sm: true }), t("fit")),
        ),
      ),
      typing ? null : h("div", { class: "txt cand", dir: "rtl", lang: "he" }, ...(v.runs.length ? candidateNodes(v.runs, v.precheck || v.draftVerification ? "precheck" : "ocr") : [v.candidate])),
      triage ? null : h("div", { class: "slot" }, ...slotNodes(p, v, mine)),
      h("div", { class: "editbox", hidden: true }),
      contextBandFor(v),
      h(
        "footer",
        { class: "dock" },
        h("nav", { class: "actions" }, ...answers, h("div", { class: "moregroup", role: "group", "aria-label": t("more") }, ...rare)),
        h(
          "div",
          { class: "subnav" },
          h("button", { type: "button", class: "act quiet", onclick: back, disabled: history.length === 0 }, icon("previous", { sm: true }), t("prev"), " ", h("kbd", {}, "B")),
          h("button", { type: "button", class: "act quiet zoom", "aria-label": t("zoom_out"), onclick: () => setZoom(-1) }, icon("zoom-out", { sm: true }), h("kbd", {}, "−")),
          h("button", { type: "button", class: "act quiet zoom", "aria-label": t("zoom_in"), onclick: () => setZoom(1) }, icon("zoom-in", { sm: true }), h("kbd", {}, "+")),
          revisiting ? h("button", { type: "button", class: "act quiet", onclick: () => void loadNext().catch(failScreen) }, t("to_queue")) : null,
          h("span", { class: "savestate", role: "status" }),
          triage ? null : h("button", { type: "button", class: "act quiet more-btn", "aria-haspopup": "true", "aria-expanded": "false", onclick: () => setMore(!moreOpen()) }, icon("more", { sm: true }), t("more")),
        ),
      ),
      h("div", { class: "scrim", onclick: () => setMore(false) }),
    );
    mount(
      root,
      progressLine(progress),
      h("div", { class: "deck" }, work, page.el),
    );
    renderSaveState();
    updateFlag();
    renderStrip();
    if (typing && (!mine || v.pass !== 2)) startEdit();
    else (q<HTMLButtonElement>(".dock .act.primary") ?? q<HTMLButtonElement>(".dock .act"))?.focus({ preventScroll: true });
  }

  /** The line among its neighbours, with the line in the brand box; on a phone the band opens the page. */
  function contextBandFor(v: LineVerifyView): HTMLElement {
    return ctxBand(v.crop ? boxedImage(v.crop, t("line_ctx")) : null, Boolean(v.page), () => setPageOpen(true));
  }

  /** A page in place of a line (migrations/0014): its completeness check (triage) or its missing lines (desktop). */
  function renderPage(pv: PageCheckView): void {
    closeEditor();
    hooks.where?.(pv.title);
    const base = `/api/batches/${encodeURIComponent(batch.id)}/pages/${pv.itemId}`;
    const after = () => loadNext().catch(failScreen);
    const screen = pageScreen(pv, {
      answer: async (value) => {
        await post(`${base}/check`, { answer: value });
        await after();
      },
      add: async (box, value, text) => {
        try {
          const res = await post<{ id: string }>(`${base}/lines`, { box, value, ...(text === null ? {} : { text }) });
          await after();
          return res.id;
        } catch (err) {
          if (err instanceof ApiFailure && err.status === 400) return null;
          throw err;
        }
      },
      remove: async (id) => {
        await del(`/api/batches/${encodeURIComponent(batch.id)}/added-lines/${id}`);
        await after();
      },
      done: async () => {
        await post(`${base}/done`, {});
        await after();
      },
    });
    pageDispose = screen.dispose;
    mount(root, progressLine(progress), screen.el);
  }

  /** The queue links' counts (main.ts draws them above the screen): kept current after every line. */
  function paintQueueCounts(): void {
    const links = document.querySelectorAll<HTMLAnchorElement>(".batchhead .subsetnav a");
    if (links.length === 2) {
      links[0]!.textContent = t("q_triage", { n: waiting.triage });
      links[1]!.textContent = t("q_fix", { n: waiting.fix });
    }
  }

  /** A phone in the fix queue: the fixes wait for a desktop, and triage goes on here. */
  function renderFixOnDesktop(): void {
    hooks.where?.(null);
    mount(
      root,
      h(
        "section",
        { class: "state" },
        h("span", { class: "mark" }, icon("edit")),
        h("h1", {}, t("fix_phone_h", { n: waiting.fix })),
        h("p", { class: "muted" }, t("fix_phone_p")),
        h("div", { class: "stack" }, h("a", { class: "act primary", href: `#b/${encodeURIComponent(batch.id)}` }, t("to_triage"))),
      ),
    );
  }

  function renderDone(): void {
    hooks.where?.(null);
    mount(
      root,
      h(
        "section",
        { class: "state" },
        h("span", { class: "mark" }, icon("exact")),
        h("h1", {}, t("done_h")),
        h(
          "div",
          { class: "stack" },
          progress.skippedByMe
            ? h("button", { type: "button", class: "act primary", onclick: () => void post(`/api/batches/${encodeURIComponent(batch.id)}/skips/clear`).then(loadNext).catch(failScreen) }, t("done_skips", { n: progress.skippedByMe }))
            : null,
          history.length ? h("button", { type: "button", class: "act", onclick: back }, icon("previous", { sm: true }), t("done_last")) : null,
          queue === "triage" && waiting.fix && desktop() ? h("a", { class: "act", href: `#b/${encodeURIComponent(batch.id)}/q/fix` }, t("q_fix", { n: waiting.fix })) : null,
          h("a", { class: "act quiet", href: "#tasks" }, t("all_tasks")),
        ),
      ),
    );
  }

  /** Esc closes what is open, innermost first: the key list, the sheet, the phone's page, the enlarged page. */
  function escape(): boolean {
    if (keysOpen) {
      keysOpen = false;
      q(".keys-panel")?.remove();
      return true;
    }
    if (moreOpen()) {
      setMore(false);
      return true;
    }
    if (page?.escape()) return true;
    return false;
  }

  function toggleKeys(): void {
    const v = view();
    if (!current || !v) return;
    keysOpen = !keysOpen;
    const slot = q(".slot");
    if (!slot) return;
    q(".keys-panel")?.remove();
    if (keysOpen) {
      const nodes = slotNodes(current, v, undefined);
      const panel = nodes.find((n) => n instanceof HTMLElement && n.classList.contains("keys-panel"));
      if (panel) slot.prepend(panel);
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (e.key === "Escape" && escape()) return e.preventDefault();
    if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
    // A focused button or link handles its own Enter and Space.
    if (target && (target.tagName === "BUTTON" || target.tagName === "A") && (e.key === "Enter" || e.key === " ")) return;
    if (!current || current.view.kind !== "line_verify") return;
    const typing = current.view.mode === "type" && !triaging();
    // Holding a key down must not decide line after line.
    if (e.repeat) return e.preventDefault();
    if (e.key === "?") {
      e.preventDefault();
      return toggleKeys();
    }
    // e.code is the physical key, so the shortcuts work in a Hebrew keyboard layout too.
    // Backspace no longer goes back: a typist's stray press would leave the line (maintainer, 2026-11-19).
    const actions: Record<string, () => void> = {
      Enter: () => void act("exact"),
      NumpadEnter: () => void act("exact"),
      Digit1: () => void act("exact"),
      KeyE: () => startEdit(),
      Digit2: () => startEdit(),
      // e.code: the physical N key, which is מ in a Hebrew layout.
      KeyN: () => void act("pointed_print"),
      KeyU: () => void act("unreadable"),
      Digit3: () => void act("unreadable"),
      KeyM: misaligned,
      Digit4: misaligned,
      KeyS: () => void doSkip(),
      Digit5: () => void doSkip(),
      KeyB: back,
      Equal: () => setZoom(1),
      NumpadAdd: () => setZoom(1),
      KeyZ: () => setZoom(1),
      Minus: () => setZoom(-1),
      NumpadSubtract: () => setZoom(-1),
      KeyX: () => setZoom(-1),
      KeyP: () => (desktop() ? toggleEnlarged() : setPageOpen(!q(".side.open"))),
    };
    // Triage: 1 (or Enter) correct, 2 (or D) different, 3 (or N) the print has niqqud; nothing opens an editor.
    if (triaging()) {
      for (const k of ["KeyE", "KeyU", "KeyM", "Digit4", "KeyS", "Digit5"]) delete actions[k];
      Object.assign(actions, {
        Enter: () => void act("correct"),
        NumpadEnter: () => void act("correct"),
        Digit1: () => void act("correct"),
        Digit2: () => void act("different"),
        KeyD: () => void act("different"),
        Digit3: () => void act("niqqud_mismatch"),
        KeyN: () => void act("niqqud_mismatch"),
      });
    }
    // Typing has no verdict keys: Enter or E goes back to the typing box; the other answers have their own keys.
    else if (current.view.draftVerification) {
      for (const key of ["KeyN", "KeyU", "Digit3", "KeyM", "Digit4"]) delete actions[key];
    } else if (typing) {
      for (const k of ["Enter", "NumpadEnter", "Digit1", "KeyE", "Digit2", "KeyN", "KeyU", "Digit3", "KeyM", "Digit4"]) actions[k] = () => startEdit();
      for (const o of current.options) {
        const key = TYPING_KEYS[o.value];
        if (key) actions[key[1]] = () => void act(o.value);
      }
    }
    const fn = actions[e.code];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderStrip, 120);
  };
  const onLayout = () => {
    // The fix queue opens when the window becomes desktop-sized, and closes when it stops being one.
    if (queue === "fix") return void loadNext().catch(failScreen);
    updateFlag();
    renderStrip();
  };
  const onOnline = () => void resendKept();
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  window.addEventListener("online", onOnline);
  desktopMq.addEventListener("change", onLayout);
  mount(root, h("p", { class: "muted" }, t("loading")));
  // A decision kept from an earlier visit is sent once before the next line is asked for.
  (startAt === undefined ? resendKept().then(loadNext) : open(startAt)).catch(failScreen);
  return {
    el: root,
    dispose: () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("online", onOnline);
      desktopMq.removeEventListener("change", onLayout);
      body.remove("editing", "typing");
      pageDispose?.();
    },
  };
}
