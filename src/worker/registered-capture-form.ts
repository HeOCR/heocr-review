import { CAPTURE_API } from "../shared/registered-captures";
import { randomId } from "./crypto";

// The feature remains disabled until the private roster and this interface copy are approved.
const copy = {
  title: ["העלאת צילומי עמודים", "Upload page photos"],
  files: ["קובצי צילום מקוריים", "Original photo files"],
  phone: ["טלפון", "Phone"],
  camera_mode: ["מצב מצלמה", "Camera mode"],
  printer: ["מדפסת", "Printer"],
  paper: ["נייר", "Paper"],
  orientation: ["כיוון", "Orientation"],
  angle: ["זווית", "Angle"],
  lighting: ["תאורה", "Lighting"],
  retake: ["סיבת צילום מחדש", "Retake reason"],
  submit: ["העלאה", "Upload"],
  failed: ["ההעלאה לא הושלמה. בדקו את הפרטים או נסו שוב.", "Upload could not be completed. Check the details or retry."],
  received: ["הקובץ נשמר", "File saved"],
  filename: ["שם הקובץ אינו תואם לשיבוץ ברשימה, או שנבחרו כמה קבצים לאותו שיבוץ.", "The filename does not match a registered slot, or more than one file was selected for that slot."],
} as const;
const label = (key: keyof typeof copy) => copy[key].join(" / ");
const common = ["phone", "camera_mode", "printer", "paper"] as const;
const perFile = ["orientation", "angle", "lighting"] as const;

const js = `
const api=${JSON.stringify(CAPTURE_API)}, copy=${JSON.stringify(copy)};
const label=key=>copy[key].join(" / ");
const common=${JSON.stringify(common)}, perFile=${JSON.stringify(perFile)};
const form=document.querySelector('form'), files=document.querySelector('#files');
const list=document.querySelector('#files-to-upload'), status=document.querySelector('#status'), progress=document.querySelector('#progress');
const button=form.querySelector('button');
const slots=new Map();let pin,pending=[];
const field=(key,required)=>{
  const el=document.createElement('label');el.textContent=label(key);
  const input=document.createElement('input');input.maxLength=key==='retake'?240:160;input.required=required;input.dir='auto';
  el.append(input);return {el,input};
};
function update(){
  progress.textContent=[...slots.values()].filter(slot=>slot.current).length+' / '+slots.size;
}
async function start(){
  try{
    const response=await fetch(api);
    if(!response.ok)throw Error();
    const info=await response.json();pin=info.roster_sha256;
    for(const page of info.pages)for(const slot of page.slots)slots.set(page.page_id+'-'+slot.slot,slot);
    update();form.hidden=false;
  }catch{status.textContent=label('failed')}
}
files.addEventListener('change',()=>{
  list.replaceChildren();status.textContent='';pending=[];const seen=new Set();
  for(const file of files.files){
    const name=/^([A-Z0-9-]+)\\.(?:jpg|jpeg|png|heic|heif)$/.exec(file.name.replace(/\\.[A-Za-z]+$/,e=>e.toLowerCase()))?.[1];
    const slot=slots.get(name);
    if(!slot||seen.has(name)){status.textContent=label('filename');pending=[];list.replaceChildren();button.disabled=true;return}
    seen.add(name);
    const box=document.createElement('fieldset'), heading=document.createElement('legend');
    heading.dir='auto';heading.textContent=file.name+' · '+slot.condition;box.append(heading);
    const inputs={};
    for(const key of perFile){const {el,input}=field(key,true);box.append(el);inputs[key]=input}
    if(slot.current){const {el,input}=field('retake',false);box.append(el);inputs.retake=input}
    const note=document.createElement('p');note.setAttribute('role','status');box.append(note);
    list.append(box);pending.push({file,slot,inputs,note,done:false});
  }
  button.disabled=!pending.length;
});
form.addEventListener('submit',async event=>{
  event.preventDefault();button.disabled=true;files.disabled=true;
  let failed=false;
  try{
    const base=Object.fromEntries(common.map(key=>[key,document.querySelector('#'+key).value]));
    for(const item of pending){
      if(item.done)continue;
      const log={...base,...Object.fromEntries(perFile.map(key=>[key,item.inputs[key].value]))};
      const headers={'x-capture-roster':pin,'x-capture-filename':item.file.name};
      if(item.slot.current&&item.inputs.retake?.value.trim()){
        headers['x-capture-replaces']=item.slot.current.sha256;log.retake_reason=item.inputs.retake.value;
      }
      headers['x-capture-log']=encodeURIComponent(JSON.stringify(log));
      try{
        const response=await fetch(api+'/upload',{method:'POST',headers,body:item.file});
        if(!response.ok)throw Error();
        item.slot.current=await response.json();item.done=true;item.note.textContent=label('received');update();
      }catch{failed=true;item.note.textContent=label('failed')}
    }
  }finally{button.disabled=!failed;files.disabled=false}
});
start();`;

export function captureForm() {
  const nonce = randomId("", 16);
  const fields = common.map(key => `<label for="${key}">${label(key)}<input id="${key}" dir="auto" required maxlength="160"></label>`).join("");
  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${label("title")}</title>
  <style nonce="${nonce}">body{box-sizing:border-box;max-width:46rem;margin:1rem auto;padding:0 1rem;font:1rem/1.5 system-ui;color:#172431}
  label,fieldset{display:block;margin:.65rem 0}input,button{font:inherit;max-width:100%;padding:.45rem}label input{display:block}
  input:not([type=file]){box-sizing:border-box;width:100%}legend{overflow-wrap:anywhere}button{min-height:44px}p:empty{display:none}</style></head>
  <body><main><h1>${label("title")}</h1><p id="progress" dir="ltr"></p>
  <form hidden>${fields}<label for="files">${label("files")}<input id="files" type="file" accept=".jpg,.jpeg,.png,.heic,.heif" multiple required></label>
  <div id="files-to-upload"></div><button disabled>${label("submit")}</button></form><p id="status" role="status"></p></main>
  <script nonce="${nonce}">${js}</script></body></html>`;
  return new Response(html, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "cdn-cache-control": "no-store",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  } });
}
