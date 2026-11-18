import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { NextResponse, ProposalView } from "../../src/shared/api";
import { decisionsFileProblems } from "../../src/tasks/line_verify/schema";
import { handle } from "../../src/worker/index";
import { ORIGIN } from "./helpers";

// docs/specs/line_verify_volunteer_resolution_v1.md on the volunteer fixture (test/fixtures/line_verify_vol: the v1.2
// lines, no blind pass) with resolution volunteer_v1. Standing comes from 20 synthetic gold lines in the mid-century
// volunteer batch. Made-up text throughout.
const VOL = "fixture_line_verify_vol";
const GATE = "newprinted_midcentury_volunteers_v0";
const HARDEST = "wikisource_he_proofread:fixture_lines__p0001#L002"; // a verify line, rank 0
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

const idOf = async (externalId: string) =>
  (await env.DB.prepare("SELECT id FROM proposals WHERE batch_id = ?1 AND external_id = ?2").bind(VOL, externalId).first<{ id: number }>())!.id;
const votes = async (proposalId: number) =>
  (await env.DB.prepare("SELECT v.counted, v.step, v.not_counted_reason, v.by_admin FROM verify_votes v JOIN decisions d ON d.id = v.decision_id WHERE v.proposal_id = ?1 ORDER BY d.created_at").bind(proposalId).all()).results;
const state = async (proposalId: number) => env.DB.prepare("SELECT resolution, open_to FROM verify_state WHERE proposal_id = ?1").bind(proposalId).first<{ resolution: string; open_to: string }>();

beforeEach(async () => {
  await env.DB.batch(env.TEST_LINE_VERIFY_VOL_SQL.map((s) => env.DB.prepare(s)));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO batch_settings (batch_id, updated_at, updated_by, resolution) VALUES (?1, '2026-11-18T00:00:00.000Z', 'test', 'volunteer_v1')").bind(VOL),
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

describe("line_verify volunteer resolution v1", () => {
  it("stores an uncounted decision without moving the line on; two counted agreeing decisions resolve it", async () => {
    const line = await idOf(HARDEST);
    const novice = await R.make("novice");
    expect((await novice.next()).body.proposal!.externalId).toBe(HARDEST);
    expect((await novice.decide(line, { value: "exact" })).status).toBe(200);
    expect(await votes(line)).toEqual([{ counted: 0, step: "uncounted", not_counted_reason: "fewer_than_20_gold", by_admin: 0 }]);
    expect(await state(line)).toMatchObject({ resolution: "pending", open_to: "anyone" });
    // Final: no second decision.
    expect((await novice.decide(line, { value: "unreadable" })).status).toBe(409);
    const a = await R.make("vol-a", { standing: true });
    const b = await R.make("vol-b", { standing: true });
    // (The novice's lease on the line puts it after the others in a's queue; deciding by id is the same line.)
    await a.decide(line, { value: "exact" });
    expect(await state(line)).toMatchObject({ resolution: "pending", open_to: "anyone" });
    await b.decide(line, { value: "edited", text: "הילד הלך אל בית הספר בבוקר  השכם." }); // equal under the fold
    expect((await votes(line)).map((v) => v.step)).toEqual(["uncounted", "pass1", "pass2"]);
    expect(await state(line)).toMatchObject({ resolution: "agreed", open_to: "nobody" });
    const c = await R.make("vol-c", { standing: true });
    expect((await c.next()).body.proposal!.externalId).not.toBe(HARDEST);
  });

  it("a disagreement goes to a third counted reviewer; three different go to the maintainer only, whose decision counts by role", async () => {
    const line = await idOf(HARDEST);
    const [a, b, c, d] = await Promise.all(["v1", "v2", "v3", "v4"].map((n) => R.make(n, { standing: true })));
    await a!.decide(line, { value: "exact" });
    await b!.decide(line, { value: "unreadable" });
    expect(await state(line)).toMatchObject({ resolution: "pending", open_to: "anyone" });
    await c!.decide(line, { value: "misaligned", text: "שורה אחרת" });
    expect((await votes(line)).map((v) => v.step)).toEqual(["pass1", "pass2", "third"]);
    expect(await state(line)).toMatchObject({ resolution: "to_maintainer", open_to: "admin" });
    // Not to another volunteer, not even by link.
    expect((await d!.next()).body.proposal!.externalId).not.toBe(HARDEST);
    expect((await d!.decide(line, { value: "exact" })).status).toBe(409);
    // The maintainer (no standing) gets it, and his decision counts at this step.
    const maint = new R();
    await maint.req("POST", "/api/auth/dev", { subject: "maintainer" });
    const cfg = await maint.req<{ termsVersion: string }>("GET", "/api/config");
    await maint.req("POST", "/api/me/terms", { termsVersion: cfg.body.termsVersion, accept: true, displayName: null });
    expect((await maint.next()).body.proposal!.externalId).toBe(HARDEST);
    await maint.decide(line, { value: "unreadable" });
    expect((await votes(line)).at(-1)).toEqual({ counted: 1, step: "maintainer", not_counted_reason: null, by_admin: 1 });
    expect(await state(line)).toMatchObject({ resolution: "majority", open_to: "nobody" });
  });

  it("when the maintainer decided the line, a fourth volunteer gets it instead; no pair after four is unresolved", async () => {
    const line = await idOf(HARDEST);
    const maint = new R();
    await maint.req("POST", "/api/auth/dev", { subject: "maintainer" });
    const cfg = await maint.req<{ termsVersion: string }>("GET", "/api/config");
    await maint.req("POST", "/api/me/terms", { termsVersion: cfg.body.termsVersion, accept: true, displayName: null });
    await grantStanding(adminId);
    const [a, b, d, e] = await Promise.all(["w1", "w2", "w4", "w5"].map((n) => R.make(n, { standing: true })));
    await maint.decide(line, { value: "exact" }); // counted (he has standing here), as an ordinary pass 1
    await a!.decide(line, { value: "unreadable" });
    expect((await b!.decide(line, { value: "misaligned", text: "שורה שלישית" })).status).toBe(200);
    expect(await state(line)).toMatchObject({ resolution: "pending", open_to: "non_admin" });
    expect((await maint.decide(line, { value: "unreadable" })).status).toBe(409);
    expect((await d!.next()).body.proposal!.externalId).toBe(HARDEST);
    expect((await d!.decide(line, { value: "edited", text: "שורה רביעית" })).status).toBe(200);
    expect((await votes(line)).map((v) => v.step)).toEqual(["pass1", "pass2", "third", "fourth"]);
    expect(await state(line)).toMatchObject({ resolution: "unresolved", open_to: "nobody" });
    expect((await e!.next()).body.proposal!.externalId).not.toBe(HARDEST);
  });

  it("exports line_verify_decisions.v1.4: counted, step and reason per decision; each line's resolution, reference and pair", async () => {
    const line = await idOf(HARDEST);
    const novice = await R.make("x-novice");
    const [a, b] = await Promise.all(["x1", "x2"].map((n) => R.make(n, { standing: true })));
    await novice.decide(line, { value: "unreadable" });
    await a!.decide(line, { value: "exact" });
    await b!.decide(line, { value: "exact" });
    const typed = await idOf("benyehuda_nli_aligned:fixture_pby_42__p0003#L002");
    await a!.decide(typed, { value: "typed", text: "שורה  מוקלדת" });
    const admin = new R();
    await admin.req("POST", "/api/auth/dev", { subject: "maintainer" });
    const res = await admin.req<{ problems: string[]; files: Record<string, Record<string, unknown> & { decisions: Record<string, unknown>[]; lines: Record<string, unknown>[] }> }>(
      "GET",
      `/api/admin/batches/${VOL}/export`,
    );
    expect(res.status).toBe(200);
    expect(res.body.problems).toEqual([]);
    const file = res.body.files["line_verify_decisions.json"]!;
    expect(file).toMatchObject({ schema_version: "line_verify_decisions.v1.4", resolution: "volunteer_v1", gate_batch_id: GATE });
    const mine = file.decisions.filter((d) => d.item_id === HARDEST);
    expect(mine.map((d) => [d.counted, d.step, d.not_counted_reason ?? null])).toEqual(
      expect.arrayContaining([
        [false, "uncounted", "fewer_than_20_gold"],
        [true, "pass1", null],
        [true, "pass2", null],
      ]),
    );
    const l = file.lines.find((x) => x.item_id === HARDEST)!;
    expect(l).toMatchObject({ kind: "verify", resolution: "agreed", reference: { class: "text" } });
    expect((l.pair as string[]).every((id) => mine.some((d) => d.decision_id === id && d.counted === true))).toBe(true);
    expect(file.lines.find((x) => x.item_id === "benyehuda_nli_aligned:fixture_pby_42__p0003#L002")).toMatchObject({ kind: "type", resolution: "pending", reference: null, pair: null });
    const rows = (await env.DB.prepare("SELECT external_id, payload_json FROM proposals WHERE batch_id = ?1").bind(VOL).all<{ external_id: string; payload_json: string }>()).results;
    const items = rows.map((r) => {
      const x = JSON.parse(r.payload_json) as { candidate_text: string; kind: "verify" | "type" };
      return { item_id: r.external_id, candidate_text: x.candidate_text, kind: x.kind, blind: false };
    });
    expect(decisionsFileProblems(file, VOL, items)).toEqual([]);
  });

  it("leaves batches without the setting as they were", async () => {
    await env.DB.prepare("DELETE FROM batch_settings WHERE batch_id = ?1").bind(VOL).run();
    const a = await R.make("single-a");
    const line = await idOf(HARDEST);
    await a.decide(line, { value: "exact" });
    expect(await votes(line)).toEqual([]);
    expect((await a.decide(line, { value: "unreadable" })).status).toBe(200); // not final outside volunteer_v1
    const b = await R.make("single-b");
    expect((await b.next()).body.proposal!.externalId).not.toBe(HARDEST); // one decision covers it (min_reviewers 1)
    const shown = await b.req<{ proposal: ProposalView }>("GET", `/api/proposals/${line}`);
    expect(shown.status).toBe(200);
  });
});
