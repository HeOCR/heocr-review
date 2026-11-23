import { CONTRIBUTOR_API, type ContributorKind, type ContributorNext, type ContributorProfile, type FormField } from "../../shared/contributor";
import { ApiFailure, get, post } from "../api";
import { bdi, h } from "../dom";
import { lang, t } from "../i18n";
import { captureGuide } from "./contributor-guide";

type Pair = readonly [he: string, en: string];
const text = (he: string, en: string) => lang() === "he" ? he : en;
const tr = (pair: Pair) => text(...pair);
const names: Record<ContributorKind, Pair> = {
  print: ["צילום דפים מודפסים", "Photograph printed pages"],
  form: ["מילוי טפסים לדוגמה", "Fill in sample forms"],
  line: ["בדיקת שורות", "Check lines"],
  handwriting: ["כתיבה ביד", "Write by hand"],
};
const bands: Record<ContributorProfile["ageBand"], Pair> = {
  "10_12": ["10–12", "10–12"], "13_15": ["13–15", "13–15"], "16_17": ["16–17", "16–17"],
};
const btn = (label: string, action: () => void, primary = false) =>
  h("button", {type:"button", class: primary ? "act primary" : "act", onclick:action}, label);

export const contributorTitle = () => text("משימות תרומה", "Contributor tasks");

function fictionalPersona(fields: FormField[]) {
  return h("aside",{class:"contributor-persona"},h("h3",{},text("פרטים מומצאים לטופס","Fictional details for this form")),
    h("dl",{},...fields.flatMap(({label,value})=>[h("dt",{},bdi(label)),h("dd",{},bdi(value))])));
}

export function contributorView(account: string, enabled: boolean, signedOut: () => void) {
  const root=h("section",{class:"contributor"});
  const notices=h("p",{class:"contributor-notice",role:"status"});
  let p: ContributorProfile | null=null;
  let selected: ContributorKind | null=null;
  let busy=false;
  const url=()=>`${CONTRIBUTOR_API}/writers/${p!.writer}`;
  const submitUrl=(task:ContributorNext)=>url()+"/tasks/"+task.id+"/submit";
  function notice(message:string) { notices.textContent=message; }
  function error(err:unknown) {
    if (err instanceof ApiFailure && err.status===401) {
      signedOut();
    } else if (err instanceof ApiFailure && err.code==="consent_changed") {
      notice(text("הנוסח השתנה. טענו מחדש ובדקו את הגרסה החדשה.","The wording changed. Reload to read the new version."));
    } else if (err instanceof ApiFailure && err.code==="contributor_reference_changed") {
      notice(text("דף ההעתקה השתנה. טענו מחדש והשתמשו בגרסה העדכנית.","The assigned text changed. Reload and use the current version."));
    } else if (err instanceof ApiFailure && err.status===413) {
      notice(text("הקובץ גדול מדי. בחרו תמונה עד 16 מגה־בייט.","That file is too large. Choose a photo up to 16 MB."));
    } else if (err instanceof ApiFailure && err.code==="contributor_photo_format") {
      notice(text("בחרו צילום JPEG או PNG בלי נתוני מיקום או פרטים מזהים.","Choose a JPEG or PNG photo without location or identifying metadata."));
    } else if (err instanceof ApiFailure && err.code==="contributor_slot_conflict") {
      notice(text("המשימה כבר נשמרה או שהתמונה כבר שימשה. טענו מחדש.","This task was saved or the photo was already used. Reload to continue."));
    } else {
      notice(text("הפעולה לא הצליחה. נסו שוב.","This did not save. Try again."));
    }
  }
  async function action(control:HTMLButtonElement, run:()=>Promise<ContributorProfile>, confirmation:string) {
    if (busy) return;
    busy=true;
    control.disabled=true;
    notice(t("loading"));
    try {
      p=await run();
      render();
      root.querySelector<HTMLElement>("[data-contributor-heading]")?.focus();
      notice(confirmation);
    } catch(err) { error(err); }
    finally { busy=false; control.disabled=false; }
  }
  function withdrawal(profile:ContributorProfile) {
    if (!profile.receipt) return null;
    const email="heocrproject@gmail.com";
    const receipt=h("p",{class:"small"},text("קוד הסרה", "Withdrawal code")," ",bdi(profile.receipt,"ltr"));
    const details=h("details",{class:"contributor-withdraw"},
      h("summary",{},text("איך מפסיקים השתתפות?", "How do I withdraw?")),
      receipt,
      h("p",{},text("אפשר לעצור עכשיו ולשלוח את הקוד בדוא״ל כדי לבקש להסיר את החומרים.","You can stop now and email the code to request removal of your contributions.")),
      h("a",{href:"mailto:"+email},email));
    if (profile.state!=="withdrawn") {
      const stop=btn(text("הפסקת השתתפות","Stop participating"),()=>{
        if (!window.confirm(text("לעצור את ההשתתפות והמשימות?", "Stop participation and close your tasks?"))) return;
        void action(stop,()=>post(url()+"/withdraw",{withdraw:true}),text("ההשתתפות הופסקה.","Participation stopped."));
      });
      details.append(stop);
    }
    return details;
  }
  function consent(profile:ContributorProfile) {
    if (profile.state==="withdrawn") return h("p",{class:"card"},text("ההשתתפות הופסקה.", "Participation has stopped."));
    if (profile.role==="writer" && profile.state==="guardian") return h("p",{class:"card"},
      text("המשימות ייפתחו אחרי אישור ההורה או האפוטרופוס. בקשו מהם להיכנס מהחשבון שלהם.","Tasks open after your guardian agrees using their own account."));
    if (profile.role==="guardian" && profile.state!=="guardian") return h("p",{class:"card"},
      text("האישור נשמר. הכותב או הכותבת יכולים להיכנס ולהחליט אם להשתתף.","Your consent is saved. The writer can sign in and decide whether to participate."));
    const copy=profile.copy[lang()];
    const checkbox=h("input",{type:"checkbox"});
    const save=btn(text("שמירת אישור","Save agreement"),()=>{
      if (!checkbox.checked) {
        notice(text("כדי להמשיך, סמנו שקראתם ואתם מסכימים.","Select the checkbox to continue."));
        checkbox.focus();
        return;
      }
      void action(save,()=>post(url()+"/consent",{lang:lang(),version:profile.version,sha256:copy.sha256,accept:true}),text("האישור נשמר.","Agreement saved."));
    },true);
    return h("section",{class:"card contributor-consent"},
      h("h2",{},profile.role==="guardian"?text("אישור הורה או אפוטרופוס","Guardian consent"):text("הסכמת הכותב או הכותבת","Writer assent")),
      h("p",{class:"small muted"},tr(bands[profile.ageBand])," · ",text("גרסה ", "Version "),bdi(profile.version,"ltr")),
      h("p",{class:"contributor-copy"},copy.text),
      h("label",{class:"check"},checkbox," ",profile.role==="guardian"?
        text("קראתי ואני מאשר/ת כהורה או כאפוטרופוס.","I have read this and agree as the guardian."):
        text("קראתי ואני בוחר/ת להשתתף.","I have read this and choose to participate.")),
      save);
  }
  function upload(task:ContributorNext) {
    const photo=h("input",{type:"file",accept:"image/jpeg,image/png",hidden:true});
    const choose=btn(text("בחירת צילום","Choose photo"),()=>photo.click());
    const privacy=h("input",{type:"checkbox"});
    const preview=h("img",{class:"contributor-preview",alt:t("cg_preview"),hidden:true});
    photo.addEventListener("change",()=>{
      privacy.checked=false;
      preview.hidden=true;
      preview.removeAttribute("src");
      const file=photo.files?.[0];
      if (!file || file.size>16*1024*1024 || !["image/jpeg","image/png"].includes(file.type)) return;
      const reader=new FileReader();
      reader.addEventListener("load",()=>{
        if (photo.files?.[0]===file && typeof reader.result==="string") preview.src=reader.result;
      });
      reader.readAsDataURL(file);
    });
    preview.addEventListener("load",()=>{ preview.hidden=false; });
    const button=btn(text("העלאת צילום","Upload photo"),()=>{
      const file=photo.files?.[0];
      if (!file || !privacy.checked) {
        notice(text("בחרו צילום ואשרו שאין בו פרטים אישיים.","Choose a photo and confirm it contains no personal information."));
        (!file ? choose : privacy).focus();
        return;
      }
      if (file.size > 16*1024*1024) {
        error(new ApiFailure(413,"body_too_large"));
        return;
      }
      void action(button,async ()=>{
        const headers: Record<string,string>={"x-contributor-privacy":"confirmed"};
        if (task.kind==="form" || task.kind==="handwriting") headers["x-contributor-reference"]=task.referenceSha256;
        const response=await fetch(submitUrl(task),{method:"POST",headers,body:file});
        const value=await response.json() as ContributorProfile & {error?:string};
        if (!response.ok) throw new ApiFailure(response.status,value.error??"error");
        return value;
      },text("הצילום נשמר.","Photo saved."));
    },true);
    return h("div",{class:"contributor-upload"},
      photo,choose,preview,
      h("label",{class:"check"},privacy," ",text("בדקתי שאין בצילום פרטים אישיים אמיתיים.","I checked that the photo contains no real personal information.")),
      button);
  }
  function taskView(task:ContributorNext) {
    const title=h("h2",{"data-contributor-heading":"",tabindex:"-1"},tr(names[task.kind])," · ",bdi(task.page,"ltr"));
    if (task.kind==="line") {
      const crop=h("img",{class:"contributor-line",src:task.crop,alt:text("צילום השורה","Scan of the line"),decoding:"async"});
      const editor=h("textarea",{dir:"rtl",rows:3,"aria-label":text("תיקון השורה","Correct the line")});
      editor.value=task.candidate;
      const exact=btn(t("exact"),()=>void action(exact,()=>post(submitUrl(task),{value:"exact"}),t("saved")),true);
      const corrected=btn(text("שמירת תיקון","Save correction"),()=>void action(corrected,
        ()=>post(submitUrl(task),{value:"edited",text:editor.value}),t("saved")));
      return h("section",{class:"card contributor-task"},title,
        h("p",{},text("השוו את השורה המודפסת לטקסט. תקנו רק אם יש הבדל.","Compare the printed line with the text. Edit it if they differ.")),
        crop,editor,h("div",{class:"contributor-actions"},exact,corrected));
    }
    if (task.kind==="handwriting") {
      const sheet=h("section",{class:"contributor-prompt"},
        h("h4",{},text("דף כתיבה","Handwriting sheet")," · ",bdi(task.page,"ltr")),
        h("p",{class:"contributor-print-help"},t("cg_copy_p")),
        h("ol",{dir:"rtl"},...task.prompt.split("\n").map(sentence=>h("li",{},sentence))), h("p",{class:"small muted"},task.rights));
      const print=btn(text("הדפסת דף כתיבה","Print handwriting sheet"),()=>{
        document.body.classList.add("contributor-printing");
        window.addEventListener("afterprint",()=>document.body.classList.remove("contributor-printing"),{once:true});
        window.print();
        document.body.classList.remove("contributor-printing");
      });
      return h("section",{class:"card contributor-task"},title,captureGuide("flat",[
        {title:"cg_print_h",instruction:"cg_hand_print_p",illustration:"print",content:[print]},
        {title:"cg_copy_h",instruction:"cg_copy_p",illustration:"copy",content:[sheet]},
      ],upload(task)));
    }
    const download=h("a",{class:"act",href:task.sheet,download:""},text("הורדה והדפסה","Download and print"));
    return h("section",{class:"card contributor-task"},title,captureGuide(task.kind==="print"?task.mode:"flat",[
      {title:"cg_print_h",instruction:"cg_print_p",illustration:"print",content:[download]},
      ...(task.kind==="form" ? [{title:"cg_form_h",instruction:"cg_form_p",illustration:"form",content:[fictionalPersona(task.fields)]} as const] : []),
    ],upload(task)));
  }
  function render() {
    if (!p) return;
    const heading=h("h1",{"data-contributor-heading":"",tabindex:"-1"},contributorTitle());
    const queues=p.queues.filter(queue=>queue.total>0);
    if (!queues.length) {
      root.replaceChildren(heading,consent(p),notices,...[withdrawal(p)].filter(n=>n!==null));
      return;
    }
    const active=queues.find(q=>q.kind===selected)?.next;
    const focusHeading=()=>root.querySelector<HTMLElement>(".contributor-task h2, h1")?.focus();
    if (active) {
      const back=btn(contributorTitle(),()=>{ selected=null;render();focusHeading(); });
      const task=taskView(active);
      root.replaceChildren(back,task,notices,...[withdrawal(p)].filter(n=>n!==null));
      return;
    }
    const cards=queues.map(q=>{
      const name=tr(names[q.kind]);
      const count=`${q.done} / ${q.total}`;
      return h("section",{class:"contributor-queue"},
        h("h2",{},name),h("p",{class:"contributor-count"},bdi(count,"ltr")),
        h("progress",{value:q.done,max:q.total,"aria-label":name}),
        q.next?btn(text("המשך","Continue"),()=>{selected=q.kind;render();focusHeading();}):
          h("p",{class:"small muted"},text("הושלם","Complete")));
    });
    root.replaceChildren(heading,h("div",{class:"contributor-grid"},...cards),notices,...[withdrawal(p)].filter(n=>n!==null));
  }
  async function load() {
    root.replaceChildren(h("h1",{},contributorTitle()),notices);
    notice(t("loading"));
    try {
      const data=await get<{enrolments:{writer:string;role:string;ageBand:ContributorProfile["ageBand"]}[]}>(CONTRIBUTOR_API+"/enrolments");
      if (!data.enrolments.length) {
        notice(text("אין משימות לחשבון הזה. אם הוזמנתם, שלחו למארגני המיזם באופן פרטי את קוד החשבון.","This account has no assignments. If you were invited, share the account code privately with your organiser."));
        root.append(h("p",{},text("קוד חשבון", "Account code")," ",bdi(account,"ltr")));
        return;
      }
      const open=async (id:string) => {
        try { p=await get<ContributorProfile>(CONTRIBUTOR_API+"/writers/"+id); notice("");render(); }
        catch(err) { error(err); }
      };
      if (data.enrolments.length===1) await open(data.enrolments[0]!.writer);
      else {
        notice("");
        for (const item of data.enrolments) root.append(btn(text("חשבון כותב ", "Writer ") + item.writer + " · " + tr(bands[item.ageBand]),()=>void open(item.writer)));
      }
    } catch(err) { error(err); }
  }
  if (enabled) void load();
  else root.append(h("h1",{},contributorTitle()),h("p",{},text("משימות התרומה סגורות כרגע.","Contributor tasks are currently closed.")));
  return root;
}
