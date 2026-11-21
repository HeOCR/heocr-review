import type { BatchSummary } from "../../shared/api";
import type { Box } from "../../shared/media";
import type { SweepLine, SweepPage } from "../../shared/page-sweep";
import { ApiFailure, get, post } from "../api";
import { h, mount } from "../dom";
import { lang, t } from "../i18n";
import type { ReviewHooks, ReviewScreen } from "./common";

const label = (he: string, en: string) => lang() === "he" ? he : en;
const position = ([x0,y0,x1,y1]: Box) =>
  `left:${x0*100}%;top:${y0*100}%;width:${(x1-x0)*100}%;height:${(y1-y0)*100}%`;
const writable = (line: SweepLine) => ["open","pending","skipped"].includes(line.state);
const stateLabel = (state: SweepLine["state"]) => ({
  open: "", done: label("מדויק","Exact"), pending: label("דורש בדיקה","Needs review"),
  edited: t("saved_short"), flagged: label("סומן","Flagged"), skipped: label("דולג","Skipped"),
}[state]);

export function pageSweepView(batch: BatchSummary, hooks: ReviewHooks): ReviewScreen {
  const root = h("section", { class: "sweep" });
  const base = `/api/page-sweep/${encodeURIComponent(batch.id)}`;
  const back = `#b/${encodeURIComponent(batch.id)}/q/triage`;
  let disposed = false;
  let observer: ResizeObserver | null = null;
  let zoom = 1;
  let busy = false;
  const status = h("p", { role: "status", class: "sweep-status" });
  const say = (message = "") => { status.textContent = message; };
  const heads = () => h("a", { href: back }, label("אימות שורה אחר שורה", "Line-by-line review"));
  const canvas = document.createElement("canvas").getContext("2d");

  function failed(error: unknown) {
    if (error instanceof ApiFailure && error.status === 401) hooks.signedOut();
    else say(error instanceof ApiFailure && error.status === 409
      ? t("p_stale") : t("load_failed"));
  }

  async function load() {
    if (disposed) return;
    observer?.disconnect();
    say();
    try {
      const { page } = await get<{ page: SweepPage | null }>(base + "/next");
      if (disposed) return;
      if (page) render(page);
      else mount(root, heads(), h("h1", {}, t("done_h")),
        h("a", { href: `#b/${encodeURIComponent(batch.id)}/q/fix` }, t("q_fix", { n: batch.triage?.fix ?? 0 })),
        h("a", { href: "#tasks" }, t("all_tasks")));
    } catch (error) {
      mount(root, heads(), status, h("button", { type: "button", onclick: () => void load() }, t("retry")));
      failed(error);
    }
  }

  function render(page: SweepPage, keep?: { top: number; left: number }) {
    if (disposed) return;
    observer?.disconnect();
    say();
    const endpoint = base + "/pages/" + page.id;
    const leftFrame = h("div", { class: "sweep-frame" });
    const rightFrame = h("div", { class: "sweep-frame" });
    const makeImage = () => h("img", { src: page.image.url, alt: page.title, draggable: "false" });
    leftFrame.append(makeImage());
    rightFrame.append(makeImage());
    const left = h("div", { class: "sweep-scroll", tabindex: "0", "aria-label": label("סריקה מקורית","Original scan") }, leftFrame);
    const right = h("div", { class: "sweep-scroll", tabindex: "0", "aria-label": label("טקסט שחולץ","Extracted text") }, rightFrame);
    for (const [source, target] of [[left,right],[right,left]] as const) {
      source.addEventListener("scroll", () => {
        if (Math.abs(source.scrollLeft-target.scrollLeft)>1) target.scrollLeft=source.scrollLeft;
        if (Math.abs(source.scrollTop-target.scrollTop)>1) target.scrollTop=source.scrollTop;
      });
    }
    const highlight = h("div", { class: "sweep-highlight", hidden: true });
    leftFrame.append(highlight);
    const overlays: { button: HTMLButtonElement; text: string }[] = [];
    const unboxed = h("ol", { class: "sweep-list" });
    let editor: HTMLElement | null = null;
    let last: HTMLButtonElement | null = null;
    const close = (focus = false) => {
      editor?.remove(); editor = null;
      finish.disabled = askMissing.disabled = page.final || page.missing || busy;
      if (focus) last?.focus();
    };

    function resize() {
      const width = Math.max(1, Math.min(left.clientWidth,right.clientWidth)) * zoom;
      const height = width*page.image.height/page.image.width;
      for (const frame of [leftFrame,rightFrame]) {
        frame.style.width=width+"px"; frame.style.height=height+"px";
      }
      for (const {button,text} of overlays) {
        let size = Math.max(1, button.clientHeight * .82);
        if (canvas && text) {
          canvas.font=`${size}px Arial`;
          const measured=canvas.measureText(text).width || 1;
          size *= Math.min(1, Math.max(1,button.clientWidth-4)/measured);
        }
        button.style.fontSize=Math.max(1,size)+"px";
      }
    }

    function edit(line: SweepLine, trigger: HTMLButtonElement, target: HTMLElement) {
      if (!writable(line) || page.final || page.missing || busy) return;
      close();
      last = trigger;
      const input = h("textarea", { dir: "rtl", rows: "2", "aria-label": label("טקסט השורה","Line text") }, line.text);
      const g = h("div", { class: "sweep-actions" });
      const pane = h("div", { class: "sweep-editor", dir: "rtl" }, input, g);
      const submit = async (value: string, withText: boolean) => {
        if (busy) return;
        busy=true;
        for (const b of Array.from(g.querySelectorAll("button"))) b.disabled=true;
        try {
          const {page: next}=await post<{page:SweepPage}>(endpoint,{action:"edit",line:line.id,value,
            ...(withText?{text:input.value}:{}),token:page.token});
          busy=false;
          render(next,{top:right.scrollTop,left:right.scrollLeft});
        } catch (error) {
          busy=false;
          for (const b of Array.from(g.querySelectorAll("button"))) b.disabled=false;
          if (error instanceof ApiFailure && error.code==="invalid_decision") say(error.message);
          else failed(error);
        }
      };
      g.append(h("button",{type:"button",class:"act primary",onclick:()=>void submit("edited",true)},t("set_save")));
      for (const opt of line.options) g.append(h("button",{type:"button",class:"act",
        onclick:()=>void submit(opt.value,opt.withText || opt.value==="pointed_print" && input.value!==line.text)},opt.label[lang()]));
      g.append(h("button",{type:"button",onclick:()=>close(true)},t("cancel")));
      pane.addEventListener("keydown",e=>{if(e.key==="Escape") close(true)});
      if (line.box) {
        pane.style.left=`${Math.min(line.box[0],.55)*100}%`;
        pane.style.top=`${line.box[3]*100}%`;
        pane.classList.add("sweep-inline");
      }
      target.append(pane); editor=pane; finish.disabled=askMissing.disabled=true;
      input.focus({preventScroll:true}); input.select();
      pane.scrollIntoView({block:"nearest",inline:"nearest"});
    }

    for (const line of page.lines) {
      const hint=stateLabel(line.state);
      const attrs = { type:"button", class:`sweep-box sweep-${line.state}`, dir:"rtl",
        "aria-label": [line.order,line.text || "·",hint].filter(Boolean).join(" "), title: hint || line.text };
      const button=h("button",attrs,line.box ? line.text : `${line.order} · ${line.text || "—"}${hint ? " · "+hint : ""}`);
      if (!writable(line) || page.final || page.missing) button.setAttribute("aria-disabled","true");
      if (line.box) {
        const region=line.box;
        button.setAttribute("style",position(region));
        const show = () => { highlight.hidden=false; highlight.setAttribute("style",position(region)); };
        const hide = () => { highlight.hidden=true; };
        button.addEventListener("mouseenter",show);button.addEventListener("mouseleave",hide);
        button.addEventListener("focus",show);button.addEventListener("blur",hide);
        button.onclick=()=>edit(line,button,rightFrame);
        rightFrame.append(button);overlays.push({button,text:line.text});
      } else {
        const li=h("li",{},button);
        button.onclick=()=>edit(line,button,li);
        unboxed.append(li);
      }
    }
    const finalize = async (action: "finish" | "missing_lines") => {
      if(editor||busy) return;
      busy=true;finish.disabled=askMissing.disabled=true;
      try {
        await post(endpoint,{action,token:page.token});
        zoom=1;
        if (action === "missing_lines") location.hash = `#b/${encodeURIComponent(batch.id)}/q/fix`;
        else await load();
      }
      catch(error) {
        if (error instanceof ApiFailure && error.code==="not_open") say(label("יש שורות שסומנו ועדיין דורשות החלטה","Resolve flagged or skipped lines before finishing."));
        else failed(error);
      } finally { busy=false;finish.disabled=askMissing.disabled=page.final||page.missing; }
    };
    const finish=h("button",{type:"button",class:"act primary",disabled:page.final||page.missing,onclick:()=>void finalize("finish")},
      label("עברתי על הכל","I reviewed everything"));
    const askMissing=h("button",{type:"button",class:"act",disabled:page.final||page.missing,onclick:()=>void finalize("missing_lines")},t("pc_no"));
    const changeZoom=(factor:number)=>{
      const old=zoom;
      const {scrollTop,scrollLeft}=left;
      zoom=Math.max(1,Math.min(5,zoom*factor));
      resize();
      left.scrollTop=right.scrollTop=scrollTop*zoom/old;
      left.scrollLeft=right.scrollLeft=scrollLeft*zoom/old;
    };
    mount(root,h("div",{class:"sweep-toolbar"},heads(),h("h1",{},page.title),
      h("button",{type:"button",class:"sweep-zoom","aria-label":label("הקטנה","Zoom out"),onclick:()=>changeZoom(1/1.25)},"−"),
      h("button",{type:"button",class:"sweep-zoom","aria-label":label("הגדלה","Zoom in"),onclick:()=>changeZoom(1.25)},"+"),askMissing,finish),
      status,h("div",{class:"sweep-panes",dir:"ltr"},
        h("section",{},h("h2",{},label("סריקה מקורית","Original scan")),left),
        h("section",{},h("h2",{},label("טקסט שחולץ","Extracted text")),right)),
      ...(unboxed.childNodes.length ? [h("h2",{},label("שורות ללא מסגרת שימושית","Lines without a usable box")),unboxed] : []));
    observer=new ResizeObserver(resize); observer.observe(left);
    resize();
    if(keep){left.scrollTop=right.scrollTop=keep.top;left.scrollLeft=right.scrollLeft=keep.left;}
  }
  void load();
  return {el:root, dispose(){disposed=true;observer?.disconnect();}};
}
