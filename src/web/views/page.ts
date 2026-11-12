/**
 * The page review screen (task type page_review): the whole scan beside its pre-filled lines. The reviewer corrects
 * the lines in place; lines flagged "look here" (tier A) must each be looked at (Enter on the line, an edit or an
 * action) before the page can be confirmed. Lines can be marked (print has niqqud, not on the page, unreadable),
 * merged, split, moved and added. A draft is kept in memory (not in browser storage, which the privacy policy does
 * not cover) while the app is open, so going back and forth between pages keeps unsaved corrections.
 *
 * Keys in a line: Enter looked, next flagged line · ↑/↓ previous/next line · Alt+Enter split at the cursor ·
 * Alt+J merge with the next · Alt+N niqqud · Alt+X not on the page · Alt+U unreadable · Alt+↑/↓ move · Alt+A add a line
 * below · Alt+- en dash · Ctrl+Enter confirm the page.
 */
import type { BatchSummary, NextResponse, PageReviewLine, PageReviewView, Progress, ProposalView } from "../../shared/api";
import { hasNiqqud } from "../../shared/niqqud";
import { ApiFailure, get, post } from "../api";
import { h, mount } from "../dom";
import { failureHandler, prefetch, progressBar, type ReviewHooks, type ReviewScreen } from "./common";
import { viewer } from "./viewer";

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
  looked: boolean;
}

interface Draft {
  rows: Row[];
  readingOrder: boolean;
}

const TEXTLESS: Action[] = ["not_on_page", "unreadable"];
const HIDDEN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\u00ad\u200b-\u200d\ufeff]/;

const ACTION_LABEL: Record<Action, string> = {
  correct: "",
  edit: "תוקן",
  print_has_niqqud: "ניקוד בדפוס",
  not_on_page: "לא בעמוד",
  unreadable: "לא קריא",
  merge: "אוחד",
  split: "פוצל",
  added: "נוסף",
};

/** The typing conventions (eval, 2026-11-12): what to type for marks that have no key of their own. */
const CONVENTIONS: [string, string][] = [
  ["מקף ומקף עליון (גם מקף בסוף שורה, כמו שהוא מודפס)", "-"],
  ["קו מפריד בין מילים, עם רווחים", "– (כפתור, או Alt+-)"],
  ["גרש וגרשיים", "' ו־\" מהמקלדת"],
  ["מירכאות מכל צורה („ \" “ ” וגם בודדות)", "\" ו־'"],
  ["שורת נקודות בטבלה או בתוכן עניינים, בכל אורך", "... (שלוש נקודות בדיוק)"],
  ["מספרים ותאריכים", "כמו שמודפס, למשל 18.11.1952"],
  ["סוגריים", "כמו שמקלידים רגיל, (א); לא להעתיק סוגריים הפוכים"],
  ["ניקוד בשורה", "לא מקלידים ניקוד; מסמנים \"ניקוד בדפוס\""],
  ["מילים במרווח (ר ח ב ה)", "בלי המרווחים: רחבה"],
  [
    "הערת שוליים",
    "כשורות נפרדות (שורה לכל שורה מודפסת), מיד לפני השורה שלידה היא עומדת, ולהסיר אותה מהשורה הראשית. חסרה? + שורה (Alt+A, נוספת מתחת) והזזה בכפתורי ↑/↓ (Alt+↑/↓)",
  ],
];

/** Unsaved corrections per page while the app is open (memory only, gone on reload). */
const drafts = new Map<string, Draft>();
let conventionsOpen = true;

function flagText(r: Row): string {
  if (r.mismatch && r.bidiRisk) return "קריאה שונה · ספרות/סוגריים";
  if (r.mismatch) return "קריאה שונה";
  return "ספרות/סוגריים";
}

/** `startAt` opens one page first (link #p/<id>); then the queue continues. */
export function pageReviewView(batch: BatchSummary, hooks: ReviewHooks, startAt?: number): ReviewScreen {
  const root = h("div", { class: "review pagereview" });
  const history: number[] = [];
  let current: ProposalView | null = null;
  let progress: Progress = batch.progress;
  let rows: Row[] = [];
  let readingOrder = false;
  let nextKey = 1;
  let busy = false;
  let ready = false; // the scan has loaded: confirming a page nobody could see would be blind
  const fail = failureHandler(root, hooks);

  const view = (): PageReviewView | null => (current && current.view.kind === "page_review" ? current.view : null);
  const status = (text: string) => {
    const msg = root.querySelector(".msg");
    if (msg) msg.textContent = text;
  };
  const draftKey = () => (current && view() ? `${current.id}:${view()!.prefillSha256}` : null);

  function rowFrom(l: PageReviewLine): Row {
    return { key: nextKey++, src: [l.i], text: l.text, action: "correct", orig: l.text, tierA: l.tierA, bidiRisk: l.bidiRisk, mismatch: l.mismatch, looked: false };
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
    rows = v.lines.map(rowFrom);
  }

  function saveDraft(): void {
    const key = draftKey();
    if (!key || current?.mine) return;
    drafts.set(key, { rows: rows.map((r) => ({ ...r, src: [...r.src] })), readingOrder });
  }

  function dropDraft(id: number, sha: string): void {
    drafts.delete(`${id}:${sha}`);
  }

  async function loadNext(): Promise<void> {
    const res = await get<NextResponse>(`/api/batches/${encodeURIComponent(batch.id)}/next`);
    progress = res.progress;
    prefetch(res.prefetch);
    current = res.proposal;
    if (current) render(false);
    else renderDone();
  }

  async function open(id: number): Promise<void> {
    const res = await get<{ proposal: ProposalView }>(`/api/proposals/${id}`);
    current = res.proposal;
    render(true);
  }

  async function send(value: "confirm" | "reject", body: Record<string, unknown>): Promise<void> {
    if (!current || busy) return;
    busy = true;
    const id = current.id;
    const sha = view()!.prefillSha256;
    const req = { value, text: JSON.stringify(body) };
    try {
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
      fail(err);
    } finally {
      busy = false;
    }
  }

  const pendingA = () => rows.filter((r) => r.tierA && !r.looked);

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
    });
  }

  function rejectPage(): void {
    const reason = (root.querySelector(".rejreason") as HTMLSelectElement | null)?.value ?? "";
    const note = (root.querySelector(".rejnote") as HTMLInputElement | null)?.value.trim() ?? "";
    if (!reason) return status("בחרו סיבה לפסילה. / Choose why the page is rejected.");
    if (reason === "other" && !note) return status("כתבו בקצרה למה. / Say briefly why.");
    void send("reject", { reject_reason: reason, reject_note: note || null });
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
    const r: Row = { key: nextKey++, src: [], text: "", action: "added", orig: null, tierA: false, bidiRisk: false, mismatch: false, looked: true };
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
    renderLines(rows[0]?.key ?? null);
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
    const nextA = rows.slice(k + 1).find((x) => x.tierA && !x.looked) ?? rows.find((x) => x.tierA && !x.looked);
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
    li.classList.toggle("tiera", r.tierA);
    li.classList.toggle("looked", r.looked);
    li.classList.toggle("excluded", TEXTLESS.includes(r.action));
    const chip = li.querySelector(".state") as HTMLElement;
    chip.textContent = ACTION_LABEL[r.action];
    chip.hidden = r.action === "correct";
    chip.dataset.action = r.action;
    const hidden = li.querySelector(".hidden") as HTMLElement;
    hidden.hidden = !HIDDEN.test(r.text);
  }

  function updateSummary(): void {
    const left = pendingA().length;
    const el = root.querySelector(".pending");
    if (el) {
      el.textContent = left
        ? `נשארו ${left} שורות מסומנות לבדיקה (Enter על שורה = נבדקה)`
        : "כל השורות המסומנות נבדקו. עברו על השאר ואשרו את העמוד.";
      el.classList.toggle("ok", left === 0);
    }
    const btn = root.querySelector(".confirmbtn") as HTMLButtonElement | null;
    if (btn) btn.classList.toggle("notyet", left > 0);
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
      "aria-label": `שורה ${n}`,
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
    const tool = (label: string, title: string, fn: () => void) =>
      h("button", { type: "button", class: "small", title, tabindex: "-1", onmousedown: (e: Event) => e.preventDefault(), onclick: fn }, label);
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
          r.tierA ? h("span", { class: "flag", title: "בדקו את השורה הזאת היטב / look closely at this line" }, `בדקו: ${flagText(r)}`) : null,
          h("span", { class: "state" }),
          h("span", { class: "hidden", title: "בשורה יש תו נסתר (סימן כיווניות). אם הוא לא בדפוס, מחקו אותו. / The line holds an invisible character." }, "תו נסתר"),
        ),
        input,
        h(
          "div",
          { class: "tools" },
          tool("✓ נבדקה", "Enter", () => lookedAndNext(r.key)),
          tool("ניקוד בדפוס", "Alt+N", () => toggle(r.key, "print_has_niqqud")),
          tool("לא בעמוד", "Alt+X", () => toggle(r.key, "not_on_page")),
          tool("לא קריא", "Alt+U", () => toggle(r.key, "unreadable")),
          tool("פיצול בסמן", "Alt+Enter", () => splitAt(r.key, input.selectionStart ?? Math.floor(input.value.length / 2))),
          tool("איחוד עם הבאה", "Alt+J", () => mergeNext(r.key)),
          tool("↑", "Alt+↑ הזזה למעלה", () => move(r.key, -1)),
          tool("↓", "Alt+↓ הזזה למטה", () => move(r.key, 1)),
          tool("+ שורה", "Alt+A הוספת שורה מתחת", () => addBelow(r.key)),
          tool("–", "Alt+- קו מפריד", () => insertAtCaret(input, "–")),
          r.action === "added" ? tool("מחיקה", "מחיקת השורה שנוספה", () => removeAdded(r.key)) : null,
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
      h("summary", {}, "כללי הקלדה ", h("span", { class: "muted small", lang: "en", dir: "ltr" }, "Typing conventions")),
      h("p", { class: "small" }, "הקלידו את מה שמודפס. סימנים שאין להם מקש — כתבו בצורת המקלדת:"),
      h("dl", { class: "small" }, ...CONVENTIONS.flatMap(([what, type]) => [h("dt", {}, what), h("dd", { dir: "auto" }, type)])),
    );
    conventions.addEventListener("toggle", () => (conventionsOpen = conventions.open));
    const mine = p.mine;
    mount(
      root,
      progressBar(progress),
      h(
        "article",
        { class: "card proposal" },
        h(
          "header",
          { class: "meta" },
          h("span", { class: "tag", title: v.series.label.en }, v.series.label.he),
          v.period ? h("span", { class: "tag", dir: "ltr" }, v.period) : null,
          v.pass === 2 ? h("span", { class: "tag", title: "Second pass: the page again, from a different pre-fill" }, "מעבר שני") : null,
          v.prefillFromStock ? h("span", { class: "tag conf-medium", title: v.prefillSource }, "טקסט מוכן: Tesseract") : h("span", { class: "tag", title: v.prefillSource }, "טקסט מוכן: שכבת ה-OCR של ה-PDF"),
          h("span", { class: "muted small title", dir: "auto" }, p.itemTitle),
        ),
        conventions,
        h(
          "div",
          { class: "prgrid" },
          h("section", { class: "scan" }, scan ? scan.el : h("p", { class: "muted" }, "אין תמונה לעמוד הזה. / No image for this page.")),
          h(
            "section",
            { class: "lines" },
            h(
              "p",
              { class: "ask" },
              "תקנו כל שורה כך שתהיה בדיוק מה שמודפס, בסדר הקריאה.",
              h("span", { class: "muted small block", lang: "en", dir: "ltr" }, "Correct each line to exactly what is printed, in reading order."),
            ),
            h("p", { class: "pending small", role: "status" }),
            revisiting && mine ? h("p", { class: "mine" }, `ההחלטה שלך: ${mine.value === "confirm" ? "אושר" : "נפסל"} · החלטה חדשה תחליף אותה.`) : null,
            v.lines.length === 0 && rows.length === 0
              ? h("p", { class: "muted" }, "אין לעמוד הזה טקסט מוכן: הקלידו את שורותיו. / No pre-fill for this page: type its lines.")
              : null,
            h("ol", { class: "prlines" }),
            h(
              "div",
              { class: "row" },
              h("button", { type: "button", class: "small", onclick: () => addBelow(null) }, "+ הוספת שורה בסוף"),
              h("button", { type: "button", class: "small", onclick: resetPage }, "חזרה לטקסט המוכן"),
            ),
            v.readingOrderCheck
              ? h(
                  "label",
                  { class: "row check roc" },
                  (() => {
                    const cb = h("input", { type: "checkbox" }) as HTMLInputElement;
                    cb.checked = readingOrder;
                    cb.addEventListener("change", () => {
                      readingOrder = cb.checked;
                      saveDraft();
                    });
                    return cb;
                  })(),
                  " סדר הקריאה נבדק: הטור הימני קודם, וההערות שבשוליים במקומן (הזיזו שורות עם ↑/↓). / Reading order checked: right column first, margin notes in place.",
                )
              : null,
            h(
              "div",
              { class: "row decide" },
              h(
                "button",
                { type: "button", class: "primary confirmbtn", onclick: confirmPage },
                "אישור: השורות, כפי שתוקנו, הן טקסט העמוד בסדר הקריאה ",
                h("kbd", { dir: "ltr" }, "Ctrl+Enter"),
              ),
            ),
            h(
              "details",
              { class: "reject" },
              h("summary", { class: "small" }, "פסילת העמוד (ריק, לא קריא, שגוי) / Reject the page"),
              h(
                "div",
                { class: "row" },
                h("select", { class: "rejreason" }, h("option", { value: "" }, "סיבה…"), ...v.rejectReasons.map((r) => h("option", { value: r.value }, `${r.label.he} / ${r.label.en}`))),
                h("input", { type: "text", class: "rejnote", maxlength: 500, placeholder: "הערה (חובה ב\"אחר\")", dir: "auto" }),
                h("button", { type: "button", onclick: rejectPage }, "פסילה"),
              ),
            ),
            h("p", { class: "msg", role: "status" }),
          ),
        ),
        h(
          "p",
          { class: "attrib muted small" },
          h("bdi", { class: "block", dir: "auto" }, v.attribution),
          h("span", { class: "block" }, "רישיון / Licence: ", h("bdi", { dir: "auto" }, v.textLicense)),
        ),
      ),
      h(
        "div",
        { class: "subnav" },
        h("button", { type: "button", class: "small", onclick: back, disabled: history.length === 0 }, "→ העמוד הקודם (לשינוי ההחלטה)"),
        h("button", { type: "button", class: "small", onclick: () => void doSkip() }, "דילוג על העמוד"),
        revisiting ? h("button", { type: "button", class: "small", onclick: () => void loadNext().catch(fail) }, "לתור ←") : null,
        h(
          "p",
          { class: "keys muted small" },
          "בשורה: ",
          ...(
            [
              ["Enter", "נבדקה, לשורה המסומנת הבאה"],
              ["↑/↓", "שורה קודמת/הבאה"],
              ["Alt+Enter", "פיצול בסמן"],
              ["Alt+J", "איחוד עם הבאה"],
              ["Alt+N", "ניקוד"],
              ["Alt+X", "לא בעמוד"],
              ["Alt+U", "לא קריא"],
              ["Alt+↑/↓", "הזזה"],
              ["Alt+A", "הוספה"],
              ["Ctrl+Enter", "אישור העמוד"],
            ] as const
          ).flatMap(([k, t]) => [h("kbd", { dir: "ltr" }, k), ` ${t} · `]),
        ),
      ),
    );
    watch();
    const firstA = rows.find((r) => r.tierA && !r.looked) ?? null;
    renderLines(null, undefined, false); // nothing changed yet: no draft until the reviewer acts
    if (firstA) focusRow(firstA.key);
  }

  function renderDone(): void {
    mount(
      root,
      progressBar(progress),
      h(
        "section",
        { class: "card done" },
        h("h2", {}, "אין עוד עמודים בשבילך כרגע. תודה רבה!"),
        h("p", { lang: "en", dir: "ltr", class: "muted" }, "No pages left for you right now. Thank you!"),
        h("p", { class: "muted small" }, "עמודי המעבר השני נפתחים יממה אחרי שאישרת את העמוד במעבר הראשון. / Second-pass pages open a day after your first-pass confirm."),
        progress.skippedByMe
          ? h(
              "button",
              { type: "button", onclick: () => void post(`/api/batches/${encodeURIComponent(batch.id)}/skips/clear`).then(loadNext).catch(fail) },
              `חזרה ל-${progress.skippedByMe} העמודים שדילגת עליהם`,
            )
          : null,
        history.length ? h("button", { type: "button", onclick: back }, "→ חזרה להחלטה האחרונה") : null,
        h("p", { class: "msg", role: "status" }),
      ),
    );
  }

  mount(root, h("p", { class: "muted" }, "טוען… / Loading…"));
  (startAt === undefined ? loadNext() : open(startAt)).catch(fail);
  return {
    el: root,
    dispose: () => {},
  };
}
