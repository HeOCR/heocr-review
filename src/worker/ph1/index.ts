import type { Ctx } from "../api";
import { assertSameOrigin, HttpError, json, readBytes } from "../http";
import { canonicalContributorOrigin, hash } from "../contributor/config";
import { clientKey, enforce } from "../ratelimit";
import { UnsupportedPhoto } from "./exif";
import { sanitizePhoto } from "./photo";
import { uploadPage, uploadScript } from "./page";

const event = "ph1-phone-2026-11-26";
const day = "2026-11-26";
const startsAt = Date.parse("2026-11-26T00:00:00+02:00");
const closesAt = Date.parse("2026-11-27T00:00:00+02:00");
const prefix = `ph1/quarantine/${event}/photos/`;
const cap = 240;
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

function consentConfig(value: string | undefined) {
  if (!value || value.length>4096) return null;
  try {
    const body = JSON.parse(value) as {version?:unknown; text?:unknown} | null;
    if (typeof body?.version !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(body.version) ||
        typeof body.text !== "string" || !body.text.trim() || body.text.length>1000 ||
        /[\u0000-\u001f\u007f]/.test(body.text)) return null;
    return {version:body.version,text:body.text};
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

async function upload(ctx: Ctx, bucket: R2Bucket, consent: {version:string; text:string}) {
  const { request, env, now } = ctx;
  assertSameOrigin(request);
  enforce({bucket:"ph1-attempt",max:120,windowS:60},await clientKey(env,request),now);
  const code = request.headers.get("x-ph1-event-code") ?? "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(code) || !await matches(code,env.PH1_EVENT_CODE_SHA256))
    return fail(403,"event_closed");
  if (request.headers.get("x-ph1-consent") !== "confirmed" ||
      request.headers.get("x-ph1-consent-version") !== consent.version) return fail(409,"consent_required");
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
    consentVersion:consent.version, consentSha256:await hash(consent.text), receivedAt:new Date(now).toISOString(),
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
        received_at:m.receivedAt, consent_version:m.consentVersion, consent_sha256:m.consentSha256,
        download:`/api/ph1/operator/photos/${receiptFor(ordinal)}`,
      };
    });
    const consents = [...new Map(photos.map(p => [p.participant,{
      participant:p.participant, date:day, version:p.consent_version, sha256:p.consent_sha256,
    }])).values()];
    return json({schema:"heocr.ph1_phone_intake.v1",event,date:day,count:photos.length,cap,consents,photos},200,headers);
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
