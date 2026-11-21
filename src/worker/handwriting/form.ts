import { randomId } from "../crypto";
import { prefix } from "./core";

const style = `body{max-width:44rem;margin:1.5rem auto;padding:0 1rem;font:1rem/1.6 system-ui;color:#172431}button,input,textarea,select{font:inherit}button{padding:.4rem .8rem}textarea{box-sizing:border-box;width:100%;min-height:6rem}pre{white-space:pre-wrap}img{max-width:100%;height:auto}fieldset{padding:1rem;margin-top:1rem}label{display:block;margin:.5rem 0}#result{white-space:pre-wrap;overflow-wrap:anywhere}`;
const shared = `const out=document.querySelector('#result');
const text=(id,value)=>{document.querySelector(id).textContent=value};
const api=${JSON.stringify(prefix)};
async function request(path,options){const r=await fetch(api+path,options);if(!r.ok)throw Error();return r.json()}
const failure=()=>{out.textContent='הפעולה לא הושלמה. בדקו את הקישור או נסו שוב. / The request could not be completed.'};`;
const writerScript = shared + `
let token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
const info=document.querySelector('#info'), form=document.querySelector('form'), lang=document.querySelector('#lang');
let provision;
async function show(){
  form.hidden=true;
  try{
    provision=await request('/invitation?lang='+lang.value,{headers:{authorization:'Bearer '+token}});
    text('#assignment',Object.values(provision.assignment).join(' · '));
    text('#prompt',provision.prompt);
    text('#consent',provision.consent.text+'\\n\\n'+provision.retentionNotice);
    info.dir=lang.value==='he'?'rtl':'ltr';form.reset();form.hidden=false;
  }catch{failure()}
}
lang.addEventListener('change',show);
form.addEventListener('submit',async e=>{
  e.preventDefault();const file=document.querySelector('#file').files[0];if(!file||!provision)return;
  const button=form.querySelector('button');button.disabled=true;
  try{
    const receipt=await request('/upload',{method:'POST',body:file,headers:{authorization:'Bearer '+token,
      'content-type':file.type,'x-intake-language':lang.value,'x-intake-agree':'yes',
      'x-intake-wording-version':provision.consent.version,'x-intake-wording-sha256':provision.consent.sha256,
      'x-intake-prompt-sha256':provision.promptSha256}});
    out.textContent='Receipt / קבלה: '+receipt.receiptCode+'\\n'+receipt.withdrawalEmail+'\\n\\n'+receipt.consent.text+'\\n\\n'+receipt.retentionNotice;
    form.hidden=true;info.hidden=true;lang.disabled=true;token='';
  }catch{failure()}finally{button.disabled=false}
});
if(/^[a-f0-9]{64}$/.test(token))show();else failure();
`;
const reviewScript = shared + `
const form=document.querySelector('#review form'), screen=document.querySelector('#review'), adjudication=document.querySelector('#adjudication');
const image=document.querySelector('img'); let task;
const send=(path,data)=>request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
async function next(){
  form.hidden=true;adjudication.hidden=true;document.querySelector('#qc').hidden=true;image.removeAttribute('src');out.textContent='';
  try{
    task=(await request('/review/next')).task;
    if(!task){out.textContent='אין משימות זמינות / No items available.';return;}
    screen.hidden=false;image.src=task.image;form.reset();
    if(task.own)await showAdjudication();else form.hidden=false;
  }catch{failure()}
}
async function showAdjudication(){
  const r=await fetch(api+'/review/'+task.id+'/adjudicate');
  if(r.status===404)return false;
  if(!r.ok)throw Error();
  const details=await r.json();
  text('#reads',details.reads.map(x=>x.issue+': '+x.text).join('\\n'));
  adjudication.hidden=false;
  return true;
}
const consent=document.querySelector('#agreement');
async function showAgreement(){
  try {
    const lang=document.querySelector('#lang').value;
    const terms=await request('/review/consent?lang='+lang);
    text('#wording',terms.consent.text+'\\n\\n'+terms.retentionNotice);
    consent.onsubmit=async e=>{
      e.preventDefault();
      try{await send('/review/consent',{agree:true,language:lang,version:terms.consent.version,sha256:terms.consent.sha256});consent.hidden=true;await next()}
      catch{failure()}
    };
  }catch{failure()}
}
document.querySelector('#lang').addEventListener('change',showAgreement);
showAgreement();
form.addEventListener('submit',async e=>{
  e.preventDefault();
  try {
    await send('/review/'+task.id,{text:document.querySelector('#transcription').value,issue:document.querySelector('#issue').value});
    form.hidden=true;
    if(!await showAdjudication())await next();
  }catch{failure()}
});
adjudication.addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    const reason=document.querySelector('#reason').value;
    await send('/review/'+task.id+'/adjudicate',reason?{reason}:{reference:document.querySelector('#reference').value});
    adjudication.reset();adjudication.hidden=true;
    const r=await fetch(api+'/review/'+task.id+'/adjudicate');
    if(!r.ok){await next();return}
    const qc=await r.json();
    text('#final',qc.resolution.reference??qc.resolution.reason);
    text('#prompt',qc.prompt);document.querySelector('#qc').hidden=false;
  }catch{failure()}
});
document.querySelector('#next').addEventListener('click',next);`;
const lang = `<label>שפה / Language <select id="lang"><option value="he">עברית</option><option value="en">English</option></select></label>`;
const writer = `<h1>הגשת כתב יד / Handwriting submission</h1>${lang}<section id="info"><p id="assignment"></p><pre id="prompt" dir="rtl"></pre><p id="consent"></p></section><form hidden>
<label><input type="checkbox" required> קראתי ואני מסכים/ה / I have read and agree</label><label>תמונה / Image <input id="file" type="file" accept="image/jpeg,image/png" required></label><button>שליחה / Submit</button></form>`;
const review = `<h1>תמלול כתב יד / Handwriting transcription</h1>${lang}<form id="agreement"><p id="wording" dir="auto"></p><label><input type="checkbox" required> קראתי ואני מסכים/ה / I have read and agree</label><button>המשך / Continue</button></form>
<section id="review" hidden><img alt="שורה מהסריקה / Line crop"><form hidden><label>תמלול / Transcription<textarea id="transcription" dir="rtl"></textarea></label>
<label>סימון / Flag <select id="issue"><option value="none">None</option><option value="literal">Copy differs</option><option value="ambiguous">Ambiguous</option><option value="unreadable">Unreadable</option><option value="geometry">Crop</option><option value="privacy">Privacy</option></select></label><button>שמירה / Save</button></form>
<form id="adjudication" hidden><pre id="reads" dir="auto"></pre>
<label>תמלול סופי / Final transcription<textarea id="reference" dir="rtl"></textarea></label><label>הוצאה / Exclusion <select id="reason"><option value="">None</option><option>unreadable</option><option>ambiguous</option><option>privacy</option><option>incomplete</option></select></label><button>שמירה / Save</button></form>
<section id="qc" hidden><p>נוסח שאושר / Final reference</p><pre id="final" dir="auto"></pre><p>טקסט ההעתקה / Prompt</p><pre id="prompt" dir="rtl"></pre><button id="next">המשך / Continue</button></section></section>`;

export function intakeForm(isReview: boolean) {
  const nonce = randomId("", 16);
  // The page contains only interface strings. Protocol wording and prompts arrive as private text and use textContent.
  return new Response(`<!doctype html><html lang="he"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HeOCR | Handwriting</title><style nonce="${nonce}">${style}#consent,#wording{white-space:pre-wrap}</style><main>${isReview ? review : writer}<p id="result" role="status"></p></main><script nonce="${nonce}">${(isReview ? reviewScript : writerScript)}</script></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; connect-src 'self'; img-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      "x-content-type-options": "nosniff" } });
}
