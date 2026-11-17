import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BatchSummary, NextResponse, PageReviewView } from "../../src/shared/api";
import { buildExport } from "../../src/tasks/export";
import { exportRows, getBatch } from "../../src/worker/db";
import { Client } from "./helpers";

const PAGES = "newprinted_midcentury_v0";
const SUBSET = "interim_fixture";
const PICK = "reshumot_scanned:sefer_hachukim_1#p2";
const ALT = "reshumot_scanned:kovetz_hatakanot_7#p1";
const PLENARY = "plenary:K2_1#p3";

async function reviewer(name: string): Promise<Client> {
  const c = new Client();
  await c.signIn(name);
  await c.acceptTerms();
  return c;
}

const loadSubset = () => env.DB.batch(env.TEST_SUBSET_SQL.map((s) => env.DB.prepare(s)));

async function next(c: Client, subset: string | null = SUBSET) {
  const res = await c.get<NextResponse>(`/api/batches/${PAGES}/next${subset ? `?subset=${subset}` : ""}`);
  expect(res.status).toBe(200);
  return res.body as NextResponse & { proposal: (NextResponse["proposal"] & { view: PageReviewView }) | null };
}

type Served = Awaited<ReturnType<typeof next>>;
const linesOf = (n: Served) => n.proposal!.view.lines.map((l) => ({ src: [l.i], action: "correct" }));
const confirm = (c: Client, n: Served, lines = linesOf(n)) =>
  c.post(`/api/proposals/${n.proposal!.id}/decision`, {
    value: "confirm",
    text: JSON.stringify({ lines, reading_order_verified: n.proposal!.view.readingOrderCheck ? true : null }),
  });
const reject = (c: Client, n: Served) => c.post(`/api/proposals/${n.proposal!.id}/decision`, { value: "reject", text: JSON.stringify({ reject_reason: "blank" }) });

describe("subset filter (interim set)", () => {
  it("is listed with its batch and serves only its picks, in rank order, with progress over its strata", async () => {
    const c = await reviewer("ida");
    const before = await c.get<{ batches: BatchSummary[] }>("/api/batches");
    expect(before.body.batches.find((b) => b.id === PAGES)!.subsets).toEqual([]);
    expect((await c.get(`/api/batches/${PAGES}/next?subset=${SUBSET}`)).status).toBe(404);
    await loadSubset();
    const listed = await c.get<{ batches: BatchSummary[] }>("/api/batches");
    expect(listed.body.batches.find((b) => b.id === PAGES)!.subsets).toEqual([{ id: SUBSET, title: "סט ביניים", size: 2 }]);
    expect((await c.get(`/api/batches/${PAGES}/next?subset=nope`)).status).toBe(404);
    expect((await c.get(`/api/batches/${PAGES}/next?subset=${encodeURIComponent("a b")}`)).status).toBe(404);

    const first = await next(c);
    expect(first.proposal!.externalId).toBe(PICK);
    expect(first.progress).toMatchObject({ total: 2, covered: 0, decidedByMe: 0, remainingForMe: 2 });
    expect((await confirm(c, first)).status).toBe(200);
    const second = await next(c);
    expect(second.proposal!.externalId).toBe(PLENARY);
    expect((await confirm(c, second)).status).toBe(200);
    const done = await next(c);
    expect(done.proposal).toBeNull();
    expect(done.progress).toMatchObject({ total: 2, covered: 2, decidedByMe: 2, remainingForMe: 0 });
    // The full queue still has the rest of the batch.
    expect((await next(c, null)).proposal!.externalId).toBe(ALT);
  });

  it("replaces a rejected pick by its alternate, and a pick confirmed with no reference line too", async () => {
    await loadSubset();
    const c = await reviewer("jon");
    const first = await next(c);
    expect(first.proposal!.externalId).toBe(PICK);
    expect((await reject(c, first)).status).toBe(200);
    const second = await next(c);
    expect(second.proposal!.externalId).toBe(PLENARY); // rank 1, before the alternate (rank 2)
    expect(second.progress).toMatchObject({ total: 2, remainingForMe: 2 });
    expect((await confirm(c, second)).status).toBe(200);
    const alt = await next(c);
    expect(alt.proposal!.externalId).toBe(ALT);
    // Every line not on the page: nothing to score, so the stratum moves on; it has no alternate left.
    expect((await confirm(c, alt, alt.proposal!.view.lines.map((l) => ({ src: [l.i], action: "not_on_page" })))).status).toBe(200);
    const done = await next(c);
    expect(done.proposal).toBeNull();
    expect(done.progress).toMatchObject({ total: 2, covered: 1, decidedByMe: 1, remainingForMe: 0 });
  });

  it("changes no proposal, and the export is byte-identical with and without the subset tables", async () => {
    const snapshot = async () =>
      JSON.stringify(
        (await env.DB.prepare("SELECT id, external_id, content_sha256, rank, active, gate_kind, gate_ref, payload_json FROM proposals ORDER BY id").all()).results,
      );
    const proposalsBefore = await snapshot();
    await loadSubset();
    expect(await snapshot()).toBe(proposalsBefore);
    const c = await reviewer("kai");
    expect((await confirm(c, await next(c))).status).toBe(200);
    expect((await reject(c, await next(c))).status).toBe(200);
    const exported = async () => {
      const batch = (await getBatch(env.DB, PAGES))!;
      const out = buildExport({ batch, ...(await exportRows(env.DB, PAGES)), exportedAt: "2026-11-15T12:00:00.000Z" });
      expect(out.problems).toEqual([]);
      return JSON.stringify([out.decisionsFile, out.ledgerFile]);
    };
    const withSubset = await exported();
    await env.DB.batch([env.DB.prepare("DELETE FROM subset_members"), env.DB.prepare("DELETE FROM subsets")]);
    expect(await exported()).toBe(withSubset);
    expect(JSON.parse(withSubset)[0].content.decisions).toHaveLength(2);
  });
});

/** A volunteer line batch whose pages are `real` (non-gold lines) and `gold` (gold lines only). */
async function volunteerBatch(real: string[], gold: string[]) {
  const b = "fixture_volunteers";
  const stmts = [
    env.DB.prepare("INSERT INTO batches (id, task_type, title, source_json, min_reviewers, status, imported_at) VALUES (?1, 'line_consensus', 't', '{}', 1, 'open', '2026-11-18T00:00:00Z')").bind(b),
  ];
  for (const [k, page] of [...real, ...gold].entries()) {
    const isGold = gold.includes(page);
    stmts.push(env.DB.prepare("INSERT INTO items (batch_id, external_id, title, payload_json) VALUES (?1, ?2, 't', '{}')").bind(b, page));
    stmts.push(
      env.DB.prepare(
        `INSERT INTO proposals (batch_id, item_id, external_id, category, confidence, rank, payload_json, media_json, content_sha256, active)
         VALUES (?1, (SELECT id FROM items WHERE batch_id = ?1 AND external_id = ?2), ?3, 'x', 'matched', ?4, ?5, '{}', 'h', 1)`,
      ).bind(b, page, `${page}#l0`, k, JSON.stringify({ gold: isGold ? { gold_id: "g" } : null })),
    );
  }
  await env.DB.batch(stmts);
}

describe("volunteer pages and the maintainer's queue", () => {
  it("leaves a volunteer page out of 'all pages', but a filter that names it still serves it; a gold-only page stays", async () => {
    const before: string[] = [];
    const c = await reviewer("ivy");
    for (;;) {
      const n = await next(c, null);
      if (!n.proposal) break;
      before.push(n.proposal.externalId);
      await c.post(`/api/proposals/${n.proposal.id}/skip`);
    }
    expect(before).toContain(PICK);
    expect(before).toContain(PLENARY);
    await volunteerBatch([PICK], [PLENARY]);
    await loadSubset();
    const d = await reviewer("ivy-2");
    const after: string[] = [];
    for (;;) {
      const n = await next(d, null);
      if (!n.proposal) break;
      after.push(n.proposal.externalId);
      await d.post(`/api/proposals/${n.proposal.id}/skip`);
    }
    expect(after).not.toContain(PICK);
    expect(after).toContain(PLENARY);
    expect(after).toHaveLength(before.length - 1);
    expect((await next(d)).proposal!.externalId).toBe(PICK);
  });
});
