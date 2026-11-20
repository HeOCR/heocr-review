import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RealismQueue, RealismTrial } from "../../src/shared/synth_realism";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

const batch = "realism-fixture";
const base = `/api/synth-realism/${batch}`;
const exportPath = `/api/admin/batches/${batch}/export`;
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function seed(control: "standard" | "real_real") {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO batches (id,task_type,title,source_json,imported_at) VALUES (?1,'synth_realism','Realism fixture','{}','2026-11-20')").bind(batch),
    env.DB.prepare(`INSERT INTO synth_realism_items (batch_id,external_id,synthetic_image,synthetic_line_crop,real_ref_image,real_ref_line_crop,generator_id,generator_version,params_hash,control_kind)
      VALUES (?1,'pair-key','synth-page','synth-line','ref-page','ref-line','generator-secret','v3','params-secret',?2)`).bind(batch, control),
    ...["synth-page", "synth-line", "ref-page", "ref-line"].map((key) =>
      env.DB.prepare("INSERT INTO synth_realism_assets (sha256,part,base64) VALUES (?1,0,?2)").bind(key, btoa(key))),
  ]);
}

async function user(name: string) {
  const client = new Client();
  const id = await client.signIn(name);
  await client.acceptTerms();
  return { id, cookie: client.cookie };
}

function request(path: string, who: {cookie: string}, admin: string, body?: unknown, development = true) {
  return handle(new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: who.cookie, origin: "http://localhost", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...env, ENVIRONMENT: development ? "development" : "production", SYNTH_REALISM_ENABLED: "1", ADMIN_REVIEWER_IDS: admin }, exec);
}

describe("synthetic realism queue", () => {
  it("keeps the queue, answers and both image types private and persists the first blind choice", async () => {
    await seed("standard");
    const admin = await user("sr-admin");
    const other = await user("sr-volunteer");
    const secondAdmin = await user("sr-second-admin");
    const ids = `${admin.id},${secondAdmin.id}`;
    const list = await (await request("/api/batches", other, ids)).json();
    expect(JSON.stringify(list)).not.toContain(batch);
    expect((await request(`${base}/next`, other, ids, {})).status).toBe(403);
    expect((await request(`${base}/next`, admin, ids, {}, false)).status).toBe(404);
    expect((await request(`/api/batches/${batch}/next`, admin, ids)).status).toBe(404);

    const next = async () => (await (await request(`${base}/next`, admin, ids, {})).json()) as RealismQueue;
    const [first, second] = await Promise.all([next(), next()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ total: 1, completed: 0 });
    const trial = first.trial!;
    expect(Object.keys(trial).sort()).toEqual(["id", "pair", "reveal"]);
    expect(trial.reveal).toBeNull();
    expect(JSON.stringify(trial)).not.toMatch(/generator-secret|params-secret|real_real|synth-page|ref-page/);
    for (const { page, line } of trial.pair) {
      expect((await request(page, other, ids)).status).toBe(403);
      expect((await request(line, secondAdmin, ids)).status).toBe(404);
      expect((await request(line, admin, ids)).headers.get("cache-control")).toBe("private, no-store");
    }
    const path = `${base}/trials/${trial.id}`;
    expect((await request(`${path}/feedback`, admin, ids, { score: 7, tags: [] })).status).toBe(409);
    const displayed = new TextDecoder().decode(await (await request(trial.pair[0].page, admin, ids)).arrayBuffer());
    const choice = await request(`${path}/choice`, admin, ids, { choice: 0, latency_ms: 40 });
    expect(choice.status).toBe(200);
    const reveal = ((await choice.json()) as RealismTrial).reveal!;
    expect(reveal.choice).toBe(0);
    expect(reveal.synthetic[0]).toBe(displayed === "synth-page");
    expect(reveal.synthetic.filter(Boolean)).toHaveLength(1);
    expect((await next()).trial!.reveal).toEqual(reveal);
    const retry = (await (await request(`${path}/choice`, admin, ids, { choice: 1, latency_ms: 20 })).json()) as RealismTrial;
    expect(retry.reveal).toEqual(reveal);

    expect((await request(`${path}/feedback`, admin, ids, { score: 11, tags: [] })).status).toBe(400);
    expect((await request(`${path}/feedback`, admin, ids, { score: 8, tags: ["soft_texture", "fake-tag"] })).status).toBe(400);
    expect((await request(`${path}/feedback`, admin, ids, { score: 8, tags: ["soft_texture", "too_clean"], comment: "Test fixture." })).status).toBe(200);
    expect((await request(`${path}/feedback`, admin, ids, { score: 0, tags: [] })).status).toBe(200);
    expect(await next()).toEqual({ total: 1, completed: 1, trial: null });
    expect((await request(trial.pair[0].page, admin, ids)).status).toBe(404);
    expect((await request(exportPath, other, ids)).status).toBe(403);

    const exported = JSON.stringify(await (await request(exportPath, admin, ids)).json());
    expect(JSON.parse(exported).files["synth_realism_dev.json"]).toMatchObject({
      purpose: "generator_development_only",
      decisions: [{ choice: 0, correct: !reveal.synthetic[0], reviewer: admin.id, latency_ms: expect.any(Number),
        score: 8, tags: ["soft_texture", "too_clean"], comment: "Test fixture." }],
      generators: [{ choices: 1, mean_score: 8, tag_counts: { soft_texture: 1, too_clean: 1 } }],
    });
  });

  it("reveals both real sides only after the choice and leaves correctness unset for that control", async () => {
    await seed("real_real");
    const admin = await user("sr-control");
    const state = await (await request(`${base}/next`, admin, admin.id, {})).json() as RealismQueue;
    expect(state.trial!.reveal).toBeNull();
    const choice = await request(`${base}/trials/${state.trial!.id}/choice`, admin, admin.id, { choice: 1, latency_ms: 50 });
    expect((await choice.json() as RealismTrial).reveal).toEqual({ choice: 1, synthetic: [false, false] });
    const { files } = await (await request(exportPath, admin, admin.id)).json() as {files: Record<string, unknown>};
    expect(files["synth_realism_dev.json"]).toMatchObject({
      decisions: [{ choice: 1, real_side: null, correct: null, completed_at: null }],
      generators: [],
      controls: { real_real: { choices: 1, rejected_left: 1, rejected_right: 0 } },
    });
  });
});
