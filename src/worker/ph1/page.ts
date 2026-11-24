const escapeHtml = (text: string) => text.replace(/[&<>"']/g,ch =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[ch]!);

export function uploadPage(consent: {version:string; text:string}, participants: string[]) {
  return `<!doctype html>
<html lang="he" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>העלאת תמונות מהטלפון</title>
<style>
  *{box-sizing:border-box}body{margin:0;font:1rem/1.6 system-ui,sans-serif;color:#182b29;background:#f3f7f5}
  main{max-width:35rem;margin:auto;padding:2rem 1rem}h1{font-size:1.7rem;line-height:1.25;margin:0 0 .5rem}
  p{margin:.5rem 0 1rem}form{padding:1.1rem;background:white;border:1px solid #d6e2db;border-radius:.75rem}
  label{display:block;margin:0 0 1rem;font-weight:600}
  input:not([type=checkbox]),select,button{font:inherit;width:100%;min-height:2.8rem;border-radius:.45rem}
  input:not([type=checkbox]),select{margin-top:.25rem;padding:.4rem .55rem;border:1px solid #677a73;background:white;color:inherit}
  .consent{display:flex;align-items:start;gap:.65rem;font-weight:400}.consent input{flex:none;width:1.3rem;height:1.3rem;margin:.18rem 0 0}
  button{background:#176454;border:0;color:white;font-weight:700;cursor:pointer}button:disabled{opacity:.6;cursor:wait}
  :focus-visible{outline:3px solid #386ad1;outline-offset:2px}ul{padding-inline-start:1.5rem;overflow-wrap:anywhere}
  #status{font-weight:600;margin-top:1rem}
</style>
<script src="/ph1/upload.js" defer></script></head>
<body><main><h1>העלאת תמונות מהטלפון</h1>
<p>בחרו את קוד המשתתף שקיבלתם והעלו את קובצי הצילום המקוריים. אפשר לבחור כמה תמונות יחד. כבו את שמירת המיקום במצלמה וצלמו רק את הדף.</p>
<form id="upload" data-consent-version="${escapeHtml(consent.version)}">
  <label>קוד האירוע <input id="event" type="password" required maxlength="64" autocomplete="off" dir="ltr"></label>
  <label>קוד משתתף <select id="participant" required><option value="">בחרו קוד</option>
  ${participants.map(p=>`<option value="${p}">${p}</option>`).join("")}</select></label>
  <label class="consent"><input type="checkbox" id="consent" required><span>${escapeHtml(consent.text)}</span></label>
  <label>תמונות מקוריות (JPEG, HEIC או PNG)
    <input id="photos" type="file" accept=".jpg,.jpeg,.heic,.heif,.png,image/jpeg,image/heic,image/png" multiple required>
  </label>
  <button type="submit">העלאת תמונות</button>
  <p id="status" role="status" aria-live="polite">הועלו 0 תמונות</p>
  <ul id="failed" hidden aria-label="תמונות שלא הועלו"></ul>
</form></main></body></html>`;
}

export const uploadScript = `"use strict";
const form = document.querySelector("#upload");
const eventCode = document.querySelector("#event");
const participant = document.querySelector("#participant");
const consent = document.querySelector("#consent");
const photos = document.querySelector("#photos");
const status = document.querySelector("#status");
const failed = document.querySelector("#failed");
const button = form.querySelector("button");
let uploaded = 0;
const received = new Set();
participant.addEventListener("change", () => { consent.checked = false; });
form.addEventListener("submit", async e => {
  e.preventDefault();
  if (button.disabled || !form.reportValidity()) return;
  const files = Array.from(photos.files);
  const code = eventCode.value.trim();
  const selected = participant.value;
  const errors = {
    event_closed: "האירוע סגור או שקוד האירוע שגוי",
    consent_required: "יש לקרוא ולאשר את נוסח ההסכמה",
    unsupported_or_unsafe_photo: "לא ניתן להסיר את נתוני המיקום מהקובץ בבטחה. נסו קובץ צילום מקורי אחר",
    body_too_large: "הקובץ גדול מדי (עד 20 מגה־בייט)",
    capture_limit: "מכסת התמונות לאירוע התמלאה",
    rate_limited: "נסו שוב בעוד דקה",
    capture_busy: "נסו להעלות שוב בעוד רגע",
    invalid_filename: "יש לבחור קובץ עם שם תקין"
  };
  for (const input of [eventCode, participant, consent, photos, button]) input.disabled = true;
  failed.replaceChildren();
  failed.hidden = true;
  let failures = 0;
  try {
    for (const [i, file] of files.entries()) {
      status.textContent = "מעלה תמונה " + (i + 1) + " מתוך " + files.length + "… הועלו " + uploaded + " תמונות";
      let error;
      try {
        const response = await fetch("/api/ph1/upload", {
          method:"POST", credentials:"omit", body:file, headers:{
            "content-type":"application/octet-stream",
            "x-ph1-event-code":code,
            "x-ph1-participant":selected,
            "x-ph1-consent":"confirmed",
            "x-ph1-consent-version":form.dataset.consentVersion,
            "x-ph1-filename":encodeURIComponent(file.name)
          }
        });
        const result = await response.json();
        if (!response.ok) error = errors[result.error] || "ההעלאה נכשלה";
        else if (!received.has(result.receipt)) {
          received.add(result.receipt);
          uploaded++;
        }
      } catch {
        error = "אין חיבור או שההעלאה נכשלה";
      }
      if (error) {
        failures++;
        const row = document.createElement("li");
        const name = document.createElement("bdi");
        name.textContent = file.name;
        row.append(name, " – " + error);
        failed.append(row);
      }
    }
    if (!failures) photos.value = "";
  } finally {
    status.textContent = "הועלו " + uploaded + " תמונות" + (failures ? " · לא הועלו " + failures : "");
    failed.hidden = failures === 0;
    for (const input of [eventCode, participant, consent, photos, button]) input.disabled = false;
  }
});
`;
