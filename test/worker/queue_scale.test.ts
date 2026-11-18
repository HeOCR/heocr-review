import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { BatchSummary } from "../../src/shared/api";
import { Client } from "./helpers";

// Regression (2026-11-18): the maintainer's volunteer-page filter ran for every batch's every proposal, without an
// index; with preview's 18,245 volunteer lines and a 2,869-line batch, progress counts exceeded D1's CPU limit. Here a
// synthetic volunteer batch of preview's scale (18,000 lines on 600 pages, sharing page keys with the page review
// fixture) and a 3,000-line line_verify batch must list in well under a second each way.
const VOLUNTEERS = "scale_volunteers";
const LINES = "scale_line_verify";
const VOLUNTEER_LINES = 18_000;
const VERIFY_LINES = 3_000;
/** Enough of a line_verify payload for the line view (made-up text). */
const LINE_PAYLOAD = JSON.stringify({
  pass: 1,
  candidate_text: "שורה",
  attention_spans: [],
  line_index: 0,
  candidate_provenance: "p",
  page: { source: "s", book_title: "b", page_label: "1", attribution: "a", text_license: "CC0" },
});

beforeEach(async () => {
  const now = "2026-11-18T00:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO batches (id, task_type, title, source_json, min_reviewers, status, imported_at) VALUES
        (?1, 'line_consensus', 'scale volunteers', '{}', 1, 'open', ?3), (?2, 'line_verify', 'scale lines', '{"schema_version":"line_verify_items.v1"}', 1, 'open', ?3)`,
    ).bind(VOLUNTEERS, LINES, now),
    // 600 volunteer pages: the page review fixture's own page keys first, then made-up ones.
    env.DB.prepare(
      `INSERT INTO items (batch_id, external_id, title, payload_json)
       SELECT ?1, external_id, 'p', '{}' FROM items WHERE batch_id = 'newprinted_midcentury_v0'`,
    ).bind(VOLUNTEERS),
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
       INSERT INTO items (batch_id, external_id, title, payload_json)
       SELECT ?1, 'scale_page_' || i, 'p', '{}' FROM n WHERE (SELECT COUNT(*) FROM items WHERE batch_id = ?1) + i <= 600`,
    ).bind(VOLUNTEERS),
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
       INSERT INTO proposals (batch_id, item_id, external_id, category, confidence, rank, payload_json, media_json, content_sha256, active)
       SELECT ?1, it.id, 'v' || i, 'c', 'c', i, '{"gold":null}', '{}', 'x', 1
       FROM n JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS k FROM items WHERE batch_id = ?1) it ON it.k = n.i % 600`,
    ).bind(VOLUNTEERS, VOLUNTEER_LINES),
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
       INSERT INTO items (batch_id, external_id, title, payload_json) SELECT ?1, 'scale_lv_page_' || i, 'p', '{}' FROM n`,
    ).bind(LINES),
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2 - 1)
       INSERT INTO proposals (batch_id, item_id, external_id, category, confidence, rank, payload_json, media_json, content_sha256, active)
       SELECT ?1, it.id, 'l' || i, 'random', 'p', i, ?3, '{}', 'x', 1
       FROM n JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS k FROM items WHERE batch_id = ?1) it ON it.k = n.i % 60`,
    ).bind(LINES, VERIFY_LINES, LINE_PAYLOAD),
  ]);
});

describe("queue at volunteer scale", () => {
  it("lists every batch with its progress quickly, the page review one included", async () => {
    const sizes = await env.DB.prepare("SELECT batch_id, COUNT(*) AS n FROM proposals WHERE batch_id IN (?1, ?2) GROUP BY batch_id ORDER BY batch_id").bind(LINES, VOLUNTEERS).all();
    expect(sizes.results).toEqual([
      { batch_id: LINES, n: VERIFY_LINES },
      { batch_id: VOLUNTEERS, n: VOLUNTEER_LINES },
    ]);
    const c = new Client();
    await c.signIn("scale");
    await c.acceptTerms();
    const t0 = performance.now();
    const res = await c.get<{ batches: BatchSummary[] }>("/api/batches");
    const ms = performance.now() - t0;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.batches.find((b) => b.id === LINES)!.progress).toMatchObject({ total: VERIFY_LINES, remainingForMe: VERIFY_LINES });
    // Before the fix this took tens of seconds (53 s for 2,869 lines locally); with it, milliseconds.
    expect(ms).toBeLessThan(1500);
    const t1 = performance.now();
    expect((await c.get(`/api/batches/${LINES}/next`)).status).toBe(200);
    expect((await c.get("/api/batches/newprinted_midcentury_v0/next")).status).toBe(200);
    expect(performance.now() - t1).toBeLessThan(1500);
  });

  it("looks a page's volunteer twin up by index, not by scanning", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT 1 FROM items vi JOIN batches vb ON vb.id = vi.batch_id JOIN proposals vp ON vp.item_id = vi.id
       WHERE vb.task_type = 'line_consensus' AND vi.external_id = ?1 AND vp.active = 1`,
    )
      .bind("scale_page_1")
      .all<{ detail: string }>();
    const detail = plan.results.map((r) => r.detail).join("\n");
    expect(detail).toMatch(/items_external_id/);
    expect(detail).toMatch(/proposals_item/);
  });
});
