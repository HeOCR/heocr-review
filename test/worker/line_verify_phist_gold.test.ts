import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { NextResponse } from "../../src/shared/api";
import { FRONT_BLOCK, goldDue, goldOrder, scheduleSeed } from "../../src/tasks/line_verify/gold";
import { publicFiles, publicProblems } from "../../src/tasks/public_export";
import { handle } from "../../src/worker/index";
import { ORIGIN } from "./helpers";

// docs/specs/line_verify_phist_gold_v1_1.md on the volunteer fixture (test/fixtures/line_verify_vol) set to
// volunteer_v1_1, with the synthetic gold fixture (test/fixtures/line_verify_gold) added. From line_verify_volunteer.test.ts:
// docs/specs/line_verify_volunteer_resolution_v1.md on the volunteer fixture (test/fixtures/line_verify_vol: the v1.2
// lines, no blind pass) with resolution volunteer_v1. Standing comes from 20 synthetic gold lines in the mid-century
// volunteer batch. Made-up text throughout.
const VOL = "fixture_line_verify_vol";
const GATE = "newprinted_midcentury_volunteers_v0";
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

let adminId = "";
const E = () => ({ ...env, ADMIN_REVIEWER_IDS: adminId });

/** A client whose requests all see the same admin id. */
class R {
  cookie = "";
  id = "";
  async req<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const h: Record<string, string> = { origin: ORIGIN };
    if (this.cookie) h.cookie = this.cookie;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await handle(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), E(), exec);
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    return { status: res.status, body: (await res.json()) as T };
  }
  static async make(name: string, opts: { standing?: boolean } = {}): Promise<R> {
    const r = new R();
    r.id = (await r.req<{ reviewerId: string }>("POST", "/api/auth/dev", { subject: name })).body.reviewerId;
    const cfg = await r.req<{ termsVersion: string }>("GET", "/api/config");
    await r.req("POST", "/api/me/terms", { termsVersion: cfg.body.termsVersion, accept: true, displayName: null });
    if (opts.standing) await grantStanding(r.id);
    return r;
  }
  next() {
    return this.req<NextResponse>("GET", `/api/batches/${VOL}/next`);
  }
  decide(id: number, body: Record<string, unknown>) {
    return this.req<{ value: string }>("POST", `/api/proposals/${id}/decision`, body);
  }
}

/** 20 correct gold decisions in the mid-century volunteer batch: "counting" standing. */
async function grantStanding(reviewerId: string) {
  const gold = (await env.DB.prepare("SELECT id FROM proposals WHERE batch_id = ?1 ORDER BY id").bind(GATE).all<{ id: number }>()).results;
  await env.DB.batch(
    gold.map((g, i) =>
      env.DB.prepare(
        `INSERT INTO decisions (id, proposal_id, reviewer_id, value, text, proposal_sha256, terms_version, created_at, decided_on)
         VALUES (?1, ?2, ?3, 'correct', NULL, 'x', 'x', ?4, '2026-11-18')`,
      ).bind(`gold-${reviewerId}-${i}`, g.id, reviewerId, `2026-11-18T00:00:${String(i).padStart(2, "0")}.000Z`),
    ),
  );
}

const votes = async (proposalId: number) =>
  (await env.DB.prepare("SELECT v.counted, v.step, v.not_counted_reason, v.by_admin FROM verify_votes v JOIN decisions d ON d.id = v.decision_id WHERE v.proposal_id = ?1 ORDER BY d.created_at").bind(proposalId).all()).results;
const state = async (proposalId: number) => env.DB.prepare("SELECT resolution, open_to FROM verify_state WHERE proposal_id = ?1").bind(proposalId).first<{ resolution: string; open_to: string }>();

beforeEach(async () => {
  await env.DB.batch(env.TEST_LINE_VERIFY_VOL_SQL.map((s) => env.DB.prepare(s)));
  await env.DB.batch(env.TEST_LINE_VERIFY_GOLD_SQL.map((s) => env.DB.prepare(s)));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO batch_settings (batch_id, updated_at, updated_by, resolution) VALUES (?1, '2026-11-18T00:00:00.000Z', 'test', 'volunteer_v1_1')").bind(VOL),
    env.DB.prepare("INSERT OR IGNORE INTO batches (id, task_type, title, source_json, min_reviewers, status, imported_at) VALUES (?1, 'line_consensus', 'gate', '{}', 1, 'closed', '2026-11-18T00:00:00.000Z')").bind(GATE),
    env.DB.prepare("INSERT INTO items (batch_id, external_id, title, payload_json) VALUES (?1, 'gold_page', 'g', '{}')").bind(GATE),
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
       INSERT INTO proposals (batch_id, item_id, external_id, category, confidence, rank, payload_json, media_json, content_sha256, active)
       SELECT ?1, (SELECT id FROM items WHERE batch_id = ?1 AND external_id = 'gold_page'), 'gold_' || i, 'c', 'c', i,
         json_object('prefill', 'שורה', 'gold', json_object('gold_id', 'g' || i, 'answer', json_object('action', 'edit', 'text', 'שורה'), 'planted_error', NULL)),
         '{}', 'x', 1 FROM n`,
    ).bind(GATE),
  ]);
  const admin = new R();
  adminId = (await admin.req<{ reviewerId: string }>("POST", "/api/auth/dev", { subject: "maintainer" })).body.reviewerId;
});


const goldIds = async () =>
  (await env.DB.prepare("SELECT id, json_extract(payload_json, '$.gold.gold_id') AS gold_id, json_extract(payload_json, '$.gold.answer.text') AS answer, json_extract(payload_json, '$.kind') AS kind FROM proposals WHERE batch_id = ?1 AND json_extract(payload_json, '$.gold') IS NOT NULL ORDER BY id").bind(VOL).all<{ id: number; gold_id: string; answer: string; kind: string }>()).results;
const grades = async (reviewerId: string) => (await env.DB.prepare("SELECT gold_id, hit FROM phist_gold_grades WHERE reviewer_id = ?1").bind(reviewerId).all<{ gold_id: string; hit: number }>()).results;

/** A counting reviewer (mid-century standing) whose gold schedule puts a gold line first (offset 0 in its block of 5). */
async function goldFirst(prefix: string): Promise<R> {
  for (let k = 0; k < 40; k++) {
    const r = await R.make(`${prefix}-${k}`, { standing: true });
    if (Math.floor(scheduleSeed(r.id) * FRONT_BLOCK) === 0) return r;
  }
  throw new Error("no reviewer with offset 0");
}

/** Give a reviewer `graded` P-hist gold grades, `hits` of them hits, on the fixture's gold lines (as if decided). */
async function giveGold(reviewerId: string, graded: number, hits: number) {
  const gold = (await goldIds()).slice(0, graded);
  await env.DB.batch(
    gold.flatMap((g, i) => [
      env.DB.prepare(
        `INSERT INTO decisions (id, proposal_id, reviewer_id, value, text, proposal_sha256, terms_version, created_at, decided_on)
         VALUES (?1, ?2, ?3, 'typed', ?4, 'x', 'x', ?5, '2026-11-19')`,
      ).bind(`pg-${reviewerId}-${i}`, g.id, reviewerId, g.answer, `2026-11-19T00:00:${String(i).padStart(2, "0")}.000Z`),
      env.DB.prepare("INSERT INTO phist_gold_grades (decision_id, proposal_id, reviewer_id, gold_id, hit, graded_at) VALUES (?1, ?2, ?3, ?4, ?5, '2026-11-19T00:00:00.000Z')").bind(
        `pg-${reviewerId}-${i}`,
        g.id,
        reviewerId,
        g.gold_id,
        i < hits ? 1 : 0,
      ),
    ]),
  );
}

/** Decide whatever `next` serves until a normal (not gold) line is served; return that line's id. */
async function nextNormal(r: R, gold: Set<number>): Promise<number> {
  for (;;) {
    const p = (await r.next()).body.proposal!;
    if (!gold.has(p.id)) return p.id;
    await r.decide(p.id, { value: "typed", text: "שורה" });
  }
}

describe("line_verify P-hist gold (volunteer_v1_1)", () => {
  it("serves gold on the reviewer's seeded schedule, unlabelled, outside the normal queue and progress", async () => {
    const r = await R.make("sched", { standing: true });
    const gold = new Set((await goldIds()).map((g) => g.id));
    const seed = scheduleSeed(r.id);
    let n = 0;
    let goldServed = 0;
    for (;;) {
      const res = await r.next();
      const p = res.body.proposal;
      if (!p) break;
      expect(res.body.progress.total).toBe(11); // the fixture's lines only
      expect(gold.has(p.id)).toBe(goldDue(n, seed));
      if (gold.has(p.id)) {
        goldServed++;
        // Nothing in what the browser gets says gold: no gold mark, no answer, no gold id.
        const raw = JSON.stringify(p);
        expect(raw).not.toMatch(/gold|answer|planted/);
        expect(p.view.kind === "line_verify" && p.view.attribution).toMatch(/Synthetic test page/);
      }
      const text = p.view.kind === "line_verify" && p.view.lineKind === "type" ? { value: "typed", text: "שורה" } : { value: "exact" };
      expect((await r.decide(p.id, text)).status).toBe(200);
      n++;
    }
    expect(goldServed).toBeGreaterThanOrEqual(2); // 11 lines at 1 in 5 for the first 75
    expect(new Set((await grades(r.id)).map((g) => g.gold_id)).size).toBe(goldServed); // each at most once
  });

  it("a gold decision is final and graded under line_fold_v1, and never routed", async () => {
    const r = await goldFirst("final");
    const first = (await r.next()).body.proposal!;
    const g = (await goldIds()).find((x) => x.id === first.id)!;
    expect(g).toBeDefined();
    // The answer with extra spaces still folds to it: a hit.
    const body = g.kind === "type" ? { value: "typed", text: `  ${g.answer.replace(" ", "  ")} ` } : { value: "edited", text: `${g.answer} ` };
    expect((await r.decide(first.id, body)).status).toBe(200);
    expect(await grades(r.id)).toEqual([{ gold_id: g.gold_id, hit: 1 }]);
    expect(await votes(first.id)).toEqual([]);
    expect(await state(first.id)).toBeNull();
    expect((await r.decide(first.id, { value: "unreadable" })).status).toBe(409);
  });

  it("a non-text answer on a gold line is a miss", async () => {
    const r = await goldFirst("miss");
    const first = (await r.next()).body.proposal!;
    expect((await r.decide(first.id, { value: "unreadable" })).status).toBe(200);
    expect((await grades(r.id))[0]!.hit).toBe(0);
  });

  it("counts a decision only with mid-century standing and >= 90% on >= 15 P-hist gold lines, judged when it is made", async () => {
    const gold = new Set((await goldIds()).map((g) => g.id));
    const few = await R.make("few", { standing: true });
    await giveGold(few.id, 14, 14);
    const a = await nextNormal(few, gold);
    await few.decide(a, { value: "exact" });
    expect((await votes(a))[0]).toMatchObject({ counted: 0, not_counted_reason: "fewer_than_15_phist_gold" });

    const low = await R.make("low", { standing: true });
    await giveGold(low.id, 15, 13);
    const b = await nextNormal(low, gold);
    await low.decide(b, { value: "exact" });
    expect((await votes(b)).find(() => true)).toBeDefined();
    const lowVote = (await env.DB.prepare("SELECT v.counted, v.not_counted_reason FROM verify_votes v JOIN decisions d ON d.id = v.decision_id WHERE d.reviewer_id = ?1").bind(low.id).first())!;
    expect(lowVote).toMatchObject({ counted: 0, not_counted_reason: "below_phist_floor" });

    const ok = await R.make("ok", { standing: true });
    await giveGold(ok.id, 15, 14);
    const c = await nextNormal(ok, gold);
    await ok.decide(c, { value: "exact" });
    const okVote = (await env.DB.prepare("SELECT v.counted, v.step FROM verify_votes v JOIN decisions d ON d.id = v.decision_id WHERE d.reviewer_id = ?1").bind(ok.id).first())!;
    expect(okVote).toMatchObject({ counted: 1 });

    // Without mid-century standing the mid-century reason is given, whatever the P-hist gold.
    const novice = await R.make("novice-p");
    await giveGold(novice.id, 15, 15);
    const d = await nextNormal(novice, gold);
    await novice.decide(d, { value: "exact" });
    const nv = (await env.DB.prepare("SELECT v.not_counted_reason FROM verify_votes v JOIN decisions d ON d.id = v.decision_id WHERE d.reviewer_id = ?1").bind(novice.id).first())!;
    expect(nv).toMatchObject({ not_counted_reason: "fewer_than_20_gold" });
  });

  it("an admin's pull is forward-only, and a pulled line is not served", async () => {
    const gold = new Set((await goldIds()).map((g) => g.id));
    const r = await R.make("pull", { standing: true });
    await giveGold(r.id, 15, 15);
    const a = await nextNormal(r, gold);
    await r.decide(a, { value: "exact" });
    const pulledId = (await goldIds())[0]!.gold_id;
    const admin = new R();
    await admin.req("POST", "/api/auth/dev", { subject: "maintainer" });
    expect((await r.req("PUT", `/api/admin/phist-gold/${pulledId}`, { pulled: true })).status).toBe(403);
    expect((await admin.req("PUT", "/api/admin/phist-gold/no-such-gold", { pulled: true })).status).toBe(404);
    expect((await admin.req("PUT", `/api/admin/phist-gold/${pulledId}`, { pulled: true, reason: "answer wrong" })).status).toBe(200);
    const b = await nextNormal(r, gold);
    await r.decide(b, { value: "exact" });
    const rows = (await env.DB.prepare("SELECT d.proposal_id, v.counted, v.not_counted_reason FROM verify_votes v JOIN decisions d ON d.id = v.decision_id WHERE d.reviewer_id = ?1 ORDER BY d.created_at").bind(r.id).all()).results;
    expect(rows).toEqual([
      { proposal_id: a, counted: 1, not_counted_reason: null }, // stored before the pull: unchanged
      { proposal_id: b, counted: 0, not_counted_reason: "fewer_than_15_phist_gold" }, // 14 unpulled after it
    ]);
    // A pulled line is served to nobody: pull the next reviewer's own first gold line, and they get their second.
    const fresh = await goldFirst("after-pull");
    const order = goldOrder(fresh.id, (await goldIds()).map((g) => g.gold_id).filter((g) => g !== pulledId));
    expect((await admin.req("PUT", `/api/admin/phist-gold/${order[0]}`, { pulled: true })).status).toBe(200);
    const served = (await fresh.next()).body.proposal!;
    expect((await goldIds()).find((g) => g.id === served.id)?.gold_id).toBe(order[1]);
  });

  it("exports line_verify_decisions.v1.5 with a gold section, which the public view drops", async () => {
    const r = await goldFirst("export");
    const first = (await r.next()).body.proposal!;
    await r.decide(first.id, { value: "unreadable" });
    const gold = new Set((await goldIds()).map((g) => g.id));
    const line = await nextNormal(r, gold);
    await r.decide(line, { value: "exact" });
    const admin = new R();
    await admin.req("POST", "/api/auth/dev", { subject: "maintainer" });
    const res = await admin.req<{ problems: string[]; files: Record<string, Record<string, unknown> & { decisions: Record<string, unknown>[]; gold: Record<string, unknown>[] }> }>("GET", `/api/admin/batches/${VOL}/export`);
    expect(res.status).toBe(200);
    expect(res.body.problems).toEqual([]);
    const file = res.body.files["line_verify_decisions.json"]!;
    expect(file).toMatchObject({ schema_version: "line_verify_decisions.v1.5", resolution: "volunteer_v1_1", phist_gold: { file: "phist_gold_v1_1_1.json", lines: 20, pulled: [] } });
    expect(file.gold).toEqual([expect.objectContaining({ reviewer: r.id, hit: false, pulled: false, value: "unreadable" })]);
    expect(file.decisions.map((d) => d.item_id)).not.toContain(expect.stringMatching(/^wikisource:fixture_extra/));
    expect((file.lines as Record<string, unknown>[]).every((l) => !String(l.item_id).startsWith("wikisource:fixture_extra"))).toBe(true);
    const [pub, pubLedger] = publicFiles({ fileName: "line_verify_decisions.json", content: file }, { fileName: "line_verify_decisions_ledger.json", content: res.body.files["line_verify_decisions_ledger.json"] }, new Set((await env.DB.prepare("SELECT external_id FROM proposals WHERE batch_id = ?1 AND json_extract(payload_json, '$.gold') IS NOT NULL").bind(VOL).all<{ external_id: string }>()).results.map((x) => x.external_id)));
    expect((pub!.content as Record<string, unknown>).gold).toBeUndefined();
    expect(publicProblems(pub!.content)).toEqual([]);
    expect(JSON.stringify(pubLedger!.content)).not.toContain("fixture_extra");
    expect(publicProblems(file).join("\n")).toMatch(/\$\.gold/);
  });
});
