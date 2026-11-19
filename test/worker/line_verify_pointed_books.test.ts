import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../../src/worker/index";
import { ORIGIN } from "./helpers";

// The pointed-book rule (migrations/0011_pointed_books.sql) on the line_verify fixture (fixture_line_verify_v1: 7
// lines of book fixture_lines, 4 of fixture_pby_42; made-up text). Mid-century standing for a non-admin comes from 20
// synthetic gold lines, as in line_verify_volunteer.test.ts.
const LV = "fixture_line_verify_v1";
const GATE = "newprinted_midcentury_volunteers_v0";
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
let adminId = "";
const E = () => ({ ...env, ADMIN_REVIEWER_IDS: adminId });

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
  static async make(name: string): Promise<R> {
    const r = new R();
    r.id = (await r.req<{ reviewerId: string }>("POST", "/api/auth/dev", { subject: name })).body.reviewerId;
    const cfg = await r.req<{ termsVersion: string }>("GET", "/api/config");
    await r.req("POST", "/api/me/terms", { termsVersion: cfg.body.termsVersion, accept: true, displayName: null });
    return r;
  }
  decide(id: number, body: Record<string, unknown>) {
    return this.req<{ value: string }>("POST", `/api/proposals/${id}/decision`, body);
  }
}

const lines = async () =>
  (await env.DB.prepare("SELECT id, active, json_extract(payload_json, '$.page.book_id') AS book FROM proposals WHERE batch_id = ?1 ORDER BY rank").bind(LV).all<{ id: number; active: number; book: string }>()).results;
const activeOf = async (book: string) => (await lines()).filter((l) => l.book === book && l.active === 1).length;

async function grantStanding(reviewerId: string) {
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO batches (id, task_type, title, source_json, min_reviewers, status, imported_at) VALUES (?1, 'line_consensus', 'gate', '{}', 1, 'closed', '2026-11-18T00:00:00.000Z')").bind(GATE),
    env.DB.prepare("INSERT OR IGNORE INTO items (batch_id, external_id, title, payload_json) VALUES (?1, 'gold_page', 'g', '{}')").bind(GATE),
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
       INSERT OR IGNORE INTO proposals (batch_id, item_id, external_id, category, confidence, rank, payload_json, media_json, content_sha256, active)
       SELECT ?1, (SELECT id FROM items WHERE batch_id = ?1 AND external_id = 'gold_page'), 'gold_' || i, 'c', 'c', i,
         json_object('prefill', 'שורה', 'gold', json_object('gold_id', 'g' || i, 'answer', json_object('action', 'edit', 'text', 'שורה'), 'planted_error', NULL)),
         '{}', 'x', 1 FROM n`,
    ).bind(GATE),
  ]);
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

beforeEach(async () => {
  const admin = new R();
  adminId = (await admin.req<{ reviewerId: string }>("POST", "/api/auth/dev", { subject: "maintainer" })).body.reviewerId;
});

describe("pointed-book rule", () => {
  it("an admin's 'print has niqqud' takes the book's other undecided lines out, keeps decided ones, and records each", async () => {
    const admin = await R.make("maintainer");
    const book = (await lines()).filter((l) => l.book === "fixture_lines");
    expect(book).toHaveLength(7);
    expect((await admin.decide(book[0]!.id, { value: "exact" })).status).toBe(200);
    expect((await admin.decide(book[1]!.id, { value: "pointed_print" })).status).toBe(200);
    const after = await lines();
    expect(after.filter((l) => l.book === "fixture_lines" && l.active === 1).map((l) => l.id)).toEqual([book[0]!.id, book[1]!.id]);
    expect(await activeOf("fixture_pby_42")).toBe(4); // another book is untouched
    const drops = (await env.DB.prepare("SELECT proposal_id, book_id FROM pointed_book_drops WHERE batch_id = ?1 ORDER BY proposal_id").bind(LV).all()).results;
    expect(drops.map((d) => d.proposal_id)).toEqual(book.slice(2).map((l) => l.id));
    expect(new Set(drops.map((d) => d.book_id))).toEqual(new Set(["fixture_lines"]));
  });

  it("a reviewer whose decisions count takes the book out; one who does not count does not", async () => {
    const novice = await R.make("novice");
    const book = (await lines()).filter((l) => l.book === "fixture_lines");
    await novice.decide(book[0]!.id, { value: "pointed_print" });
    expect(await activeOf("fixture_lines")).toBe(7);
    const counting = await R.make("counting");
    await grantStanding(counting.id);
    await counting.decide(book[1]!.id, { value: "pointed_print" });
    expect(await activeOf("fixture_lines")).toBe(2); // the two decided lines stay
  });

  it("does nothing in a batch set to pointed_books 'keep'", async () => {
    await env.DB.prepare("INSERT INTO batch_settings (batch_id, updated_at, updated_by, pointed_books) VALUES (?1, 'x', 'test', 'keep')").bind(LV).run();
    const admin = await R.make("maintainer");
    const book = (await lines()).filter((l) => l.book === "fixture_lines");
    await admin.decide(book[0]!.id, { value: "pointed_print" });
    expect(await activeOf("fixture_lines")).toBe(7);
  });
});
