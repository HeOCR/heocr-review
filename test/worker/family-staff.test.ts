import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { CONTRIBUTOR_API, type ContributorProfile, type HandwritingOffer } from "../../src/shared/contributor";
import { contributorRoot, hash } from "../../src/worker/contributor/config";
import { FAMILY_STAFF_ORDER_PREFIX, familyStaffSplit } from "../../src/worker/contributor/family-staff";
import { kidsSheetOrder } from "../../src/worker/contributor/handwriting";
import type { Env } from "../../src/worker/env";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

const execution = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const origin = "http://localhost";
const enrolments = CONTRIBUTOR_API + "/enrolments";
const options = enrolments + "/options";
const familyCode = "f".repeat(32), v3Code = "1".repeat(32);
const calibration = "שורת כיול לדוגמה 37";
const photo = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/R8kAAAAASUVORK5CYII="), c => c.charCodeAt(0));
const letter = { train: "T", dev: "D" } as const;

async function fixture(opts: { maxUses?: number; breakPack?: "repeat" | "no-calibration" } = {}) {
  const clients = await Promise.all(["a", "b", "c", "d", "admin"].map(async name => {
    const c = new Client();
    return { c, id: await c.signIn("family-" + name) };
  }));
  const copy = async (purpose: string) => {
    const he = "נוסח בדיקה " + purpose, en = "Invented test terms " + purpose;
    return { he: { text: he, sha256: await hash(he) }, en: { text: en, sha256: await hash(en) } };
  };
  const policy = { version: "fixture", licence: "cc0_open", guardian: await copy("guardian"), assent: await copy("assent") };
  const approval = { evalSplitSha256: "1".repeat(64), leadGo: "fixture", allocationAmendmentSha256: "3".repeat(64) };
  const sheet = async (page: string, sentences: string[], bucket: R2Bucket) => {
    const pdf = "%PDF-1.4\n% invented fixture " + page;
    const sheetSha256 = await hash(pdf);
    await bucket.put(contributorRoot + "sheets/" + sheetSha256 + ".pdf", pdf);
    return { kind: "handwriting", id: page, page, sentences, rights: "CC0-1.0: invented fixture", sheetSha256,
      promptSha256: await hash(sentences.join("\n")) };
  };
  const packs = Object.fromEntries(await Promise.all((["train", "dev"] as const).map(async split => [split,
    await Promise.all(Array.from({ length: 9 }, async (_, i) => {
      const page = `HW-FS-${letter[split]}0${i + 1}`;
      const sentences = Array.from({ length: 10 }, (_, j) => `שורה ארוכה לבדיקה ${page} ${j + 1}`);
      if (i === 0 && !(opts.breakPack === "no-calibration" && split === "dev")) sentences[9] = calibration;
      if (opts.breakPack === "repeat" && split === "dev" && i === 1) sentences[0] = "שורה ארוכה לבדיקה HW-FS-T02 1";
      return sheet(page, sentences, split === "train" ? env.TRAIN_CAPTURE_MEDIA! : env.HANDWRITING_MEDIA!);
    }))])));
  const familyPlan = JSON.stringify({ schema: "heocr.handwriting_family_staff.v1", approval, policy, calibration, packs,
    invite: { sha256: await hash(familyCode), maxUses: opts.maxUses ?? 10, expiresAt: "2099-01-01T00:00:00Z" } });
  const familyPin = await hash(familyPlan);
  await env.HANDWRITING_MEDIA!.put(contributorRoot + "handwriting-family-staff/" + familyPin + ".json", familyPlan);

  const v3Sheets = Object.fromEntries(await Promise.all((["A", "C"] as const).map(async set => [set,
    await Promise.all(Array.from({ length: 4 }, (_, i) => {
      const page = `HW-V3-${set}0${i + 1}`;
      const sentences = Array.from({ length: 30 }, (_, j) => j === 29 ? calibration : `שורת בדיקה ${page} ${j + 1}`);
      return sheet(page, sentences, set === "A" ? env.TRAIN_CAPTURE_MEDIA! : env.HANDWRITING_MEDIA!);
    }))])));
  const v3Plan = JSON.stringify({ schema: "heocr.handwriting_signup.v1", approval, policy, sheets: v3Sheets, writerLimit: 2,
    invites: [await hash(v3Code)], lineRoles: { "30": "calibration" },
    capacity: [{ split: "train", max: 1 }, { split: "dev", max: 1 }], setsBySplit: { train: ["A"], dev: ["C"] } });
  const v3Pin = await hash(v3Plan);
  await env.TRAIN_CAPTURE_MEDIA!.put(contributorRoot + "handwriting-signup/" + v3Pin + ".json", v3Plan);

  const [a, b, c, d, admin] = clients as [typeof clients[0], typeof clients[0], typeof clients[0], typeof clients[0], typeof clients[0]];
  const req = (who: { c: Client }, route: string, body?: object | Uint8Array<ArrayBuffer>, headers?: HeadersInit, overrides: Partial<Env> = {}) =>
    handle(new Request(origin + route, {
      method: body ? "POST" : "GET",
      headers: { cookie: who.c.cookie, origin, "content-type": "application/json", ...headers },
      body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
    }), { ...env, CONTRIBUTOR_APP_ENABLED: "1", CONTRIBUTOR_HANDWRITING_CONFIG_SHA256: v3Pin,
      CONTRIBUTOR_FAMILY_STAFF_CONFIG_SHA256: familyPin, CONTRIBUTOR_DEV_MEDIA: env.HANDWRITING_MEDIA,
      CONTRIBUTOR_EVAL_MEDIA: env.HANDWRITING_CONTROL, ADMIN_REVIEWER_IDS: admin.id,
      CONTRIBUTOR_PAYMENT_CODE_SECRET: "fixture-payment-secret", ...overrides }, execution);
  const offer = (who: { c: Client }, ageBand = "18_plus", code = familyCode) => req(who, options, { inviteCode: code, ageBand });
  const join = async (who: { c: Client }) => {
    const o = await (await offer(who)).json<HandwritingOffer>();
    return req(who, enrolments, { inviteCode: familyCode, ageBand: "18_plus", split: o.split, set: "FS" });
  };
  return { a, b, c, d, admin, req, offer, join, policy, packs, familyPin };
}

it("splits by signup slot: DEV, TRAIN, DEV, then the seeded 70/30 rule", async () => {
  expect(await Promise.all([1, 2, 3].map(familyStaffSplit))).toEqual(["dev", "train", "dev"]);
  for (let n = 4; n <= 50; n++) {
    const u = parseInt((await hash("20261128:hw3-family-staff:" + n)).slice(0, 13), 16) / 16 ** 13;
    expect(await familyStaffSplit(n)).toBe(u < 0.7 ? "train" : "dev");
  }
});

it("enrols adults in slot order, serves the split's pack in the writer's seeded order, and shows no payment code", async () => {
  const f = await fixture();
  expect((await f.offer(f.a, "13_17")).status).toBe(409);
  expect(await (await f.offer(f.a)).json()).toEqual({ split: "dev", sets: ["FS"] });
  expect((await f.req(f.a, enrolments, { inviteCode: familyCode, ageBand: "18_plus", split: "train", set: "FS" })).status).toBe(409);
  const joined = await f.join(f.a);
  expect(joined.status).toBe(200);
  let profile = await joined.json<ContributorProfile>();
  expect(profile.state).toBe("assent");
  expect(profile.paymentCode).toBeUndefined();
  const consent = await f.req(f.a, `${CONTRIBUTOR_API}/writers/${profile.writer}/consent`,
    { version: f.policy.version, accept: true, lang: "en", sha256: f.policy.assent.en.sha256 });
  expect(consent.status).toBe(200);
  profile = await consent.json<ContributorProfile>();
  expect(profile.paymentCode).toBeUndefined();
  const expected = await kidsSheetOrder(profile.writer, f.packs.dev as { page: string }[], FAMILY_STAFF_ORDER_PREFIX);
  const next = profile.queues[0]!.next!;
  expect(profile.queues[0]!.total).toBe(9);
  expect(next.page).toBe(expected[0]!.page);
  const task = `${CONTRIBUTOR_API}/writers/${profile.writer}/tasks/${next.id}`;
  expect((await f.req(f.a, task + "/sheet")).status).toBe(200);
  const saved = await f.req(f.a, task + "/submit", photo, { "content-type": "image/png", "x-contributor-privacy": "confirmed",
    "x-contributor-reference": next.kind === "handwriting" ? next.referenceSha256 : "" });
  expect(saved.status).toBe(200);
  expect((await saved.json<ContributorProfile>()).queues[0]!.done).toBe(1);
  expect((await env.HANDWRITING_MEDIA!.list({ prefix: contributorRoot + "quarantine/" + profile.writer + "/" })).objects).toHaveLength(1);
  // Never a release candidate, and never counted in the v3 roster.
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM contributor_handwriting_release_candidates").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM contributor_handwriting_roster").first("n")).toBe(0);
  expect((await (await f.join(f.b)).json<ContributorProfile>()).writer).not.toBe(profile.writer);
  expect((await env.DB.prepare("SELECT slot,split FROM contributor_family_staff_roster ORDER BY slot").all()).results)
    .toEqual([{ slot: 1, split: "dev" }, { slot: 2, split: "train" }]);
});

it("withdraws a family writer without freeing the slot, and keeps the v3 cohort working beside it", async () => {
  const f = await fixture();
  const p = await (await f.join(f.a)).json<ContributorProfile>();
  const left = await f.req(f.a, `${CONTRIBUTOR_API}/writers/${p.writer}/withdraw`, { withdraw: true });
  expect(left.status).toBe(200);
  expect((await f.offer(f.a)).status).toBe(409);
  expect(await (await f.offer(f.b)).json()).toEqual({ split: "train", sets: ["FS"] });
  const v3 = await (await f.offer(f.c, "18_plus", v3Code)).json<HandwritingOffer>();
  expect(v3).toEqual({ split: "train", sets: ["A"] });
  const joined = await f.req(f.c, enrolments, { inviteCode: v3Code, ageBand: "18_plus", ...{ split: v3.split, set: "A" } });
  expect(joined.status).toBe(200);
  expect((await joined.json<ContributorProfile>()).paymentCode).toMatch(/^[A-Z0-9]{6}$/);
  // One enrolment per account across cohorts.
  expect((await f.offer(f.c)).status).toBe(409);
});

it("enforces the code's use cap and admin revocation, and leaves the cohort off without its pin", async () => {
  const f = await fixture({ maxUses: 1 });
  expect((await f.join(f.a)).status).toBe(200);
  expect((await f.offer(f.b)).status).toBe(409);
  const off = await f.req(f.b, options, { inviteCode: familyCode, ageBand: "18_plus" }, {}, { CONTRIBUTOR_FAMILY_STAFF_CONFIG_SHA256: undefined });
  expect(off.status).toBe(404);
  const revoke = CONTRIBUTOR_API + "/operator/handwriting-invites/revoke";
  expect((await f.req(f.b, revoke, { sha256: await hash(familyCode) })).status).toBe(404);
  expect((await f.req(f.admin, revoke, { sha256: await hash(familyCode) })).status).toBe(200);
  expect(await env.DB.prepare("SELECT config_sha256 FROM contributor_handwriting_revoked_invites").first("config_sha256")).toBe(f.familyPin);
});

it.each(["repeat", "no-calibration"] as const)("refuses a plan whose packs break the line rules: %s", async breakPack => {
  const f = await fixture({ breakPack });
  expect((await f.offer(f.a)).status).toBe(404);
});
