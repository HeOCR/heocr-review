import type { Ctx } from "../api";
import { assertSameOrigin, HttpError, json, readBytes } from "../http";
import { canonicalContributorOrigin, hash } from "../contributor/config";
import { clientKey, enforce } from "../ratelimit";
import { UnsupportedPhoto } from "./exif";
import { sanitizePhoto } from "./photo";
import { uploadPage, uploadScript } from "./page";

const event = "ph1-phone-2026-11-26-to-2026-11-29";
const opens = "2026-11-26T00:00:00+02:00";
const closes = "2026-12-01T00:00:00+02:00";
const startsAt = Date.parse(opens);
const closesAt = Date.parse(closes);
const prefix = `ph1/quarantine/${event}/photos/`;
const cap = 420;
const maxBytes = 20*1024*1024;
const participants = Array.from({length:20},(_,i) => "P"+String(i+1).padStart(2,"0"));
const digest = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const fail = (status: number, code: string): never => { throw new HttpError(status,code); };
const headers = {
  "cache-control":"private, no-store",
  "cdn-cache-control":"no-store",
  "x-content-type-options":"nosniff",
  "referrer-policy":"no-referrer",
  "cross-origin-resource-policy":"same-origin",
  "x-robots-tag":"noindex, nofollow",
};
const keyFor = (ordinal: number) => prefix+String(ordinal).padStart(3,"0");
const receiptFor = (ordinal: number) => String(ordinal).padStart(3,"0");

export const hasPh1OperatorBearer = (request: Request) =>
  /^Bearer +heocr_ph1_v1_/i.test(request.headers.get("authorization") ?? "");
export const isPh1Path = (path: string) => path === "/ph1" || path.startsWith("/ph1/") ||
  path === "/api/ph1" || path.startsWith("/api/ph1/");

async function matches(code: string, verifier: string | undefined) {
  return verifier !== undefined && digest.test(verifier) &&
    crypto.subtle.timingSafeEqual(encoder.encode(await hash(code)),encoder.encode(verifier));
}

const approvedConsent = {
  version:"ph1-2026-11-25-amendment-1",
  text:{
    en:"By uploading, you release these photos under CC0. Please don't photograph people.",
    he:"בהעלאת התמונות אתם משחררים אותן לשימוש חופשי לפי CC0. נא לא לצלם אנשים.",
  },
} as const;

function consentConfig(value: string | undefined) {
  if (!value || value.length>4096) return null;
  try {
    const body = JSON.parse(value) as {version?:unknown; text?:{he?:unknown; en?:unknown}} | null;
    if (body?.version !== approvedConsent.version || body.text?.he !== approvedConsent.text.he ||
        body.text?.en !== approvedConsent.text.en) return null;
    return approvedConsent;
  } catch { return null; }
}
function filename(request: Request) {
  let name: string;
  try { name=decodeURIComponent(request.headers.get("x-ph1-filename") ?? ""); }
  catch { return fail(400,"invalid_filename"); }
  if (!name || name==="." || name===".." || encoder.encode(name).length>240 ||
      /[\u0000-\u001f\u007f/\\]/.test(name)) return fail(400,"invalid_filename");
  return name;
}
async function entries(bucket: R2Bucket) {
  const rows = new Map<number,R2Object>();
  let cursor: string | undefined;
  do {
    const page: R2Objects = await bucket.list({prefix,cursor,limit:cap,include:["customMetadata"]});
    for (const item of page.objects) {
      const ordinal = Number(item.key.slice(prefix.length));
      if (ordinal>=1 && ordinal<=cap && item.key===keyFor(ordinal)) rows.set(ordinal,item);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return rows;
}

async function upload(ctx: Ctx, bucket: R2Bucket, consent: typeof approvedConsent) {
  const { request, env, now } = ctx;
  assertSameOrigin(request);
  enforce({bucket:"ph1-attempt",max:120,windowS:60},await clientKey(env,request),now);
  const code = request.headers.get("x-ph1-event-code") ?? "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(code) || !await matches(code,env.PH1_EVENT_CODE_SHA256))
    return fail(403,"event_closed");
  const language = request.headers.get("x-ph1-consent-language");
  if (request.headers.get("x-ph1-consent") !== "confirmed" ||
      request.headers.get("x-ph1-consent-version") !== consent.version ||
      (language !== "he" && language !== "en")) return fail(409,"consent_required");
  const declared = request.headers.get("x-ph1-transfer");
  if (declared !== null && declared !== "recompressed") return fail(400,"invalid_transfer");
  const participant = request.headers.get("x-ph1-participant") ?? "";
  if (!participants.includes(participant)) return fail(400,"invalid_participant");
  const originalFilename = filename(request);
  if (request.headers.get("content-type") !== "application/octet-stream") return fail(415,"photo_required");
  const data = await readBytes(request,maxBytes,"photo_required");
  const originalSha256 = await hash(data);
  let safe;
  try { safe = sanitizePhoto(data); }
  catch (error) {
    if (error instanceof UnsupportedPhoto) return fail(415,"unsupported_or_unsafe_photo");
    throw error;
  }
  const sanitizedSha256 = await hash(safe.bytes);
  const metadata = {
    participant, originalFilename, originalSha256, sanitizedSha256, mime:safe.mime,
    make:safe.meta.make ?? "", model:safe.meta.model ?? "",
    removedTags:JSON.stringify([...safe.meta.removed].sort()),
    transfer:declared ?? "unknown",
    consentVersion:consent.version, consentLanguage:language, consentSha256:await hash(consent.text[language]),
    receivedAt:new Date(now).toISOString(),
  };
  if (encoder.encode(JSON.stringify(metadata)).length>1900) return fail(415,"unsupported_or_unsafe_photo");

  // A successful conditional PUT is the only admission write. No counter, reservation row, or raw object.
  for (let attempt=0;attempt<20;attempt++) {
    const listed = await entries(bucket);
    const duplicate = [...listed].find(([,photo]) =>
      photo.customMetadata?.originalSha256 === originalSha256 && photo.customMetadata.participant === participant);
    if (duplicate) return json({uploaded:1,receipt:receiptFor(duplicate[0]),duplicate:true},200,headers);
    let ordinal = 1;
    while (listed.has(ordinal)) ordinal++;
    if (ordinal>cap) return fail(409,"capture_limit");
    if (Date.now()>=closesAt) return fail(403,"event_closed");
    const stored = await bucket.put(keyFor(ordinal),safe.bytes,{
      onlyIf:{etagDoesNotMatch:"*"}, customMetadata:metadata,
      httpMetadata:{contentType:safe.mime,cacheControl:"private, no-store"},
    });
    if (stored) return json({uploaded:1,receipt:receiptFor(ordinal),duplicate:false},201,headers);
  }
  return fail(503,"capture_busy");
}

async function operator(ctx: Ctx, bucket: R2Bucket) {
  const {request,env,url} = ctx;
  const token = /^Bearer (heocr_ph1_v1_[A-Za-z0-9_-]{43})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (request.method!=="GET" || !token || !await matches(token,env.PH1_OPERATOR_SHA256)) return fail(404,"not_found");
  if (url.pathname==="/api/ph1/operator/export") {
    const listed = await entries(bucket);
    const photos = [...listed].sort(([a],[b])=>a-b).map(([ordinal,item]) => {
      const m = item.customMetadata!;
      return {
        receipt:receiptFor(ordinal), participant:m.participant, original_filename:m.originalFilename,
        original_sha256:m.originalSha256, sanitized_sha256:m.sanitizedSha256,
        bytes:item.size, mime:m.mime, make:m.make || null, model:m.model || null,
        removed_tags:JSON.parse(m.removedTags!) as string[],
        transfer:m.transfer, received_at:m.receivedAt,
        consent_version:m.consentVersion, consent_language:m.consentLanguage, consent_sha256:m.consentSha256,
        download:`/api/ph1/operator/photos/${receiptFor(ordinal)}`,
      };
    });
    // One initial consent per participant. Individual uploads retain their own language and digest.
    const initial = new Map<string,{participant:string; date:string; version:string; language:string; sha256:string}>();
    for (const photo of photos) {
      if (!photo.participant || initial.has(photo.participant)) continue;
      const israelDate = new Date(Date.parse(photo.received_at!)+2*60*60*1000).toISOString().slice(0,10);
      initial.set(photo.participant,{
        participant:photo.participant,date:israelDate,version:photo.consent_version!,
        language:photo.consent_language!,sha256:photo.consent_sha256!,
      });
    }
    const consent = consentConfig(env.PH1_CONSENT);
    const consent_policy = consent && {
      version:consent.version, sha256:{he:await hash(consent.text.he),en:await hash(consent.text.en)},
    };
    return json({schema:"heocr.ph1_phone_intake.v1",event,date:opens.slice(0,10),
      window:{opens_at:opens,closes_at:closes},count:photos.length,cap,consent_policy,consents:[...initial.values()],photos},200,headers);
  }
  const id = /^\/api\/ph1\/operator\/photos\/([0-9]{3})$/.exec(url.pathname)?.[1];
  if (!id || Number(id)<1 || Number(id)>cap) return fail(404,"not_found");
  const object = await bucket.get(keyFor(Number(id)));
  if (!object || !object.customMetadata?.sanitizedSha256) return fail(404,"not_found");
  return new Response(object.body,{headers:{...headers,
    "content-type":"application/octet-stream",
    "content-disposition":`attachment; filename="ph1-${id}"`,
    "x-content-sha256":object.customMetadata.sanitizedSha256,
  }});
}

export async function ph1Intake(ctx: Ctx): Promise<Response> {
  const { env,url,request,now } = ctx;
  const bucket = env.RESTRICTED_REFERENCE_MEDIA;
  if (!bucket || url.search || !canonicalContributorOrigin(env,url)) return fail(404,"not_found");
  // Read-only operator access persists when the capture window closes.
  if (url.pathname.startsWith("/api/ph1/operator/")) return operator(ctx,bucket);
  if (env.PH1_CAPTURE_ENABLED!=="1") return fail(404,"not_found");
  const consent = consentConfig(env.PH1_CONSENT);
  if (!consent || !digest.test(env.PH1_EVENT_CODE_SHA256 ?? "")) return fail(404,"not_found");
  if (now<startsAt || now>=closesAt) return fail(403,"event_closed");
  if (request.method==="GET" && (url.pathname==="/ph1" || url.pathname==="/ph1/")) {
    return new Response(uploadPage(consent,participants),{headers:{...headers,
      "content-type":"text/html; charset=utf-8",
      "content-security-policy":"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    }});
  }
  if (request.method==="GET" && url.pathname==="/ph1/upload.js") {
    return new Response(uploadScript,{headers:{...headers,"content-type":"application/javascript; charset=utf-8"}});
  }
  if (request.method==="POST" && url.pathname==="/api/ph1/upload") return upload(ctx,bucket,consent);
  return fail(404,"not_found");
}
