/**
 * The line verification screen (task type line_verify): one printed line at a time, shown large, under it a
 * smaller context band, then the candidate transcription in large RTL type with the attention spans marked.
 * Keyboard first: Enter exact, E edit, U unreadable, M misaligned, S skip, B back; every key has a button.
 */
import type { AttentionRun } from "../../shared/attention";
import type { BatchSummary, LineVerifyView, NextResponse, Progress, ProposalView } from "../../shared/api";
import type { Box, ImageView } from "../../shared/media";
import { visibleTokens } from "../../shared/visible";
import { ApiFailure, get, post } from "../api";
import { h, mount } from "../dom";
import { compare } from "../text";
import { failureHandler, prefetch, progressBar, type ReviewHooks, type ReviewScreen } from "./common";
import { viewer } from "./viewer";

/** Displayed height of the line's ink, in CSS pixels, per zoom step. */
const LINE_HEIGHTS = [40, 52, 66, 84, 108, 140];
const MAX_SEGMENTS = 4;

/**
 * The line, cut from its context crop on the client and shown large. A line too long for the screen at that size
 * is wrapped into up to four stacked pieces, right piece first (Hebrew reads right to left), with a little overlap
 * so no letter is lost at a cut. Every piece shows the same image file, so the browser fetches it once.
 */
function lineStrip(img: ImageView, box: Box, inkHeight: number, width: number, onLoad: () => void): HTMLElement {
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
  const natural = (lw * inkHeight) / lh;
  const n = Math.max(1, Math.min(MAX_SEGMENTS, Math.ceil(natural / Math.max(120, width))));
  const overlap = n > 1 ? 0.025 * lw : 0;
  const strip = h("div", { class: "linestrip", dir: "ltr", "aria-label": "השורה בסריקה / the line on the scan", role: "img" });
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
    const scale = Math.min(width / segW, inkHeight / lh);
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

/** The candidate with attention runs marked; odd spaces (doubled, leading, trailing) and invisible characters shown. */
function candidateNodes(runs: AttentionRun[]): Node[] {
  const chars = Array.from(runs.map((r) => r.text).join(""));
  const odd = chars.map((c, i) => c === " " && (i === 0 || i === chars.length - 1 || chars[i - 1] === " " || chars[i + 1] === " "));
  let at = 0;
  return runs.map((run) => {
    if (run.text === "") return h("span", { class: "caret attn", title: "כאן מנועי ה-OCR קראו תו נוסף / OCR read an extra character here" }, "‸");
    const inner: Node[] = visibleTokens(run.text).map((t) => {
      const here = at;
      at += Array.from(t.raw).length;
      if (t.kind === "text") return document.createTextNode(t.shown);
      if (t.kind === "space") return odd[here] ? h("bdi", { class: "ws", title: t.label ?? "" }, "␣") : document.createTextNode(" ");
      return h("bdi", { class: "sp", title: t.label ?? "", dir: /^[⟨]/.test(t.shown) ? "ltr" : "auto" }, t.shown);
    });
    return run.attention ? h("mark", { class: "attn", title: "מנועי ה-OCR קראו כאן אחרת / OCR engines read this differently" }, ...inner) : h("span", {}, ...inner);
  });
}

const KEYS: [string, string, string][] = [
  ["Enter", "מדויק", "exact"],
  ["E", "עריכה", "edit"],
  ["U", "לא קריא", "unreadable"],
  ["M", "לא תואם", "misaligned"],
  ["S", "דילוג", "skip"],
  ["B", "הקודם", "back"],
  ["+/−", "זום", "zoom"],
  ["P", "עמוד מלא", "page"],
];

/** `startAt` opens one line first (link #p/<id>); then the queue continues. */
export function lineVerifyView(batch: BatchSummary, hooks: ReviewHooks, startAt?: number): ReviewScreen {
  const root = h("div", { class: "review lineverify" });
  const history: number[] = [];
  let current: ProposalView | null = null;
  let progress: Progress = batch.progress;
  let editing: HTMLTextAreaElement | null = null;
  let busy = false;
  let ready = false; // the line's image has loaded: confirming a line nobody could see would be a blind "exact"
  // A phone shows the line in two pieces rather than four; +/− changes it.
  let zoom = matchMedia("(max-width: 520px)").matches ? 0 : 2;
  let showPage = false;
  const fail = failureHandler(root, hooks);

  const view = (): LineVerifyView | null => (current && current.view.kind === "line_verify" ? current.view : null);
  const status = (text: string) => {
    const msg = root.querySelector(".msg");
    if (msg) msg.textContent = text;
  };

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

  async function act(value: string, text?: string): Promise<void> {
    if (!current || busy) return;
    if (value === "exact" && !ready) return status("התמונה עוד נטענת. / The image is still loading.");
    busy = true;
    const id = current.id;
    try {
      const body = text === undefined ? { value } : { value, text };
      try {
        await post(`/api/proposals/${id}/decision`, body);
      } catch (err) {
        if (!(err instanceof ApiFailure && err.code === "terms_required")) throw err;
        await hooks.needTerms();
        await post(`/api/proposals/${id}/decision`, body);
      }
      if (history[history.length - 1] !== id) history.push(id);
      await loadNext();
    } catch (err) {
      fail(err);
    } finally {
      busy = false;
    }
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

  /** Back to the previous line, where any new decision replaces the one made there (the undo). */
  function back(): void {
    const id = history.pop();
    if (id !== undefined) open(id).catch(fail);
  }

  function startEdit(): void {
    const v = view();
    if (!v || editing || !current) return;
    const box = root.querySelector(".editbox") as HTMLElement;
    const area = h("textarea", {
      dir: "rtl",
      lang: "he",
      rows: 2,
      spellcheck: "false",
      autocomplete: "off",
      autocapitalize: "off",
      maxlength: 1000,
      "aria-label": "השורה המתוקנת / the corrected line",
    });
    area.value = current.mine?.value === "edited" && current.mine.text !== null ? current.mine.text : v.candidate;
    const preview = h("div", { class: "preview texts" });
    const update = () => {
      // A line is one line: a pasted line break becomes a space.
      if (/[\r\n]/.test(area.value)) area.value = area.value.replace(/[\r\n]+/g, " ");
      const cmp = compare(v.candidate, area.value, "", "");
      preview.replaceChildren(
        h("div", { class: "row" }, h("span", { class: "lab" }, "מקור:"), cmp.current),
        h("div", { class: "row" }, h("span", { class: "lab" }, "שלך:"), cmp.proposed),
        h("div", { class: "row" }, h("span", { class: "lab" }, ""), cmp.codes),
      );
    };
    const save = () => {
      const text = area.value;
      cancel();
      void act("edited", text);
    };
    const cancel = () => {
      editing = null;
      box.replaceChildren();
      box.hidden = true;
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
        cancel();
      }
    });
    box.replaceChildren(
      area,
      preview,
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "primary", onclick: save }, "שמירת התיקון / Save ", h("kbd", { dir: "ltr" }, "Ctrl+Enter")),
        h("button", { type: "button", onclick: cancel }, "ביטול / Cancel ", h("kbd", { dir: "ltr" }, "Esc")),
      ),
    );
    box.hidden = false;
    editing = area;
    update();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  function renderStrip(): void {
    const v = view();
    const holder = root.querySelector(".linebox") as HTMLElement | null;
    if (!v || !holder) return;
    if (!v.crop || !v.crop.box) {
      ready = true;
      holder.replaceChildren(h("p", { class: "muted" }, "אין תמונה לשורה הזאת. / No image for this line."));
      return;
    }
    const width = Math.max(200, holder.clientWidth || root.clientWidth || 360);
    holder.replaceChildren(lineStrip(v.crop, v.crop.box, LINE_HEIGHTS[zoom]!, width, () => (ready = true)));
  }

  function renderContext(): void {
    const v = view();
    const holder = root.querySelector(".ctxbox") as HTMLElement | null;
    if (!v || !holder) return;
    const toggle = h(
      "button",
      { type: "button", class: "small", onclick: togglePage, disabled: !v.page },
      showPage ? "חזרה להקשר / Back to context " : "העמוד המלא / Full page ",
      h("kbd", { dir: "ltr" }, "P"),
    );
    if (showPage && v.page) {
      holder.replaceChildren(viewer(null, v.page).el, h("div", { class: "row" }, toggle));
      return;
    }
    const c = v.crop;
    const band = c
      ? h(
          "div",
          { class: "frame ctxband" },
          h("img", { src: c.url, width: c.width, height: c.height, alt: "השורה עם השורות שלפניה ואחריה / the line with its neighbours", decoding: "async", draggable: "false" }),
          c.box
            ? h("div", {
                class: "hl",
                style: `left:${c.box[0] * 100}%;top:${c.box[1] * 100}%;width:${(c.box[2] - c.box[0]) * 100}%;height:${(c.box[3] - c.box[1]) * 100}%`,
              })
            : null,
        )
      : null;
    if (band && c) band.style.width = `min(100%, ${Math.round((150 * c.width) / Math.max(1, c.height))}px)`;
    holder.replaceChildren(h("div", { class: "ctxscroll", dir: "ltr" }, band), h("div", { class: "row" }, toggle));
  }

  function togglePage(): void {
    if (!view()?.page) return;
    showPage = !showPage;
    renderContext();
  }

  function setZoom(step: number): void {
    zoom = Math.max(0, Math.min(LINE_HEIGHTS.length - 1, zoom + step));
    renderStrip();
  }

  function render(revisiting: boolean): void {
    const p = current!;
    const v = view();
    if (!v) throw new Error(`lineVerifyView cannot show ${p.view.kind}`);
    editing = null;
    ready = false;
    showPage = false;
    const option = (value: string) => p.options.find((o) => o.value === value);
    const btn = (value: string, key: string, cls: string, onclick: () => void) => {
      const o = option(value);
      return h(
        "button",
        { type: "button", class: `act ${cls}`, onclick, "data-value": value, title: o?.label.en ?? value },
        h("span", {}, o?.label.he ?? value),
        h("kbd", { dir: "ltr" }, key),
      );
    };
    const mine = p.mine ? option(p.mine.value) : undefined;
    mount(
      root,
      progressBar(progress),
      h(
        "article",
        { class: "card proposal" },
        h(
          "header",
          { class: "meta" },
          h("span", { class: "tag", title: v.source.label.en }, v.source.label.he),
          h("span", { class: "tag", title: v.provenance.label.en }, v.provenance.label.he),
          h("span", { class: "muted small title", dir: "auto" }, `${p.itemTitle} · שורה ${v.lineIndex}`),
        ),
        h(
          "p",
          { class: "ask" },
          "האם הטקסט זהה בדיוק לשורה המסומנת, אות באות וסימן בסימן?",
          h("span", { class: "muted small block", lang: "en", dir: "ltr" }, "Is the text exactly the marked line, letter by letter and mark by mark?"),
        ),
        h("div", { class: "linebox" }),
        h("div", { class: "txt cand", dir: "rtl", lang: "he" }, ...candidateNodes(v.runs)),
        v.runs.some((r) => r.attention)
          ? h("p", { class: "legend muted small" }, h("mark", { class: "attn" }, "מסומן"), " = כאן מנועי ה-OCR קראו אחרת; בדקו היטב. / OCR engines disagree here; look closely.")
          : null,
        revisiting && mine ? h("p", { class: "mine" }, `ההחלטה שלך: ${mine.label.he}`, p.mine?.text ? ` («${p.mine.text}»)` : "", " · החלטה חדשה תחליף אותה.") : null,
        h("div", { class: "editbox", hidden: true }),
        h("p", { class: "msg", role: "status" }),
        h("div", { class: "ctxbox" }),
        h(
          "p",
          { class: "attrib muted small" },
          h("span", { class: "block" }, "מקור / Source: ", h("bdi", { dir: "auto" }, `${v.bookTitle}${v.pageLabel ? `, עמ' ${v.pageLabel}` : ""}`)),
          h("bdi", { class: "block", dir: "auto" }, v.attribution),
          h("span", { class: "block" }, "רישיון הטקסט / Text licence: ", h("bdi", { dir: "auto" }, v.textLicense)),
        ),
      ),
      h(
        "nav",
        { class: "actions five" },
        btn("exact", "Enter", "ok", () => void act("exact")),
        btn("edited", "E", "edit", startEdit),
        btn("unreadable", "U", "bad", () => void act("unreadable")),
        btn("misaligned", "M", "bad", () => void act("misaligned")),
        h("button", { type: "button", class: "act skip", onclick: () => void doSkip(), title: "Skip" }, h("span", {}, "דילוג"), h("kbd", { dir: "ltr" }, "S")),
      ),
      h(
        "div",
        { class: "subnav" },
        h(
          "button",
          { type: "button", class: "small", onclick: back, disabled: history.length === 0, title: "Back to the previous line; a new decision there replaces yours" },
          "→ הקודם (לשינוי ההחלטה) ",
          h("kbd", { dir: "ltr" }, "B"),
        ),
        h("button", { type: "button", class: "small", onclick: () => setZoom(-1), "aria-label": "הקטנה / zoom out" }, "−"),
        h("button", { type: "button", class: "small", onclick: () => setZoom(1), "aria-label": "הגדלה / zoom in" }, "+"),
        revisiting ? h("button", { type: "button", class: "small", onclick: () => void loadNext().catch(fail) }, "לתור ←") : null,
        h("p", { class: "keys muted small" }, "קיצורים: ", ...KEYS.flatMap(([k, t, en]) => [h("kbd", { dir: "ltr", title: en }, k), ` ${t} · `])),
      ),
    );
    renderStrip();
    renderContext();
  }

  function renderDone(): void {
    mount(
      root,
      progressBar(progress),
      h(
        "section",
        { class: "card done" },
        h("h2", {}, "אין עוד שורות בשבילך כרגע. תודה רבה!"),
        h("p", { lang: "en", dir: "ltr", class: "muted" }, "No lines left for you right now. Thank you!"),
        progress.skippedByMe
          ? h(
              "button",
              { type: "button", onclick: () => void post(`/api/batches/${encodeURIComponent(batch.id)}/skips/clear`).then(loadNext).catch(fail) },
              `חזרה ל-${progress.skippedByMe} השורות שדילגת עליהן`,
            )
          : null,
        history.length ? h("button", { type: "button", onclick: back }, "→ חזרה להחלטה האחרונה") : null,
        h("p", { class: "msg", role: "status" }),
      ),
    );
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
    // A focused button or link handles its own Enter and Space.
    if (target && (target.tagName === "BUTTON" || target.tagName === "A") && (e.key === "Enter" || e.key === " ")) return;
    if (!current || current.view.kind !== "line_verify") return;
    // Holding a key down must not decide line after line.
    if (e.repeat) return e.preventDefault();
    // e.code is the physical key, so the shortcuts work in a Hebrew keyboard layout too.
    const actions: Record<string, () => void> = {
      Enter: () => void act("exact"),
      NumpadEnter: () => void act("exact"),
      Digit1: () => void act("exact"),
      KeyE: startEdit,
      Digit2: startEdit,
      KeyU: () => void act("unreadable"),
      Digit3: () => void act("unreadable"),
      KeyM: () => void act("misaligned"),
      Digit4: () => void act("misaligned"),
      KeyS: () => void doSkip(),
      Digit5: () => void doSkip(),
      KeyB: back,
      Backspace: back,
      Equal: () => setZoom(1),
      NumpadAdd: () => setZoom(1),
      KeyZ: () => setZoom(1),
      Minus: () => setZoom(-1),
      NumpadSubtract: () => setZoom(-1),
      KeyX: () => setZoom(-1),
      KeyP: togglePage,
    };
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
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  mount(root, h("p", { class: "muted" }, "טוען… / Loading…"));
  (startAt === undefined ? loadNext() : open(startAt)).catch(fail);
  return {
    el: root,
    dispose: () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    },
  };
}
