import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { BatchSummary, PagePasteQueue } from "../../src/shared/api";
import { sha256Hex } from "../../src/shared/sha256";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

const batch = "fixture_line_verify_v12";
const route = `/api/batches/${batch}`;
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function setup() {
  await env.DB.batch(env.TEST_LINE_VERIFY_V12_SQL.map((sql) => env.DB.prepare(sql)));
  await env.DB.prepare(`INSERT INTO batch_settings (batch_id, updated_at, updated_by, mode, pointed_books)
    VALUES (?1, '2026-11-20T00:00:00.000Z', 'test', 'triage', 'keep')
    ON CONFLICT (batch_id) DO UPDATE SET mode='triage', pointed_books='keep'`).bind(batch).run();
  const admin = new Client();
  const reviewer = await admin.signIn("page-paste-reviewer");
  await admin.acceptTerms();
  const outsider = new Client();
  const outsiderId = await outsider.signIn("page-paste-other");
  await outsider.acceptTerms();
  async function request(path: string, body?: unknown, user = admin, admins = reviewer) {
    return handle(new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: user.cookie, origin: "http://localhost", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { ...env, ADMIN_REVIEWER_IDS: admins }, exec);
  }
  const { results } = await env.DB.prepare(`SELECT p.id, p.item_id, p.external_id, p.content_sha256,
    json_extract(p.payload_json, '$.line_index') AS line_index,
    json_extract(p.payload_json, '$.candidate_text') AS candidate
    FROM proposals p WHERE p.batch_id=?1 AND p.item_id=(SELECT MIN(id) FROM items WHERE batch_id=?1)
    AND json_extract(p.payload_json, '$.pass')=1 ORDER BY line_index`)
    .bind(batch).all<{ id: number; item_id: number; external_id: string; content_sha256: string; line_index: number; candidate: string }>();
  const item = results[0]!.item_id;
  const register = async () => env.DB.prepare(`INSERT INTO page_paste_pages (item_id, batch_id, reviewer_id, ordinal, line_pins_json, registration_sha256, registered_at)
      VALUES (?1, ?2, ?3, 0, ?4, 'registration', '2026-11-20T19:00:00.000Z')`).bind(item, batch, reviewer,
        JSON.stringify(results.map((p) => ({id:p.id, sha256:p.content_sha256})))).run();
  return { request, reviewer, results, item, outsider, outsiderId, register };
}

it("moves registered lines out of the normal queues and saves ordered answers as the assigned reviewer", async () => {
  const { request, reviewer, results, item, outsider, outsiderId, register } = await setup();
  const planted = results.find((p) => p.candidate)!;
  await env.DB.prepare(`INSERT INTO triage_plants (batch_id, proposal_id, item_id, plant_type, position, planted_text,
      planted_sha256, candidate_sha256, plants_sha256, imported_at)
    VALUES (?1, ?2, ?3, 'insertion', '0', 'שינוי', ?4, ?5, 'fixture', '2026-11-20T00:00:00.000Z')`)
    .bind(batch, planted.id, planted.external_id, sha256Hex("שינוי"), sha256Hex(planted.candidate)).run();
  expect((await request(`/api/proposals/${planted.id}/decision`, { value: "correct" })).status).toBe(200);
  await register();

  const before = (await (await request("/api/batches")).json()) as { batches: BatchSummary[] };
  expect(before.batches.find((b) => b.id === batch)).toMatchObject({ pagePaste: { total:1, completed:0 }, triage: { triage:0, fix:4 } });
  expect((await request(`${route}/page-paste/next`, undefined, outsider)).status).toBe(403);
  expect((await request(`${route}/page-paste/next`, undefined, outsider, `${reviewer},${outsiderId}`)).status).toBe(404);
  expect((await request(`/api/proposals/${planted.id}/decision`, { value: "different" })).status).toBe(409);

  const next = (await (await request(`${route}/page-paste/next`)).json()) as PagePasteQueue;
  expect(next).toMatchObject({ total: 1, completed: 0, page: { itemId: item, expected: results.length, image: { url: expect.stringMatching(/^\/media\//) } } });
  const url = `${route}/page-paste/${item}`;
  expect((await request(url, { text: "מעט מדי שורות" })).status).toBe(400);
  expect((await request(url, { text: Array(results.length).fill("שָׁלוֹם").join("\n") })).status).toBe(400);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM decisions").first<{ n: number }>())!.n).toBe(1);

  const text = results.map(({line_index}) => `שורה ${line_index + 1}`).join("\r\n") + "\r\n";
  expect((await request(url, { text, reviewer_id: outsiderId })).status).toBe(200);
  expect((await request(url, { text })).status).toBe(200);
  expect((await request(url, { text: text.replace("שורה", "אחר") })).status).toBe(409);
  const done = (await (await request(`${route}/page-paste/next`)).json()) as PagePasteQueue;
  expect(done).toEqual({ total: 1, completed: 1, page: null });

  const { results: mapped } = await env.DB.prepare(`SELECT d.reviewer_id, d.text, d.correction_start, d.proposal_sha256
    FROM decisions d JOIN proposals p ON p.id=d.proposal_id
    WHERE p.item_id=?1 AND d.superseded_at IS NULL ORDER BY json_extract(p.payload_json, '$.line_index')`).bind(item).all();
  expect(mapped).toEqual(results.map((p) => ({
    reviewer_id: reviewer, text: `שורה ${p.line_index + 1}`, correction_start: "page_paste", proposal_sha256: p.content_sha256,
  })));
  const exported = (await (await request(`/api/admin/batches/${batch}/export`)).json()) as {
    problems: string[]; files: Record<string, { rows: Record<string, unknown>[]; voided_plants: unknown[]; history: unknown[] }>;
  };
  expect(exported.problems).toEqual([]);
  const file = exported.files["reference_triage.json"]!;
  expect(file.rows).toHaveLength(results.length);
  expect(file.rows.find((row) => row.item_id === planted.external_id)).toMatchObject({
    reviewer, queue: "page_paste", plant: null, triage: null, correction: { correction_start: "page_paste" },
  });
  expect(file.voided_plants).toEqual([expect.objectContaining({ item_id: planted.external_id, reason: "page_paste" })]);
  expect(file.history).toContainEqual(expect.objectContaining({ item_id: planted.external_id, value: "correct" }));
});

it("rejects a changed line order without saving any part of the page", async () => {
  const { request, results, item, register } = await setup();
  await register();
  await env.DB.prepare("UPDATE proposals SET payload_json=json_set(payload_json, '$.line_index', 999) WHERE id=?1").bind(results[0]!.id).run();
  const text = results.map(() => "שורה").join("\n");
  expect((await request(`${route}/page-paste/next`)).status).toBe(409);
  expect((await request(`${route}/page-paste/${item}`, { text })).status).toBe(409);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM decisions").first<{ n: number }>())!.n).toBe(0);
});
