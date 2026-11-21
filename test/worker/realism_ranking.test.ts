import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { RankingQueue } from "../../src/shared/synth_realism";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

const batch = "ranking-fixture";
const base = `/api/realism-ranking/${batch}`;
const exportPath = `/api/admin/batches/${batch}/export`;
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function fixture() {
  const owner = new Client();
  const id = await owner.signIn("ranking-owner");
  await owner.acceptTerms();
  const other = new Client();
  const otherId = await other.signIn("ranking-other-admin");
  await other.acceptTerms();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM synth_ranking_answers"),
    env.DB.prepare("DELETE FROM synth_ranking_pairs"),
    env.DB.prepare("DELETE FROM batches WHERE id=?1").bind(batch),
    env.DB.prepare("INSERT INTO batches (id,task_type,title,source_json,imported_at) VALUES (?1,'synth_realism','Fixture',?2,'2026-11-21')")
      .bind(batch, '{"realism_mode":"ranking","fixture":true,"ranking_arm_modalities":{"arm-alpha":"scan","arm-beta":"scan"}}'),
    ...Array.from({ length: 3 }, (_, i) => env.DB.prepare(`INSERT INTO synth_ranking_pairs
      (batch_id,position,pair_id,item_a,arm_a,image_a,item_b,arm_b,image_b) VALUES (?1,?2,?3,'item-a',?4,'img-a','item-b',?5,'img-b')`)
      .bind(batch, i + 1, `secret-pair-${i + 1}`, i === 2 ? null : "arm-alpha", i === 0 ? "arm-beta" : null)),
    ...["img-a", "img-b"].map(key =>
      env.DB.prepare("INSERT OR IGNORE INTO synth_realism_assets (sha256,part,base64) VALUES (?1,0,?2)").bind(key, btoa(key))),
  ]);
  const request = (path: string, opts: { who?: Client | null; production?: boolean; enabled?: boolean; body?: unknown; origin?: string } = {}) => {
    const host = opts.production ? "https://review.heocr-review.invalid" : "http://localhost";
    return handle(new Request(host + path, {
      method: opts.body === undefined ? "GET" : "POST", body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      headers: { cookie: opts.who === null ? "" : (opts.who ?? owner).cookie, origin: opts.origin ?? host, "content-type": "application/json" },
    }), { ...env, ENVIRONMENT: opts.production ? "production" : "development", REALISM_RANKING_ENABLED: opts.enabled === false ? "0" : "1",
      SYNTH_REALISM_ENABLED: "1", RESTRICTED_REFERENCE_REVIEWER_ID: id, ADMIN_REVIEWER_IDS: id + "," + otherId }, exec);
  };
  const state = async (r: Promise<Response>) => {
    const res = await r;
    expect(res.status).toBe(200);
    return res.json<RankingQueue>();
  };
  const choose = (p: number, revision: number, choice = 0) => state(request(`${base}/pairs/${p}/choice`,
    { body: { revision, choice, latency_ms: 70 } }));
  const undo = (p: number, revision: number) => state(request(`${base}/pairs/${p}/undo`, { body: { revision } }));
  return { id, other, request, state, choose, undo };
}

it("allows only the selected reviewer, keeps arms hidden and preloads without writing answers", async () => {
  const f = await fixture();
  for (const path of [base + "/next", base + "/pairs/1/image/0", exportPath]) {
    expect((await f.request(path, { enabled: false })).status).toBe(404);
    expect((await f.request(path, { who: null })).status).toBe(401);
    expect((await f.request(path, { who: f.other })).status).toBe(404);
    expect((await f.request(path, { production: true })).status).toBe(404);
  }
  expect(JSON.stringify(await (await f.request("/api/batches", { who: f.other })).json())).not.toContain(batch);
  expect(JSON.stringify(await (await f.request("/api/batches")).json())).toContain('"realismMode":"ranking"');
  expect((await f.request(`/api/synth-realism/${batch}/next`, { body: {} })).status).toBe(404);
  const first = await f.state(f.request(base + "/next"));
  expect(first).toMatchObject({ total: 3, completed: 0, current: { position: 1, revision: 0 }, next: { position: 2 }, previous: null });
  expect(JSON.stringify(first)).not.toMatch(/arm|secret-pair|control|img-a|item-a/);
  expect((await f.request(first.next!.images[0])).headers.get("cache-control")).toBe("private, no-store");
  expect((await f.request(base + "/pairs/3/image/0")).status).toBe(404);
  expect(await f.state(f.request(base + "/next"))).toEqual(first);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM synth_ranking_answers").first("n")).toBe(0);
});

it("writes the first valid choice once, supports atomic undo and exports the displayed sides", async () => {
  const f = await fixture();
  const path = base + "/pairs/1/choice";
  expect((await f.request(path, { body: { revision: 0, choice: 0, latency_ms: 15 }, origin: "https://bad.invalid" })).status).toBe(403);
  expect((await f.request(path, { body: { revision: 0, choice: 2, latency_ms: 15 } })).status).toBe(400);
  expect((await f.choose(2, 0)).completed).toBe(0);
  const leftOfOne = new TextDecoder().decode(await (await f.request(base + "/pairs/1/image/0")).arrayBuffer());
  const [a, b] = await Promise.all([f.choose(1, 0), f.choose(1, 0)]);
  expect(a).toEqual(b);
  expect(a).toMatchObject({ completed: 1, current: { position: 2, revision: 0 }, previous: { position: 1, revision: 1 } });
  expect((await f.choose(1, 0, 1)).completed).toBe(1);
  expect((await f.undo(1, 1))).toMatchObject({ completed: 0, current: { position: 1, revision: 2 } });
  expect((await f.choose(1, 0)).completed).toBe(0);
  expect((await f.choose(1, 2, 1)).completed).toBe(1);
  expect((await f.undo(1, 1)).completed).toBe(1);
  const rightOfTwo = new TextDecoder().decode(await (await f.request(base + "/pairs/2/image/1")).arrayBuffer());
  expect((await f.choose(2, 0, 1)).completed).toBe(2);
  expect((await f.undo(1, 3)).completed).toBe(2);
  expect((await f.choose(3, 0)).current).toBeNull();
  const data = await (await f.request(exportPath)).json<{ files: Record<string, unknown> }>();
  expect(data.files["realism_ranking_cc0.json"]).toMatchObject({
    license: "CC0-1.0", purpose: "generator_development_only",
    modality_by_arm: { "arm-alpha": "scan", "arm-beta": "scan" },
    decisions: [
      { control: "standard", reviewer: f.id, chosen_at: expect.any(String), latency_ms: 70,
        pair_id: "secret-pair-1", left_item_id: leftOfOne === "img-a" ? "item-a" : "item-b", choice: "right", correct: null },
      { control: "real_synth", right_item_id: rightOfTwo === "img-b" ? "item-b" : "item-a", choice: "right", correct: rightOfTwo === "img-b" },
      { control: "real_real", correct: null, choice: "left" },
    ],
  });
  expect((await f.undo(3, 1)).completed).toBe(2);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM synth_ranking_answers WHERE choice IS NOT NULL").first("n")).toBe(2);
});
