import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { sha } from "../../src/worker/handwriting/core";
import { handle } from "../../src/worker/index";
import { Client, ORIGIN } from "./helpers";

const db = env.HANDWRITING_DB!;
const control = env.HANDWRITING_CONTROL!;
const media = env.HANDWRITING_MEDIA!;
const base = "/api/handwriting-intake";
const screen = { privacy: "clear", rights: "clear", quality: "clear" };
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const polygons = Array.from({ length: 10 }, (_, i) => [[2,10*i], [52,10*i], [52,10*i+8], [2,10*i+8]]);
const original = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABkCAIAAAC5NqGpAAAA5ElEQVR4nO2SAQkAURSD1j+aIc4qF2M8/mABVBY+Ty91AiZgvSK7kHeXOgETsF6RXci7S52ACVivyC7k3aVOwASsV2QX8u5SJ2AC1iuyC3l3qRMwAesV2YW8u9QJmID1iuxC3l3qBEzAekV2Ie8udQImYL0iu5B3lzoBE7BekV3Iu0udgAlYr8gu5N2lTsAErFdkF/LuUidgAtYrsgt5d6kTMAHrFdmFvLvUCZiA9YrsQt5d6gRMwHpFdiHvLnUCJmC9IruQd5c6AROwXpFdyLtLnYAJWK/ILuTdpU7ABKxX5OUL/YJRMrLVVaswAAAAAElFTkSuQmCC";
const retake = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABkCAIAAAC5NqGpAAAA5klEQVR4nO2SQQkAQRDD6t/VuekzEk5GGLZQAUlo+Hp60QmYQPWK7EK9u+gETKB6RXah3l10AiZQvSK7UO8uOgETqF6RXah3F52ACVSvyC7Uu4tOwASqV2QX6t1FJ2AC1SuyC/XuohMwgeoV2YV6d9EJmED1iuxCvbvoBEygekV2od5ddAImUL0iu1DvLjoBE6hekV2odxedgAlUr8gu1LuLTsAEqldkF+rdRSdgAtUrsgv17qITMIHqFdmFenfRCZhA9YrsQr276ARMoHpFdqHeXXQCJlC9IrtQ7y46AROoXpGXL/QDHaf0wforuRIAAAAASUVORK5CYII=";
const crop = "iVBORw0KGgoAAAANSUhEUgAAADIAAAAICAIAAAA0vDstAAAAI0lEQVQ4jWPYeLdnECKGAXfBxlFn9YyG1t3RtLVxoDMdVgQADEhIzm/w2MkAAAAASUVORK5CYII=";
const bytes = (b64: string) => Uint8Array.from(atob(b64), char => char.charCodeAt(0));
const configKey = "configuration.json";

await applyD1Migrations(db, env.TEST_HANDWRITING_MIGRATIONS);
beforeEach(async () => {
  const tables = ["hw_candidate_pages", "hw_candidates", "hw_resolution", "hw_reads", "hw_lines", "hw_geometry", "hw_versions",
    "hw_reader_consent", "hw_consent", "hw_tokens", "hw_pages"];
  await db.batch(tables.map(table => db.prepare("DELETE FROM " + table)));
  for (const bucket of [media, control]) {
    const all = (await bucket.list()).objects;
    if (all.length) await bucket.delete(all.map(o => o.key));
  }
});

function request(path: string, options: { who?: { cookie: string }; data?: unknown; headers?: Record<string, string>; host?: string;
  enabled?: string; production?: boolean; mediaBinding?: R2Bucket } = {}) {
  const origin = options.host ?? ORIGIN;
  const body = options.data instanceof Uint8Array ? options.data : options.data === undefined ? undefined : JSON.stringify(options.data);
  return handle(new Request(origin + path, {
    method: body ? "POST" : "GET", body, headers: { origin, cookie: options.who?.cookie ?? "", "content-type": "application/json", ...options.headers },
  }), { ...env, ENVIRONMENT: options.production ? "production" : "development", HANDWRITING_INTAKE_ENABLED: options.enabled ?? "1",
    HANDWRITING_KEY: "fixture-key-pseudonyms-intake-aaaaaaaa", HANDWRITING_MEDIA: options.mediaBinding ?? media }, exec);
}

async function json<T>(response: Promise<Response>, status = 200) {
  const res = await response;
  const data = await res.json();
  expect(res.status, JSON.stringify(data)).toBe(status);
  expect(res.headers.get("cache-control")).toContain("no-store");
  return data as T;
}

async function user(name: string) {
  const c = new Client();
  return { id: await c.signIn("handwriting-fixture-" + name), cookie: c.cookie };
}

async function fixture() {
  const [operator, intake, writer, first, second, third, evaluator, outsider] = await Promise.all(
    ["operator", "intake", "writer", "first", "second", "third", "eval", "outsider"].map(user));
  const prompt = ["invented sample 1", "invented sample 2", ...Array<string>(8).fill("café xyz")].join("\n");
  const wording = async (version: string, text: string) => ({ version, text, sha256: await sha(text) });
  const config = {
    campaign: "fixture",
    access: { operator: [operator!.id], intake: [intake!.id], reader: [writer!.id, first!.id, second!.id], adjudicator: [third!.id], eval: [evaluator!.id] },
    writerConsent: { en: await wording("fake-writer", "Fixture writer consent"), he: await wording("fake-writer", "נוסח בדיקה") },
    readerConsent: { en: await wording("fake-reader", "Fixture reader consent"), he: await wording("fake-reader", "קריאת בדיקה") },
    retentionNotice: { en: "Fixture retention", he: "שמירה לבדיקה" },
    prompts: { invented: { text: prompt, sha256: await sha(prompt), rights: "fixture only" } },
    slots: { "fixture-slot": { prompt: "invented", capture: "phone", pen: "ballpoint", paper: "plain" } },
  };
  await control.put(configKey, JSON.stringify(config));
  const route = (path: string, who?: { cookie: string }, data?: unknown) => request(base + path, { who, data });
  const issue = () => route("/operator/invitations", operator, { slot: "fixture-slot", writerKey: "writer-01",
    sourceKey: "source-01", writerReviewerId: writer!.id });
  const upload = (token: string, image = original, patch?: Record<string, string>, binding?: R2Bucket) => request(base + "/upload", {
    data: bytes(image), mediaBinding: binding, headers: {
      authorization: "Bearer " + token, "content-type": "image/png", "x-intake-agree": "yes", "x-intake-language": "he",
      "x-intake-wording-version": config.writerConsent.he.version, "x-intake-wording-sha256": config.writerConsent.he.sha256,
      "x-intake-prompt-sha256": config.prompts.invented.sha256, ...patch,
    },
  });
  const pin = async (page: string) => {
    const row = await db.prepare("SELECT current_version FROM hw_pages WHERE id=?").bind(page).first<string>("current_version");
    expect(row).toMatch(/^[0-9a-f]{32}$/);
    return "/pages/" + page + "/versions/" + row;
  };
  const review = async (who: { cookie: string }) => {
    await json(route("/review/consent", who, { agree: true, language: "en", version: config.readerConsent.en.version,
      sha256: config.readerConsent.en.sha256 }));
  };
  const prepare = async (pair: string, image = original, replaces: string | null = null) => {
    const originalSha = await sha(bytes(image));
    const form = { originalSha, replaces, polygons, preparedPage: image, crops: Array(10).fill(crop) };
    const g = await json<{ geometryId: string }>(route("/intake" + pair + "/geometry", intake, form), 201);
    const split = { geometryId: g.geometryId, imageSha: originalSha, status: "clear" };
    return { form, split };
  };
  const start = async () => {
    const invite = await json<{ pageId: string; token: string }>(issue(), 201);
    const receipt = await json<{ receiptCode: string }>(upload(invite.token), 201);
    const pair = await pin(invite.pageId);
    return { ...invite, ...receipt, pair };
  };
  return { operator: operator!, intake: intake!, writer: writer!, first: first!, second: second!, third: third!, evaluator: evaluator!,
    outsider: outsider!, config, route, issue, upload, review, pin, prepare, start };
}

it("serves neither shell nor APIs with deployment defaults, unapproved config, or alternate host", async () => {
  const paths = ["/handwriting-intake", base + "/invitation"];
  for (const path of paths) expect((await request(path)).status).toBe(404);
  const f = await fixture();
  for (const path of paths) {
    expect((await request(path, { enabled: "0" })).status).toBe(404);
    expect((await request(path, { production: true, host: "https://review.heocr.org" })).status).toBe(404);
    expect((await request(path, { production: true, host: "https://heocr-review.heocr.workers.dev" })).status).toBe(404);
  }
  const shell = await request("/handwriting-intake");
  expect(shell.status).toBe(200);
  expect(shell.headers.get("content-security-policy")).toContain("form-action 'none'");
  expect(await shell.text()).not.toContain(f.config.prompts.invented.text);
  expect((await request("/handwriting-intake/review", { who: f.outsider })).status).toBe(404);
  expect((await f.route("/eval/lineage", f.outsider)).status).toBe(404);
  expect((await f.route("/operator/invitations", f.outsider, {})).status).toBe(404);
});

it("records exact consent before private originals and permits only idempotent retries and explicit retakes", async () => {
  const f = await fixture();
  const invite = await json<{ pageId: string; token: string }>(f.issue(), 201);
  expect((await f.issue()).status).toBe(409);
  expect((await f.route("/invitation")).status).toBe(404);
  const info = await json<{ consent: { text: string }; prompt: string }>(request(base + "/invitation?lang=en", {
    headers: { authorization: "Bearer " + invite.token },
  }));
  expect(info.consent.text).toBe(f.config.writerConsent.en.text);
  expect(info.prompt).toBe(f.config.prompts.invented.text);
  expect((await f.upload(invite.token, original, { "x-intake-wording-sha256": "stale" })).status).toBe(409);
  expect((await f.upload(invite.token, original, { origin: "https://example.test" })).status).toBe(403);
  expect((await media.list()).objects).toHaveLength(0);
  let seenConsent = false;
  const observedMedia = {
    put: async (key: string, data: Uint8Array) => {
      seenConsent = (await db.prepare("SELECT wording_sha FROM hw_consent WHERE page=?").bind(invite.pageId).first("wording_sha")) === f.config.writerConsent.he.sha256;
      return media.put(key, data);
    },
  } as unknown as R2Bucket;
  const first = await json<{ receiptCode: string }>(f.upload(invite.token, original, undefined, observedMedia), 201);
  expect(seenConsent).toBe(true);
  expect(first.receiptCode).not.toContain(invite.token);
  expect((await json<{ receiptCode: string }>(f.upload(invite.token), 201)).receiptCode).toBe(first.receiptCode);
  expect((await f.upload(invite.token, retake)).status).toBe(409);
  const old = await f.pin(invite.pageId);
  expect((await f.route("/intake" + old + "/original", f.writer)).status).toBe(404);
  expect((await f.route("/intake" + old + "/original", f.intake)).status).toBe(200);
  const next = await json<{ token: string }>(f.route("/operator/pages/" + invite.pageId + "/retake", f.operator, {}), 201);
  expect((await json<{ receiptCode: string }>(f.upload(next.token, retake), 201)).receiptCode).toBe(first.receiptCode);
  expect((await f.upload(invite.token)).status).toBe(409);
  expect((await f.route("/intake" + old + "/original", f.intake)).status).toBe(404);
  const current = await f.pin(invite.pageId);
  expect(current).not.toBe(old);
  expect((await (await f.route("/intake" + current + "/original", f.intake)).arrayBuffer()).byteLength).toBe(bytes(retake).length);
  expect((await media.list()).objects).toHaveLength(1);
  const lineage = await json<{ submissions: { version: string; parent: string | null }[] }>(f.route("/eval/lineage", f.evaluator));
  expect(lineage.submissions).toContainEqual(expect.objectContaining({ version: current.split("/").at(-1), parent: old.split("/").at(-1) }));
});

it("keeps flagged geometry out of the blind queue until a new geometry clears eval", async () => {
  const f = await fixture();
  const p = await f.start();
  await f.review(f.first);
  await json(f.route("/intake" + p.pair + "/screen", f.intake, { quarantine: true }), 200);
  expect((await f.route("/intake" + p.pair + "/geometry", f.intake, {})).status).toBe(404);
  await json(f.route("/intake" + p.pair + "/screen", f.intake, screen));
  const bad = { originalSha: await sha(bytes(original)), polygons: [...polygons.slice(0,9), [[0,0],[80,1],[2,3]]],
    preparedPage: original, crops: Array(10).fill(crop) };
  expect((await f.route("/intake" + p.pair + "/geometry", f.intake, bad)).status).toBe(400);
  const g = await f.prepare(p.pair);
  expect((await json<{ task: unknown }>(f.route("/review/next", f.first))).task).toBeNull();
  expect((await f.route("/eval" + p.pair + "/split", f.first, g.split)).status).toBe(404);
  const wrong = { ...g.split, imageSha: "0".repeat(64) };
  expect((await f.route("/eval" + p.pair + "/split", f.evaluator, wrong)).status).toBe(409);
  await json(f.route("/eval" + p.pair + "/split", f.evaluator, g.split));
  const first = (await json<{ task: { id: string; image: string } }>(f.route("/review/next", f.first))).task;
  await json(f.route("/review/" + first.id, f.first, { text: "", issue: "geometry" }), 201);
  expect((await request(first.image, { who: f.first })).status).toBe(404);
  await json(f.route("/intake" + p.pair + "/screen", f.intake, screen));
  expect((await f.route("/eval" + p.pair + "/split", f.evaluator, g.split)).status).toBe(409);
  const replacement = await f.prepare(p.pair, original, g.split.geometryId);
  await json(f.route("/eval" + p.pair + "/split", f.evaluator, replacement.split));
  const newTask = (await json<{ task: { id: string; own: unknown } }>(f.route("/review/next", f.first))).task;
  expect(newTask.id).not.toBe(first.id);
  expect(newTask.own).toBeNull();
  expect((await request(first.image, { who: f.first })).status).toBe(404);
});

it("isolates blind reads and adjudication, exports only cleared crops, and makes withdrawal survive restore", async () => {
  const f = await fixture();
  const p = await f.start();
  await json(f.route("/intake" + p.pair + "/screen", f.intake, screen));
  const g = await f.prepare(p.pair);
  await json(f.route("/eval" + p.pair + "/split", f.evaluator, g.split));
  const access = (who: { cookie: string }) => f.route("/review/next", who);
  expect((await access(f.first)).status).toBe(404);
  for (const who of [f.writer, f.first, f.second, f.third]) await f.review(who);
  expect(await json(access(f.writer))).toEqual({ task: null });
  expect(await json(access(f.third))).toEqual({ task: null });
  type Task = { id: string; image: string; input: string; own: unknown };
  const next = async (who: { cookie: string }) => (await json<{ task: Task }>(access(who))).task;
  const line = await next(f.first);
  const image = await request(line.image, { who: f.first });
  expect(image.status).toBe(200);
  expect(image.headers.get("cache-control")).toContain("no-store");
  expect((await request(line.image)).status).toBe(404);
  expect((await request(line.image, { who: f.writer })).status).toBe(404);
  const read = (id: string, who: { cookie: string }, text: string) => f.route("/review/" + id, who, { text, issue: "none" });
  const adjudicate = "/review/" + line.id + "/adjudicate";
  await json(read(line.id, f.first, "ניסוי 1"), 201);
  expect((await read(line.id, f.first, "ניסוי 2")).status).toBe(404);
  expect(await next(f.second)).toEqual({ ...line, input: "", own: null });
  await json(read(line.id, f.second, "ניסוי 2"), 201);
  expect((await f.route(adjudicate, f.third)).status).toBe(404);
  expect(await next(f.third)).toEqual({ ...line, input: "", own: null });
  await json(read(line.id, f.third, "ניסוי 3"), 201);
  expect(await next(f.third)).toEqual({ ...line, own: { raw: "ניסוי 3", issue: "none" } });
  expect((await f.route(adjudicate, f.first)).status).toBe(404);
  expect(await json(f.route(adjudicate, f.third))).toEqual({ reads: [
    { text: "ניסוי 1", issue: "none" }, { text: "ניסוי 2", issue: "none" }, { text: "ניסוי 3", issue: "none" },
  ] });
  await json(f.route(adjudicate, f.third, { reference: "ניסוי 2" }), 201);
  expect(await json(f.route(adjudicate, f.third))).toMatchObject({ prompt: f.config.prompts.invented.text,
    resolution: { reference: "ניסוי 2" } });
  // Two matching readings can still show a literal departure from the prompt.
  const omission = await next(f.first);
  const reviewOmission = "/review/" + omission.id + "/adjudicate";
  await json(read(omission.id, f.first, "invented sample"), 201);
  await json(read(omission.id, f.second, "invented sample"), 201);
  expect(await next(f.third)).toEqual({ ...omission, input: "", own: null });
  await json(read(omission.id, f.third, "invented sample"), 201);
  expect(await json(f.route(reviewOmission, f.third))).not.toHaveProperty("prompt");
  await json(f.route(reviewOmission, f.third, { reference: "invented sample" }), 201);
  for (let i = 0; i < 8; i++) {
    const task = await next(f.first);
    await json(read(task.id, f.first, " cafe\u0301  xyz "), 201);
    expect(await next(f.second)).toMatchObject({ id: task.id, input: "", own: null });
    await json(read(task.id, f.second, "café xyz"), 201);
  }
  expect(await json(access(f.third))).toEqual({ task: null });
  expect((await f.route("/operator/candidates", f.operator, {})).status).toBe(409);
  await json(f.route("/operator/close", f.operator, {}));
  const candidate = await json<{ sha256: string; manifest: object }>(f.route("/operator/candidates", f.operator, {}));
  const manifest = JSON.stringify(candidate.manifest);
  expect(candidate.sha256).toBe(await sha(manifest));
  expect(manifest).toContain("café xyz");
  for (const value of [p.pageId, g.split.geometryId, f.first.id, f.config.prompts.invented.text, "ניסוי 1", f.config.writerConsent.he.text]) {
    expect(manifest).not.toContain(value);
  }
  const inspect = "/operator/candidates/" + candidate.sha256;
  expect((await f.route(inspect, f.evaluator)).status).toBe(404);
  expect((await f.route(inspect + "/asset/1/1", f.operator)).status).toBe(200);
  expect((await f.route(inspect + "/asset/1/1")).status).toBe(404);
  const prior = (await media.list()).objects.map(o => o.key);
  expect(prior).toHaveLength(12);
  const cropKey = prior.find(key => key.endsWith("/" + line.id))!;
  await media.put(cropKey, bytes(retake));
  expect((await f.route(inspect + "/asset/1/1", f.operator)).status).toBe(404);
  await media.put(cropKey, bytes(crop));
  expect(await json(f.route("/operator/withdraw", f.operator, { receiptCode: p.receiptCode }))).toEqual({ withdrawn: true, activeMediaRemaining: 0 });
  expect((await media.list()).objects).toHaveLength(0);
  expect((await f.route(inspect, f.operator)).status).toBe(404);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM hw_reads").first("n"))).toBe(0);
  // Simulate an older snapshot adding the bytes and stale active pointer back. The live tombstone takes precedence.
  const version = p.pair.split("/").at(-1)!;
  await db.prepare("UPDATE hw_pages SET withdrawn=0,current_version=? WHERE id=?").bind(version, p.pageId).run();
  await db.prepare("UPDATE hw_versions SET state='cleared' WHERE id=?").bind(version).run();
  await media.put(prior.find(key => key.includes("/original/"))!, bytes(original));
  expect((await f.route("/intake" + p.pair + "/original", f.intake)).status).toBe(404);
  expect((await request(line.image, { who: f.first })).status).toBe(404);
  expect(await json(f.route("/operator/reconcile", f.operator, {}))).toEqual({ swept: 1, expiredWriterConsent: 0 });
  expect((await media.list()).objects).toHaveLength(0);
});

it("expires unpublished consent after 90 days and keeps the pinned released version", async () => {
  const f = await fixture();
  const p = await f.start();
  await json(f.route("/operator/close", f.operator, {}));
  const version = p.pair.split("/").at(-1)!;
  const now = Date.now();
  const release = "fixture/published/" + p.pageId;
  await control.put(release, JSON.stringify({ version, manifest: "c".repeat(64) }));
  await control.put("fixture/closed.json", JSON.stringify({ at: now - 91*24*60*60*1000 }));
  expect((await f.route("/operator/withdraw", f.operator, { receiptCode: p.receiptCode })).status).toBe(409);
  expect(await json(f.route("/operator/reconcile", f.operator, {}))).toEqual({ swept: 0, expiredWriterConsent: 0 });
  expect(await db.prepare("SELECT COUNT(*) AS n FROM hw_consent").first("n")).toBe(1);
  const record = await db.prepare("SELECT * FROM hw_consent").first<{
    version: string; page: string; language: string; wording_version: string; wording_sha: string; agreed_at: number;
  }>();
  await control.delete(release);
  expect(await json(f.route("/operator/reconcile", f.operator, {}))).toEqual({ swept: 0, expiredWriterConsent: 1 });
  expect(await db.prepare("SELECT COUNT(*) AS n FROM hw_consent").first("n")).toBe(0);
  // Restore consent from before the cutoff, leaving the live close date in control storage.
  await db.prepare("INSERT INTO hw_consent VALUES(?,?,?,?,?,?)")
    .bind(record!.version, record!.page, record!.language, record!.wording_version, record!.wording_sha, record!.agreed_at).run();
  expect(await json(f.route("/operator/consent", f.operator))).toMatchObject({ agreements: [] });
  expect(await db.prepare("SELECT COUNT(*) AS n FROM hw_consent").first("n")).toBe(0);
});

it.each([false, true])("honours a withdrawal before any release with a blind read present: %s", async duringReview => {
  const f = await fixture();
  const p = await f.start();
  let image: string | undefined;
  if (duringReview) {
    await json(f.route("/intake" + p.pair + "/screen", f.intake, screen));
    const g = await f.prepare(p.pair);
    await json(f.route("/eval" + p.pair + "/split", f.evaluator, g.split));
    await f.review(f.first);
    const { task } = await json<{ task: { id: string; image: string } }>(f.route("/review/next", f.first));
    image = task.image;
    await json(f.route("/review/" + task.id, f.first, { issue: "none", text: "fixture read" }), 201);
  }
  expect((await f.route("/operator/withdraw", f.outsider, { receiptCode: p.receiptCode })).status).toBe(404);
  const remove = () => f.route("/operator/withdraw", f.operator, { receiptCode: p.receiptCode });
  expect(await json(remove())).toEqual({ withdrawn: true, activeMediaRemaining: 0 });
  expect(await json(remove())).toEqual({ withdrawn: true, activeMediaRemaining: 0 });
  expect((await f.upload(p.token)).status).toBe(404);
  expect((await media.list()).objects).toHaveLength(0);
  expect(await json(f.route("/eval/lineage", f.evaluator))).toEqual({ submissions: [] });
  expect(await json(f.route("/operator/consent", f.operator))).toMatchObject({ agreements: [] });
  expect((await f.route("/intake" + p.pair + "/original", f.intake)).status).toBe(404);
  if (image) expect((await request(image, { who: f.first })).status).toBe(404);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM hw_reads").first("n")).toBe(0);
});
