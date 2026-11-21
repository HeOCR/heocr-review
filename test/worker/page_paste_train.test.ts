import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { TrainingQueue } from "../../src/shared/page_paste_train";
import { parseTrainingManifest } from "../../src/tasks/page_paste_train/schema";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

const batch = "training-fixture";
const base = `/api/page-paste-train/${batch}`;
const exportPath = `/api/admin/batches/${batch}/export`;
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const image = { path: "pages/front.jpg", sha256: "a".repeat(64), width: 1200, height: 1700 };
const source = { source_id: "training-fixture", catalog_url: "https://example.org/source", rights_uri: "https://creativecommons.org/publicdomain/mark/1.0/" };
const boxes = [[10, 100, 900, 140], [10, 180, 900, 230]];

async function user(name: string) {
  const client = new Client();
  const id = await client.signIn(name);
  await client.acceptTerms();
  return { id, cookie: client.cookie };
}

it("accepts only training manifests with open rights and in-bounds pixel boxes", () => {
  const manifest = {
    schema: "page_paste_train_manifest.v1", task_type: "page_paste_train", split: "train", batch_id: batch,
    title: "Fixture", source, pages: [{ page_id: "front", image, line_boxes: boxes }],
  };
  expect(parseTrainingManifest(manifest)).toEqual(manifest);
  expect(() => parseTrainingManifest({ ...manifest, split: "test" })).toThrow();
  expect(() => parseTrainingManifest({ ...manifest, source: { ...source, rights_uri: "https://creativecommons.org/licenses/by-nc/4.0/" } })).toThrow();
  expect(() => parseTrainingManifest({ ...manifest, pages: [...manifest.pages, ...manifest.pages] })).toThrow();
  expect(() => parseTrainingManifest({ ...manifest, pages: [{ ...manifest.pages[0], line_boxes: [[10, 100, 1201, 140]] }] })).toThrow();
});

it("serves private pages in order, saves mismatched text intact and exports it for alignment", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO batches (id, task_type, title, source_json, imported_at) VALUES (?1,'page_paste_train','Training fixture',?2,'2026-11-20')")
      .bind(batch, JSON.stringify({ split: "train", catalog: source, manifest_sha256: "b".repeat(64) })),
    env.DB.prepare("INSERT INTO page_paste_train_pages VALUES (125,?1,'front',0,?2,?3,2)").bind(batch, JSON.stringify(image), JSON.stringify(boxes)),
    env.DB.prepare("INSERT INTO page_paste_train_pages VALUES (7,?1,'blank',1,?2,'[]',1)").bind(batch, JSON.stringify({ ...image, path: "pages/blank.jpg" })),
    env.DB.prepare("INSERT INTO page_paste_train_assets VALUES (125,1,?1),(125,0,?2)").bind(btoa("two"), btoa("one")),
  ]);
  const admin = await user("paste-admin");
  const volunteer = await user("paste-volunteer");
  const authorless = { cookie: "" };
  const request = (path: string, who: { cookie: string }, body?: unknown, origin = "http://localhost") =>
    handle(new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: who.cookie, origin, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { ...env, ADMIN_REVIEWER_IDS: admin.id }, exec);

  expect(JSON.stringify(await (await request("/api/batches", volunteer)).json())).not.toContain(batch);
  expect(JSON.stringify(await (await request("/api/batches", admin)).json())).toContain(batch);
  expect((await request(`${base}/next`, authorless)).status).toBe(401);
  expect((await request(`${base}/next`, volunteer)).status).toBe(403);
  expect((await request(`${base}/pages/125`, volunteer, { text: "x" })).status).toBe(403);
  expect((await request(exportPath, volunteer)).status).toBe(403);
  expect((await request(`/api/batches/${batch}/next`, admin)).status).toBe(404);

  const next = async () => (await (await request(`${base}/next`, admin)).json() as TrainingQueue).page;
  const first = (await next())!;
  expect(first).toMatchObject({ id: 125, key: "front", detectedCount: 2, image: { width: image.width, height: image.height } });
  expect((await request(first.image.url, volunteer)).status).toBe(403);
  const raster = await request(first.image.url, admin);
  expect(raster.headers.get("cache-control")).toBe("private, no-store");
  expect(new TextDecoder().decode(await raster.arrayBuffer())).toBe("onetwo");

  const save = `${base}/pages/${first.id}`;
  expect((await request(save, admin, { text: "cross site" }, "https://example.org")).status).toBe(403);
  expect((await request(save, admin, { text: "\u0000" })).status).toBe(400);
  expect((await request(save, admin, { text: "x".repeat(32_001) })).status).toBe(400);
  const longLine = `  שָׁלוֹם  ${"א".repeat(10_000)}  `;
  const text = `${longLine}\r\n\r\n`;
  expect(await (await request(save, admin, { text, reviewer: volunteer.id })).json()).toEqual({ ok: true, alignmentMismatch: true });
  expect((await request(save, admin, { text })).status).toBe(200);
  expect((await request(save, admin, { text: "different" })).status).toBe(409);
  expect(await next()).toMatchObject({ id: 7, detectedCount: 0 });
  expect(await (await request(`${base}/pages/7`, admin, { text: "" })).json()).toEqual({ ok: true, alignmentMismatch: false });
  expect(await next()).toBeNull();
  const exported = await (await request(exportPath, admin)).json() as { files: Record<string, unknown>; counts: unknown };
  expect(exported.counts).toEqual({ pages: 2, completed: 2, alignment_mismatches: 1 });
  expect(exported.files["page_paste_train.json"]).toMatchObject({
    schema: "page_paste_train_transcriptions.v1", split: "train", exported_at: expect.stringMatching(/T.*Z$/),
    pages: [
      { page_id: "front", page_text: `${longLine}\n\n`, line_boxes: boxes, detected_line_count: 2,
        entered_line_count: 1, alignment_mismatch: true, reviewer: admin.id },
      { page_id: "blank", page_text: "", line_boxes: [], detected_line_count: 0, entered_line_count: 0, alignment_mismatch: false },
    ],
  });
  const adminProgress = await (await request("/api/admin/progress", admin)).json();
  expect(adminProgress).toMatchObject({ batches: expect.arrayContaining([expect.objectContaining({ id: batch, counts: exported.counts })]) });
  await env.DB.prepare("UPDATE batches SET status = 'closed' WHERE id = ?1").bind(batch).run();
  expect((await request(first.image.url, admin)).status).toBe(404);
  expect((await request(save, admin, { text })).status).toBe(404);
  expect((await request(exportPath, admin)).status).toBe(200);
  await env.DB.prepare("UPDATE batches SET status = 'open', source_json = '{\"split\":\"test\"}' WHERE id = ?1").bind(batch).run();
  expect((await request(`${base}/next`, admin)).status).toBe(404);
  expect((await request(exportPath, admin)).status).toBe(404);
});

it("browses past skipped pages and saves only the author's revisions without overwriting history", async () => {
  const admin = await user("paste-author");
  const other = await user("paste-other-admin");
  const volunteer = await user("paste-other-volunteer");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO batches (id, task_type, title, source_json, imported_at) VALUES (?1,'page_paste_train','Training fixture',?2,'2026-11-20')")
      .bind(batch, JSON.stringify({ split: "train", catalog: source, manifest_sha256: "b".repeat(64) })),
    ...[20, 8, 31].map((id, position) => env.DB.prepare("INSERT INTO page_paste_train_pages VALUES (?1,?2,?3,?4,?5,?6,1)")
      .bind(id, batch, `p000${position + 1}`, position, JSON.stringify(image), JSON.stringify(boxes))),
    // Existing transcriptions have revision 1 without any backfill.
    env.DB.prepare(`INSERT INTO page_paste_train_decisions
      (page_id, reviewer_id, page_text, entered_count, alignment_mismatch, terms_version, saved_at)
      SELECT 8, id, 'ישן', 1, 1, terms_version, '2026-11-20T00:00:00.000Z' FROM reviewers WHERE id = ?1`).bind(admin.id),
  ]);

  const request = (path: string, body?: unknown, who = admin) =>
    handle(new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: who.cookie, origin: "http://localhost", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { ...env, ADMIN_REVIEWER_IDS: `${admin.id},${other.id}` }, exec);
  const getPage = async (path: string, who = admin) => (await (await request(`${base}${path}`, undefined, who)).json() as TrainingQueue).page;

  expect(await getPage("/next")).toMatchObject({ id: 20, number: 1, total: 3, previousId: null, nextId: 8, saved: null });
  expect(await getPage("/next?after=20")).toMatchObject({ id: 31, number: 3, previousId: 8, nextId: null });
  expect(await getPage("/next?after=31")).toMatchObject({ id: 20 });
  expect(await getPage("/next")).toMatchObject({ id: 20, completed: false });
  expect(await getPage("/pages/8")).toMatchObject({ id: 8, number: 2, completed: true, saved: { text: "ישן", revision: 1 } });
  expect(await getPage("/pages/8", other)).toMatchObject({ completed: true, saved: null });
  expect((await request(`${base}/pages/8`, undefined, volunteer)).status).toBe(403);
  expect((await request(`${base}/next?after=999`)).status).toBe(404);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM page_paste_train_decisions").first<{ n: number }>())?.n).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM page_paste_train_history").first<{ n: number }>())?.n).toBe(0);

  const path = `${base}/pages/8`;
  expect((await request(path, { revision: 1, text: "חדש" }, other)).status).toBe(409);
  expect((await request(path, { revision: "1", text: "חדש" })).status).toBe(400);
  expect((await request(path, { revision: 1, text: "ראשון\nשני" })).status).toBe(200);
  expect(await getPage("/pages/8")).toMatchObject({ saved: { text: "ראשון\nשני", revision: 2 } });
  expect((await request(path, { revision: 1, text: "ראשון\nשני" })).status).toBe(200);
  expect((await request(path, { revision: 1, text: "ישן מדי" })).status).toBe(409);
  const edits = await Promise.all(["עריכה א", "עריכה ב"].map((text) => request(path, { revision: 2, text })));
  expect(edits.map((res) => res.status).sort()).toEqual([200, 409]);
  const current = (await getPage("/pages/8"))?.saved;
  expect(current).toEqual({ revision: 3, text: edits[0]!.status === 200 ? "עריכה א" : "עריכה ב" });
  const { results } = await env.DB.prepare(`SELECT revision, reviewer_id, page_text, entered_count, alignment_mismatch, saved_at
    FROM page_paste_train_history WHERE page_id = 8 ORDER BY revision`).all();
  expect(results).toEqual([
    { revision: 1, reviewer_id: admin.id, page_text: "ישן", entered_count: 1, alignment_mismatch: 1, saved_at: "2026-11-20T00:00:00.000Z" },
    { revision: 2, reviewer_id: admin.id, page_text: "ראשון\nשני", entered_count: 2, alignment_mismatch: 0, saved_at: expect.any(String) },
  ]);
  const exported = await (await request(exportPath)).json();
  expect(exported).toMatchObject({ counts: { pages: 3, completed: 1 },
    files: { "page_paste_train.json": { pages: [
      { page_id: "p0001", page_text: null }, { page_id: "p0002", page_text: current?.text }, { page_id: "p0003", page_text: null },
    ] } } });
});
