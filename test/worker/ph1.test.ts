import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { photoFixture } from "../fixtures/ph1/photos";
import { hash } from "../../src/worker/contributor/config";
import type { Env } from "../../src/worker/env";
import { handle } from "../../src/worker/index";
import { sanitizePhoto } from "../../src/worker/ph1/photo";

const origin = "https://review.heocr.org";
const eventCode = "invented-office-code";
const operatorToken = "heocr_ph1_v1_"+"a".repeat(43);
const consent = {
  version:"ph1-2026-11-25-amendment-1",
  text:{
    en:"By uploading, you release these photos under CC0. Please don't photograph people.",
    he:"בהעלאת התמונות אתם משחררים אותן לשימוש חופשי לפי CC0. נא לא לצלם אנשים.",
  },
};
const prefix = "ph1/quarantine/ph1-phone-2026-11-26-to-2026-11-29/photos/";
const bucket = env.RESTRICTED_REFERENCE_MEDIA!;
const exec = {waitUntil() {},passThroughOnException() {},props:{}} as unknown as ExecutionContext;
const at = new Date("2026-11-26T00:00:00+02:00");
let config: Env;

beforeEach(async () => {
  const objects = await list();
  if (objects.length) await bucket.delete(objects.map(item => item.key));
  vi.useFakeTimers({toFake:["Date"]});
  vi.setSystemTime(at);
  config = {...env, ENVIRONMENT:"production", PH1_CAPTURE_ENABLED:"1",
    PH1_EVENT_CODE_SHA256:await hash(eventCode), PH1_OPERATOR_SHA256:await hash(operatorToken),
    PH1_CONSENT:JSON.stringify(consent)};
});
afterEach(() => vi.useRealTimers());

function get(path: string, token?: string, host = origin) {
  return handle(new Request(host+path,{headers:token ? {authorization:"Bearer "+token} : {}}),config,exec);
}
function send(bytes = photoFixture("jpg"), headers: Record<string,string> = {}) {
  return handle(new Request(origin+"/api/ph1/upload",{method:"POST",body:bytes,
    headers:{origin,"content-type":"application/octet-stream","x-ph1-event-code":eventCode,
      "x-ph1-participant":"P03","x-ph1-consent":"confirmed","x-ph1-consent-version":consent.version,
      "x-ph1-consent-language":"he","x-ph1-filename":encodeURIComponent("צילום 001.jpg"),...headers}}),config,exec);
}
async function list() {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page: R2Objects = await bucket.list({prefix,cursor,limit:256,include:["customMetadata"]});
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

it("denies signed-out uploads without the event code and requires an exact consent revision",async () => {
  const page = await get("/ph1");
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("private, no-store");
  const html = await page.text();
  expect(html).toContain('type="file"');
  expect(html).toContain("multiple required");
  expect(html).toContain(consent.text.he);
  expect(html).toContain(consent.text.en.replace("'","&#39;"));
  expect(html).toContain('type="checkbox" id="recompressed"');
  expect(html).not.toContain('id="recompressed" required');
  expect(html.match(/value="P\d\d"/g)).toHaveLength(20);
  expect(html).not.toContain(eventCode);
  expect((await get("/ph1/upload.js")).status).toBe(200);
  expect((await get("/ph1",undefined,"https://heocr-review.heocr.workers.dev")).status).toBe(404);
  expect((await send(undefined,{"x-ph1-event-code":""})).status).toBe(403);
  expect((await send(undefined,{"x-ph1-consent":""})).status).toBe(409);
  expect((await send(undefined,{"x-ph1-consent-version":"superseded"})).status).toBe(409);
  expect((await send(undefined,{"x-ph1-consent-language":"fr"})).status).toBe(409);
  expect((await send(undefined,{"x-ph1-transfer":"original"})).status).toBe(400);
  expect((await send(undefined,{"x-ph1-participant":"P21"})).status).toBe(400);
  expect((await send(undefined,{"x-ph1-filename":"..%2Ffile.jpg"})).status).toBe(400);
  expect((await send(undefined,{"content-length":String(21*1024*1024)})).status).toBe(413);
  expect((await send(undefined,{origin:"https://example.invalid"})).status).toBe(403);
  expect((await send(new Uint8Array([255,216,255,217]))).status).toBe(415);
  expect((await list())).toHaveLength(0);
});

it("honours Israel local midnight and fails closed until the flag, code and consent are configured",async () => {
  for (const time of ["2026-11-25T23:59:59+02:00","2026-12-01T00:00:00+02:00"]) {
    vi.setSystemTime(new Date(time));
    expect((await get("/ph1")).status).toBe(403);
    expect((await send()).status).toBe(403);
  }
  vi.setSystemTime(new Date("2026-11-30T23:59:59+02:00"));
  expect((await get("/ph1")).status).toBe(200);
  config.PH1_CONSENT=undefined;
  expect((await get("/ph1")).status).toBe(404);
  expect((await send()).status).toBe(404);
  config.PH1_CONSENT=JSON.stringify({...consent,text:{...consent.text,en:consent.text.en+" "}});
  expect((await get("/ph1")).status).toBe(404);
  expect((await send()).status).toBe(404);
  config.PH1_CONSENT=JSON.stringify({...consent,text:{...consent.text,he:consent.text.he.slice(0,-1)}});
  expect((await get("/ph1")).status).toBe(404);
  config.PH1_CONSENT=JSON.stringify(consent);
  config.PH1_EVENT_CODE_SHA256=undefined;
  expect((await get("/ph1")).status).toBe(404);
  config.PH1_EVENT_CODE_SHA256=await hash(eventCode);
  config.PH1_CAPTURE_ENABLED=undefined;
  expect((await get("/ph1")).status).toBe(404);
  expect((await send()).status).toBe(404);
  expect((await list())).toHaveLength(0);
});

it("sanitizes JPEG, PNG and HEIC before R2 and exports only to the scoped operator",async () => {
  for (const [i,ext] of (["jpg","png","heic"] as const).entries()) {
    const original = photoFixture(ext);
    const safe = sanitizePhoto(original);
    expect(safe.bytes).not.toEqual(original);
    expect(safe.meta.make).toBe("FixtureCamera");
    expect(safe.meta.model).toBe("Fixture Phone 1");
    expect([...safe.meta.removed]).toContain("Exif.GPSLatitude");
    expect([...safe.meta.removed]).toContain("Exif.GPSLongitude");
    expect(new TextDecoder().decode(safe.bytes)).not.toContain("Fixtureville");
    expect(sanitizePhoto(safe.bytes).bytes).toEqual(safe.bytes);
    if (i===1) vi.setSystemTime(new Date("2026-11-30T23:59:59+02:00"));
    const res = await send(original,{"x-ph1-filename":encodeURIComponent("צילום 0"+i+"."+ext),
      ...(i===1 ? {"x-ph1-consent-language":"en","x-ph1-transfer":"recompressed","x-ph1-participant":"P20"} : {}),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({receipt:"00"+(i+1),uploaded:1,duplicate:false});
    const download = await get("/api/ph1/operator/photos/00"+(i+1),operatorToken);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("x-content-sha256")).toBe(await hash(safe.bytes));
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(safe.bytes);
    expect(await (await bucket.get(prefix+"00"+(i+1)))?.arrayBuffer()).toEqual(safe.bytes.buffer);
  }
  const manifestPath = "/api/ph1/operator/export";
  expect((await get(manifestPath)).status).toBe(404);
  expect((await get(manifestPath,eventCode)).status).toBe(404);
  expect((await get(manifestPath+"?extra=1",operatorToken)).status).toBe(404);
  expect((await get("/api/ph1/operator/photos/001")).status).toBe(404);
  expect((await get("/api/config",operatorToken)).status).toBe(404);
  config.PH1_CAPTURE_ENABLED=undefined;
  vi.setSystemTime(new Date("2026-12-01T00:00:00+02:00"));
  expect(await (await get(manifestPath,operatorToken)).json()).toMatchObject({
    count:3, cap:420, event:"ph1-phone-2026-11-26-to-2026-11-29",
    window:{opens_at:"2026-11-26T00:00:00+02:00",closes_at:"2026-12-01T00:00:00+02:00"},
    consent_policy:{version:consent.version,sha256:{he:await hash(consent.text.he),en:await hash(consent.text.en)}},
    consents:[
      {participant:"P03",date:"2026-11-26",version:consent.version,language:"he",sha256:await hash(consent.text.he)},
      {participant:"P20",date:"2026-11-30",version:consent.version,language:"en",sha256:await hash(consent.text.en)},
    ],
    photos:[{participant:"P03", original_filename:"צילום 00.jpg",original_sha256:await hash(photoFixture("jpg")),
      sanitized_sha256:await hash(sanitizePhoto(photoFixture("jpg")).bytes), make:"FixtureCamera",model:"Fixture Phone 1",
      transfer:"unknown",consent_language:"he",consent_sha256:await hash(consent.text.he)},
      {mime:"image/png",transfer:"recompressed",consent_language:"en",consent_sha256:await hash(consent.text.en)},
      {mime:"image/heic",transfer:"unknown"}],
  });
});

it("retries simultaneous submissions of the same file without consuming a second slot",async () => {
  const responses = await Promise.all([send(),send()]);
  expect(responses.map(r=>r.status).sort()).toEqual([200,201]);
  expect(await responses[0]!.json()).toMatchObject({receipt:"001"});
  expect(await responses[1]!.json()).toMatchObject({receipt:"001"});
  expect((await list())).toHaveLength(1);
});

it("enforces the event cap atomically during concurrent uploads",async () => {
  const slots = Array.from({length:419},(_,i) => String(i+1).padStart(3,"0"));
  for (let i=0;i<slots.length;i+=20) await Promise.all(slots.slice(i,i+20).map(slot=>bucket.put(prefix+slot,"fixture")));
  const responses = await Promise.all([send(),send(photoFixture("png"))]);
  expect(responses.map(r=>r.status).sort()).toEqual([201,409]);
  const success = responses.find(res=>res.status===201)!;
  expect(await success.json()).toMatchObject({receipt:"420"});
  expect((await list())).toHaveLength(420);
});
