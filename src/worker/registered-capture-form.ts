import { CAPTURE_API, TRAIN_CAPTURE_API } from "../shared/registered-captures";
import { randomId } from "./crypto";

// The feature remains disabled until the private roster and this interface copy are approved.
const copy = {
  title: ["העלאת צילומי עמודים", "Upload page photos"],
  eval: ["ערכת הערכה בלבד", "Evaluation pack only"],
  train: ["ערכת אימון בלבד", "Training pack only"],
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
  page: ["עמוד", "Page"],
  slot: ["שיבוץ", "Slot"],
  condition: ["תנאי צילום", "Capture condition"],
  device: ["מכשיר A או B", "Device A or B"],
  choose: ["בחרו", "Choose"],
  duplicate: ["בחרו שיבוץ נפרד לכל צילום.", "Choose a separate slot for each photo."],
  checking: ["בודקים את הצילום…", "Checking photo…"],
  inspect: ["בדקו את חדות הטקסט ואת ארבע פינות הדף בתצוגה.", "Check text sharpness and all four page corners in the preview."],
  soft: ["ייתכן שהטקסט מטושטש או שהניגודיות נמוכה. בדקו בהגדלה או צלמו שוב.", "Text may be blurry or low contrast. Inspect it at full size or retake."],
  edge: ["ייתכן שהדף מגיע לשולי התמונה. בדקו אם משהו נחתך.", "The page may touch the image edge. Check for clipping."],
  manual: ["אין תצוגה בדפדפן. בדקו חדות ואת ארבע פינות הדף באפליקציית התמונות.", "No browser preview. Check sharpness and all four page corners in your photo app."],
  confirmed: ["בדקתי: הטקסט חד וכל הדף בתמונה.", "I checked that the text is sharp and the whole page is visible."],
  remove: ["להסיר ולצלם שוב", "Remove and retake"],
  progress: ["צילומים שנשמרו", "Photos saved"],
} as const;
const label = (key: keyof typeof copy) => copy[key].join(" / ");
const common = ["phone", "camera_mode", "printer", "paper"] as const;
const perFile = ["orientation", "angle", "lighting"] as const;

const js = (train: boolean) => `
const api=${JSON.stringify(train ? TRAIN_CAPTURE_API : CAPTURE_API)}, train=${train}, copy=${JSON.stringify(copy)};
const label=key=>copy[key].join(" / ");
const common=${JSON.stringify(common)}, perFile=${JSON.stringify(perFile)};
const form=document.querySelector('form'), files=document.querySelector('#files');
const list=document.querySelector('#files-to-upload'), status=document.querySelector('#status'), progress=document.querySelector('#progress');
const button=form.querySelector('button');
const pages=new Map(), assignments=[];let pin,pending=[],sending=false;
const field=(key,required)=>{
  const el=document.createElement('label');el.textContent=label(key);
  const input=document.createElement('input');input.maxLength=key==='retake'?240:160;input.required=required;input.dir='auto';
  el.append(input);return {el,input};
};
function update(){
  progress.textContent=label('progress')+' · '+assignments.filter(slot=>slot.current).length+' / '+assignments.length;
}
function picker(key){
  const el=document.createElement('label');el.textContent=label(key);
  const select=document.createElement('select');select.required=true;select.dir='auto';el.append(select);
  return {el,select};
}
function option(value,text){
  const el=document.createElement('option');el.value=value;el.textContent=text;return el;
}
function selectedSlot(item){
  return pages.get(item.page.value)?.find(s=>s.slot===item.assignment.value);
}
function missing(slot,item){
  return !slot.current&&!pending.some(other=>other!==item&&!other.done&&selectedSlot(other)===slot);
}
function fillSlots(item,value){
  const slots=pages.get(item.page.value)??[];
  item.assignment.replaceChildren(option('',label('choose')),
    ...slots.map(s=>option(s.slot,s.slot+' · '+s.condition+(s.current?' ✓':''))));
  item.assignment.value=value??slots.find(slot=>missing(slot,item))?.slot??'';
}
function refreshButton(){
  const unsaved=pending.filter(item=>!item.done);
  const used=new Set();let duplicate=false,unready=false;
  for(const item of unsaved){
    const slot=selectedSlot(item);
    const replacing=!!slot?.current;
    item.retake.el.hidden=!replacing;
    item.retake.input.required=replacing;
    if(slot&&used.has(slot))duplicate=true;
    if(slot)used.add(slot);
    unready||=!slot||item.checked.disabled||!item.checked.checked||
      (train&&!item.device.value)||(replacing&&!item.retake.input.value.trim());
  }
  if(!form.hidden)status.textContent=duplicate?label('duplicate'):'';
  button.disabled=sending||!unsaved.length||duplicate||unready;
}
async function start(){
  try{
    let cursor=0;
    do{
      const response=await fetch(api+'?cursor='+cursor);
      if(!response.ok)throw Error();
      const info=await response.json();
      if(pin&&pin!==info.roster_sha256)throw Error();
      pin=info.roster_sha256;
      for(const page of info.pages){
        const slots=page.slots.map(slot=>({...slot,page_id:page.page_id}));
        pages.set(page.page_id,slots);
        assignments.push(...slots);
      }
      cursor=info.next;
    }while(cursor!==null);
    update();form.hidden=false;
  }catch{status.textContent=label('failed')}
}
function quality(rgba,w,h){
  // At preview scale, too few strong second differences signal low edge detail.
  const luma=new Float32Array(w*h);
  for(let i=0;i<luma.length;i++)luma[i]=0.21*rgba[4*i]+0.72*rgba[4*i+1]+0.07*rgba[4*i+2];
  let high=0, samples=0, light=0, edge=0, edgeLight=0;
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x, p=luma[i];
    if(x>w*.1&&x<w*.9&&y>h*.1&&y<h*.9){
      samples++;light+=p;
      const d=4*p-luma[i-1]-luma[i+1]-luma[i-w]-luma[i+w];
      if(Math.abs(d)>18)high++;
    }
    if(x<4||x>w-5||y<4||y>h-5){
      edge++;
      if(p>205)edgeLight++;
    }
  }
  return { soft:!samples||high/samples<.025||light/samples<24, edge:edge>0&&edgeLight/edge>.48 };
}
async function checkPhoto(item){
  const url=URL.createObjectURL(item.file);
  try{
    const photo=new Image();photo.src=url;
    await photo.decode();
    const scale=Math.min(1,512/Math.max(photo.naturalWidth,photo.naturalHeight));
    const w=Math.max(1,Math.round(photo.naturalWidth*scale)), h=Math.max(1,Math.round(photo.naturalHeight*scale));
    const canvas=item.canvas;canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(photo,0,0,w,h);
    const result=quality(ctx.getImageData(0,0,w,h).data,w,h);
    canvas.hidden=false;
    item.check.textContent=[label('inspect'),...(result.soft?[label('soft')]:[]),...(result.edge?[label('edge')]:[])].join(' ');
  }catch{
    item.check.textContent=label('manual');
  }finally{
    URL.revokeObjectURL(url);item.checked.disabled=false;refreshButton();
  }
}
files.addEventListener('change',async()=>{
  const selected=[...files.files];files.value='';
  list.replaceChildren();status.textContent='';pending=[];
  for(const file of selected){
    const next=assignments.find(slot=>missing(slot));
    const box=document.createElement('fieldset'), heading=document.createElement('legend');
    heading.dir='auto';heading.textContent=file.name;box.append(heading);
    const page=picker('page'), assignment=picker(train?'condition':'slot'), device=train?picker('device'):null;
    page.select.append(option('',label('choose')),...[...pages.keys()].map(id=>option(id,id)));
    page.select.value=next?.page_id??'';
    box.append(page.el,assignment.el);
    if(device){device.select.append(option('',label('choose')),option('A','A'),option('B','B'));box.append(device.el)}
    const inputs={};
    for(const key of perFile){const {el,input}=field(key,true);box.append(el);inputs[key]=input}
    const retake=field('retake',false);retake.el.hidden=true;box.append(retake.el);
    const canvas=document.createElement('canvas');canvas.hidden=true;canvas.setAttribute('aria-hidden','true');box.append(canvas);
    const check=document.createElement('p');check.setAttribute('role','status');check.textContent=label('checking');box.append(check);
    const confirmation=document.createElement('label'), checked=document.createElement('input');
    checked.type='checkbox';checked.disabled=true;checked.addEventListener('change',refreshButton);
    confirmation.append(checked,' '+label('confirmed'));box.append(confirmation);
    const remove=document.createElement('button');remove.type='button';remove.textContent=label('remove');box.append(remove);
    const note=document.createElement('p');note.setAttribute('role','status');box.append(note);
    const item={file,page:page.select,assignment:assignment.select,device:device?.select,retake,box,inputs,note,check,canvas,checked,remove,done:false};
    fillSlots(item,next?.slot);
    page.select.addEventListener('change',()=>{retake.input.value='';fillSlots(item);refreshButton()});
    assignment.select.addEventListener('change',()=>{retake.input.value='';refreshButton()});
    device?.select.addEventListener('change',refreshButton);
    retake.input.addEventListener('input',refreshButton);
    remove.addEventListener('click',()=>{pending=pending.filter(candidate=>candidate!==item);box.remove();refreshButton()});
    list.append(box);pending.push(item);
  }
  refreshButton();
  for(const item of pending)if(pending.includes(item))await checkPhoto(item);
});
form.addEventListener('submit',async event=>{
  event.preventDefault();if(button.disabled||sending)return;
  sending=true;button.disabled=true;files.disabled=true;
  const controls=[...form.elements].filter(el=>!el.disabled);
  for(const control of controls)control.disabled=true;
  try{
    const base=Object.fromEntries(common.map(key=>[key,document.querySelector('#'+key).value]));
    for(const item of pending){
      if(item.done)continue;
      const log={...base,...Object.fromEntries(perFile.map(key=>[key,item.inputs[key].value]))};
      const slot=selectedSlot(item);
      const headers={'x-capture-roster':pin,'x-capture-filename':encodeURIComponent(item.file.name),
        'x-capture-page':slot.page_id,'x-capture-slot':slot.slot};
      if(train)headers['x-capture-device']=item.device.value;
      if(slot.current){
        headers['x-capture-replaces']=slot.current.sha256;log.retake_reason=item.retake.input.value;
      }
      headers['x-capture-log']=encodeURIComponent(JSON.stringify(log));
      try{
        const response=await fetch(api+'/upload',{method:'POST',headers,body:item.file});
        if(!response.ok)throw Error();
        slot.current=await response.json();item.done=true;item.remove.hidden=true;
        const digest=document.createElement('code');digest.dir='ltr';digest.textContent=slot.current.sha256;
        item.note.replaceChildren(label('received'),' · ',digest);update();
      }catch{item.note.textContent=label('failed')}
    }
  }finally{
    for(const control of controls)control.disabled=false;
    for(const item of pending)if(item.done)item.box.disabled=true;
    sending=false;files.disabled=false;refreshButton();
  }
});
start();`;

export function captureForm(train: boolean) {
  const nonce = randomId("", 16);
  const fields = common.map(key => `<label for="${key}">${label(key)}<input id="${key}" dir="auto" required maxlength="160"></label>`).join("");
  const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${label("title")}</title>
  <style nonce="${nonce}">body{box-sizing:border-box;max-width:46rem;margin:1rem auto;padding:0 1rem;font:1rem/1.5 system-ui;color:#172431}
  label,fieldset{display:block;margin:.65rem 0}input,button,select{font:inherit;max-width:100%;padding:.45rem}label input:not([type=checkbox]),select{display:block}
  input:not([type=file],[type=checkbox]),select{box-sizing:border-box;width:100%}legend,code{overflow-wrap:anywhere}button,select{min-height:44px}
  canvas{max-width:min(100%,22rem);height:auto;border:1px solid #a8b7c4}p:empty,[hidden]{display:none}</style></head>
  <body><main><h1>${label("title")} · ${label(train ? "train" : "eval")}</h1><p id="progress" dir="auto"></p>
  <form hidden>${fields}<label for="files">${label("files")}<input id="files" type="file" accept=".jpg,.jpeg,.png,.heic,.heif${train ? ",.dng" : ""}" multiple></label>
  <div id="files-to-upload"></div><button disabled>${label("submit")}</button></form><p id="status" role="status"></p></main>
  <script nonce="${nonce}">${js(train)}</script></body></html>`;
  return new Response(html, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "cdn-cache-control": "no-store",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; connect-src 'self'; img-src blob:; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  } });
}
