import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { CAPTURE_API, CAPTURE_FORM, captureRoot, TRAIN_CAPTURE_API, TRAIN_CAPTURE_FORM, trainCaptureRoot } from "../../src/shared/registered-captures";
import type { Env } from "../../src/worker/env";
import { hex } from "../../src/worker/crypto";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

const media = env.RESTRICTED_REFERENCE_MEDIA!;
const trainMedia = env.TRAIN_CAPTURE_MEDIA!;
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const raw = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const pageImage = raw("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/R8kAAAAASUVORK5CYII=");
const trainImage = raw("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==");
const raceImage = raw("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgYPgPRmAKABf2A/38FIMyAAAAAElFTkSuQmCC");
const captureLog = { phone: "fixture", camera_mode: "photo", printer: "fixture printer", paper: "plain",
  orientation: "portrait", angle: "square", lighting: "even" };

function box(tag: string, body: string) {
  return String.fromCharCode(0, 0, 0, 8 + body.length) + tag + body;
}
// A fixture of the HEIF container checks, with no photo or decodable pixel payload.
const heif = new TextEncoder().encode(box("ftyp", "heic\0\0\0\0mif1heic") + box("meta", "\0\0\0\0mock") + box("mdat", "fake"));
const sha = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes));

async function fixture(label: string) {
  const owner = new Client();
  const id = await owner.signIn("capture-owner-" + label);
  const other = new Client();
  const otherId = await other.signIn("capture-other-" + label);
  const pages = [
    { page_id: "FIXTURE-01", issuer_pdf_sha256: "a".repeat(64), issuer_page_index: 1, issue_key: "issue-a",
      slots: [{ slot: "A", condition: "square" }, { slot: "B", condition: "angle" }] },
    { page_id: "FIXTURE-02", issuer_pdf_sha256: "a".repeat(64), issuer_page_index: 2, issue_key: "issue-a",
      slots: [{ slot: "A", condition: "square" }, { slot: "B", condition: "angle" }, { slot: "C", condition: "shadow" }] },
  ];
  const bytes = new TextEncoder().encode(JSON.stringify({
    schema: "registered_phone_captures.v1", registration: "fixture-" + label, pack_sha256: "2".repeat(64),
    batch_id: "private-ref-capture-fixture", pages,
  }));
  const pin = await sha(bytes);
  const root = captureRoot(pin);
  await media.put(root + "/roster.json", bytes);
  const trainPages = Array.from({ length: 40 }, (_, i) => ({
    page_id: "TRAIN-FIXTURE-" + String(i + 1).padStart(2, "0"),
    slots: ["FLAT", "OBLIQUE", "DIM", ...(i < 5 ? ["M-FOLD"] : [])].map(slot => ({ slot, condition: "fixture condition" })),
  }));
  const trainBytes = new TextEncoder().encode(JSON.stringify({
    schema: "train_phone_captures.v1", source_manifest_sha256: await sha(new TextEncoder().encode(label)),
    pack_sha256: "2".repeat(64), pages: trainPages,
  }));
  const trainPin = await sha(trainBytes);
  const trainRoot = trainCaptureRoot(trainPin);
  await trainMedia.put(trainRoot + "/roster.json", trainBytes);
  const request = (path: string, opts: { who?: Client | null; origin?: string; headers?: Record<string, string>;
    body?: Uint8Array; enabled?: string; pin?: string; production?: boolean; config?: Partial<Env> } = {}) => {
    const origin = opts.origin ?? "http://localhost";
    const who = opts.who === undefined ? owner : opts.who;
    return handle(new Request(origin + path, {
      method: opts.body ? "POST" : "GET", body: opts.body,
      headers: { origin, cookie: who?.cookie ?? "", ...opts.headers },
    }), { ...env, ENVIRONMENT: opts.production ? "production" : "development", RESTRICTED_REFERENCE_REVIEWER_ID: id,
      ADMIN_REVIEWER_IDS: id + "," + otherId, REGISTERED_CAPTURE_ENABLED: opts.enabled ?? "1",
      REGISTERED_CAPTURE_ROSTER_SHA256: opts.pin ?? pin, TRAIN_CAPTURE_ENABLED: "1", TRAIN_CAPTURE_ROSTER_SHA256: trainPin,
      ...opts.config }, exec);
  };
  const upload = (name: string, body: Uint8Array = pageImage, extra?: Record<string, string>) => request(CAPTURE_API + "/upload", {
    body, headers: { "x-capture-filename": name, "x-capture-roster": pin,
      "x-capture-log": encodeURIComponent(JSON.stringify(captureLog)), ...extra },
  });
  const trainUpload = (name: string, body: Uint8Array = trainImage, extra?: Record<string, string>) =>
    request(TRAIN_CAPTURE_API + "/upload", {
      body, headers: { "x-capture-filename": name, "x-capture-roster": trainPin,
        "x-capture-log": encodeURIComponent(JSON.stringify(captureLog)), ...extra },
    });
  return { request, upload, trainUpload, other, root, pin, trainRoot, trainPin, trainBytes, id };
}

it("keeps capture shell, roster, uploads and raw objects behind explicit private access", async () => {
  const f = await fixture("access");
  for (const path of [CAPTURE_FORM, CAPTURE_API]) {
    expect((await f.request(path, { enabled: "" })).status).toBe(404);
    expect((await f.request(path, { pin: "0".repeat(64) })).status).toBe(404);
    expect((await f.request(path, { who: null })).status).toBe(404);
    expect((await f.request(path, { who: f.other })).status).toBe(404);
    expect((await f.request(path, { origin: "https://heocr-review.heocr.workers.dev", production: true })).status).toBe(404);
  }
  const html = await f.request(CAPTURE_FORM);
  expect(html.status).toBe(200);
  expect(html.headers.get("cache-control")).toContain("no-store");
  expect(html.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(await html.text()).not.toContain("FIXTURE-01");
  const result = await f.request(CAPTURE_API);
  expect(await result.json()).toMatchObject({ roster_sha256: f.pin, pages: [{ page_id: "FIXTURE-01" }, { page_id: "FIXTURE-02" }] });
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect((await f.upload("FIXTURE-01-A.jpg", pageImage, { origin: "https://example.invalid" })).status).toBe(403);
  await env.DB.prepare("UPDATE reviewers SET blocked=1 WHERE id=?").bind(f.id).run();
  expect((await f.request(CAPTURE_API)).status).toBe(404);
});

it("binds originals to exact filename slots with private bytes, capture logs, retries and explicit retakes", async () => {
  const f = await fixture("intake");
  for (const name of ["FIXTURE-01-C.png", "FIXTURE-03-A.png", "FIXTURE-01-a.png", "../FIXTURE-01-A.png", "FIXTURE-01-A.png.jpg"]) {
    expect((await f.upload(name)).status).toBe(400);
  }
  expect((await f.upload("FIXTURE-01-A.jpg")).status).toBe(415);
  expect((await f.upload("FIXTURE-01-A.png", pageImage, { "x-capture-roster": "0".repeat(64) })).status).toBe(409);
  expect((await f.upload("FIXTURE-01-A.png", pageImage, { "x-capture-log": encodeURIComponent("{}") })).status).toBe(400);
  expect((await media.list({ prefix: f.root + "/originals/" })).objects).toHaveLength(0);

  const first = await f.upload("FIXTURE-01-A.PNG");
  expect(first.status).toBe(201);
  const firstSha = await sha(pageImage);
  expect(await first.json()).toMatchObject({ page_id: "FIXTURE-01", slot: "A", sha256: firstSha, revisions: 1 });
  const key = f.root + "/originals/" + firstSha;
  expect((await media.head(key))?.httpMetadata?.cacheControl).toBe("private, no-store");
  expect(new Uint8Array(await (await media.get(key))!.arrayBuffer())).toEqual(pageImage);
  expect((await f.request(CAPTURE_API + "/originals/" + firstSha)).status).toBe(404);
  expect((await f.upload("FIXTURE-01-A.png")).status).toBe(200);
  expect((await f.upload("FIXTURE-01-B.png")).status).toBe(409);
  expect((await f.upload("FIXTURE-01-A.HEIC", heif)).status).toBe(409);
  expect((await f.upload("FIXTURE-01-A.HEIC", heif.slice(0, -3))).status).toBe(415);

  const retake = { "x-capture-replaces": firstSha,
    "x-capture-log": encodeURIComponent(JSON.stringify({ ...captureLog, retake_reason: "soft focus" })) };
  expect((await f.upload("FIXTURE-01-A.HEIC", heif, { ...retake, "x-capture-replaces": "0".repeat(64) })).status).toBe(409);
  expect((await f.upload("FIXTURE-01-A.HEIC", heif, { "x-capture-replaces": firstSha })).status).toBe(400);
  expect((await f.upload("FIXTURE-01-A.HEIC", heif, retake)).status).toBe(201);
  expect((await f.upload("FIXTURE-01-A.HEIC", heif, retake)).status).toBe(200);
  expect((await f.upload("FIXTURE-01-A.png")).status).toBe(409);
  const record = await media.get(f.root + "/slots/FIXTURE-01/A.json");
  expect(await record!.json()).toMatchObject({ page_id: "FIXTURE-01", slot: "A", revisions: [
    { sha256: firstSha, log: captureLog },
    { sha256: await sha(heif), log: { ...captureLog, retake_reason: "soft focus" } },
  ] });
  const active = await f.request(CAPTURE_API);
  expect(await active.json()).toMatchObject({ pages: [{ slots: [
    { slot: "A", current: { sha256: await sha(heif) } }, { slot: "B", current: null },
  ] }, { page_id: "FIXTURE-02" }] });
});

it("admits one active revision when two uploads race the same registered slot", async () => {
  const f = await fixture("race");
  const both = await Promise.all([f.upload("FIXTURE-02-C.HEIC", heif), f.upload("FIXTURE-02-C.png")]);
  expect(both.map(r => r.status).sort()).toEqual([201, 409]);
  const object = await media.get(f.root + "/slots/FIXTURE-02/C.json");
  const state = await object!.json<{ revisions: unknown[] }>();
  expect(state.revisions).toHaveLength(1);
  const retry = both[0]!.status === 201 ? f.upload("FIXTURE-02-C.HEIC", heif) : f.upload("FIXTURE-02-C.png");
  expect((await retry).status).toBe(200);
});

it("keeps TRAIN disabled independently, fails closed on a shared binding and paginates 125 distinct views", async () => {
  const f = await fixture("train-gates");
  expect((await f.request(TRAIN_CAPTURE_FORM, { config: { TRAIN_CAPTURE_ENABLED: undefined } })).status).toBe(404);
  expect((await f.request(TRAIN_CAPTURE_FORM, { config: { TRAIN_CAPTURE_MEDIA: undefined } })).status).toBe(404);
  expect((await f.request(TRAIN_CAPTURE_API, { who: f.other })).status).toBe(404);
  expect((await f.request(TRAIN_CAPTURE_FORM, { origin: "https://heocr-review.heocr.workers.dev", production: true })).status).toBe(404);
  const form = await f.request(TRAIN_CAPTURE_FORM);
  expect(form.status).toBe(200);
  expect(await form.text()).toContain("Training pack only");
  expect((await f.request(TRAIN_CAPTURE_API + "?cursor=1")).status).toBe(400);
  const counts = [];
  let cursor: number | null = 0;
  do {
    const response = await f.request(TRAIN_CAPTURE_API + "?cursor=" + cursor);
    expect(response.status).toBe(200);
    const roster = await response.json<{ next: number | null; pages: { slots: unknown[] }[] }>();
    counts.push(...roster.pages.map(page => page.slots.length));
    cursor = roster.next;
  } while (cursor !== null);
  expect(counts).toHaveLength(40);
  expect(counts.reduce((a, b) => a + b)).toBe(125);
  await media.put(f.trainRoot + "/roster.json", f.trainBytes);
  expect((await f.request(TRAIN_CAPTURE_API, { config: { TRAIN_CAPTURE_MEDIA: media } })).status).toBe(404);
});

it("validates TRAIN device aliases and exact slots, with private receipts and raw bytes only in the selected scope", async () => {
  const f = await fixture("separation");
  expect((await f.upload("TRAIN-FIXTURE-01-FLAT-A.png")).status).toBe(400);
  expect((await f.trainUpload("FIXTURE-01-A.png")).status).toBe(400);
  expect((await f.trainUpload("TRAIN-FIXTURE-06-M-FOLD-A.png")).status).toBe(400);
  expect((await f.trainUpload("TRAIN-FIXTURE-01-FLAT-C.png")).status).toBe(400);
  expect((await f.trainUpload("TRAIN-FIXTURE-01-FLAT-A.dng")).status).toBe(415);
  expect((await f.trainUpload("TRAIN-FIXTURE-01-FLAT-A.png", pageImage, { "x-capture-roster": f.pin })).status).toBe(409);
  const result = await f.trainUpload("train-fixture-01-m-fold-b.PNG");
  expect(result.status).toBe(201);
  const digest = await sha(trainImage);
  expect(await result.json()).toMatchObject({ page_id: "TRAIN-FIXTURE-01", slot: "M-FOLD", sha256: digest, revisions: 1 });
  const key = f.trainRoot + "/originals/" + digest;
  expect(new Uint8Array(await (await trainMedia.get(key))!.arrayBuffer())).toEqual(trainImage);
  expect(await media.head(key)).toBeNull();
  expect(await media.head(f.root + "/originals/" + digest)).toBeNull();
  expect((await f.upload("FIXTURE-01-A.png", trainImage)).status).toBe(409);
  expect((await f.request(TRAIN_CAPTURE_API + "/originals/" + digest)).status).toBe(404);
  expect((await f.upload("FIXTURE-01-A.heic", heif)).status).toBe(201);
  expect(await trainMedia.head(f.trainRoot + "/originals/" + await sha(heif))).toBeNull();
});

it("reserves exact bytes in a single scope even when opposing uploads race", async () => {
  const f = await fixture("cross-scope-race");
  const captures = await Promise.all([f.upload("FIXTURE-01-A.png", raceImage), f.trainUpload("TRAIN-FIXTURE-01-FLAT-A.png", raceImage)]);
  expect(captures.map(r => r.status).sort()).toEqual([201, 409]);
  const digest = await sha(raceImage);
  const objects = await Promise.all([
    media.head(f.root + "/originals/" + digest),
    trainMedia.head(f.trainRoot + "/originals/" + digest),
  ]);
  expect(objects.filter(Boolean)).toHaveLength(1);
});
