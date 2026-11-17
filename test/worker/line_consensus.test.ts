import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { LineConsensusView, NextResponse } from "../../src/shared/api";
import { TERMS_VERSION } from "../../src/shared/terms";
import { goldOffset } from "../../src/worker/consensus";
import { handle } from "../../src/worker/index";
import { Client, ORIGIN } from "./helpers";

const LINES = "newprinted_midcentury_volunteers_v0";
const A = "plenary:K1_1#p1";
const B = "reshumot_scanned:sefer_hachukim_2#p3";
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
let admins = "";

beforeEach(async () => {
  await env.DB.batch(env.TEST_LINE_CONSENSUS_SQL.map((s) => env.DB.prepare(s)));
  admins = "";
});

/** A request through the Worker with volunteer review switched on (preview) and the given admins. */
async function call<T = Record<string, unknown>>(c: Client, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { origin: ORIGIN, cookie: c.cookie };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await handle(
    new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    { ...env, CONSENSUS_ENABLED: "1", ADMIN_REVIEWER_IDS: admins },
    exec,
  );
  return { status: res.status, body: (await res.json()) as T };
}

async function volunteer(name: string): Promise<Client & { id: string }> {
  const c = new Client();
  const id = await c.signIn(name);
  await c.acceptTerms();
  return Object.assign(c, { id });
}

async function next(c: Client) {
  const res = await call<NextResponse>(c, "GET", `/api/batches/${LINES}/next`);
  expect(res.status).toBe(200);
  const view = res.body.proposal?.view as LineConsensusView | undefined;
  return { ...res.body, view };
}

const decide = (c: Client, id: number, value: string, text?: string) => call(c, "POST", `/api/proposals/${id}/decision`, { value, ...(text === undefined ? {} : { text }) });

async function ids(): Promise<Map<string, { id: number; gold: boolean }>> {
  const { results } = await env.DB.prepare("SELECT id, external_id, payload_json FROM proposals WHERE batch_id = ?1 AND active = 1").bind(LINES).all<{
    id: number;
    external_id: string;
    payload_json: string;
  }>();
  return new Map(results.map((r) => [r.external_id, { id: r.id, gold: JSON.parse(r.payload_json).gold !== null }]));
}

/** Gold answers recorded directly (as if served): `hits` right and `misses` wrong, in gold order. */
async function giveGold(reviewerId: string, hits: number, misses = 0): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, content_sha256, payload_json FROM proposals WHERE batch_id = ?1 AND json_extract(payload_json, '$.gold') IS NOT NULL ORDER BY rank",
  )
    .bind(LINES)
    .all<{ id: number; content_sha256: string; payload_json: string }>();
  const stmts = results.slice(0, hits + misses).map((r, k) => {
    const answer = JSON.parse(r.payload_json).gold.answer as { text: string };
    const [value, text] = k < hits ? ["edit", answer.text] : ["unreadable", null];
    return env.DB.prepare(
      `INSERT INTO decisions (id, proposal_id, reviewer_id, value, text, proposal_sha256, terms_version, created_at, decided_on)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '2026-11-18')`,
    ).bind(`hr-gold${reviewerId}${k}`, r.id, reviewerId, value, text, r.content_sha256, TERMS_VERSION, `2026-11-18T00:00:${String(k).padStart(2, "0")}.000Z`);
  });
  await env.DB.batch(stmts);
}

/** A volunteer who already counts: 20 of 20 gold lines right. */
async function counting(name: string) {
  const c = await volunteer(name);
  await giveGold(c.id, 20);
  return c;
}

/** Serve `c` lines until the line `externalId` comes up (skipping others), and return its id. */
async function serveUntil(c: Client, externalId: string): Promise<number> {
  for (let k = 0; k < 20; k++) {
    const n = await next(c);
    if (!n.proposal) break;
    if (n.proposal.externalId === externalId) return n.proposal.id;
    await call(c, "POST", `/api/proposals/${n.proposal.id}/skip`);
  }
  throw new Error(`${externalId} was not served`);
}

const lineState = async (id: number) => env.DB.prepare("SELECT state, needed FROM line_state WHERE proposal_id = ?1").bind(id).first<{ state: string; needed: number }>();

describe("volunteer line review", () => {
  it("is off unless switched on (preview only): not listed, not served", async () => {
    const c = await volunteer("off");
    const off = { ...env, CONSENSUS_ENABLED: undefined };
    const req = (path: string) => handle(new Request(ORIGIN + path, { headers: { origin: ORIGIN, cookie: c.cookie } }), off, exec);
    const list = (await (await req("/api/batches")).json()) as { batches: { id: string }[] };
    expect(list.batches.map((b) => b.id)).not.toContain(LINES);
    expect((await req(`/api/batches/${LINES}/next`)).status).toBe(404);
  });

  it("serves only boxed lines of volunteer pages: never excluded, maintainer-decided, no-box or blank lines", async () => {
    const c = await counting("v-scope");
    const seen: string[] = [];
    for (;;) {
      const n = await next(c);
      if (!n.proposal) break;
      seen.push(n.proposal.externalId);
      expect((await decide(c, n.proposal.id, "correct")).status).toBe(200);
    }
    expect(seen).toEqual([`${A}#l0`, `${A}#l1`, `${A}#l2`, `${B}#l0`, `${B}#l1`]);
  });

  it("shows the crop, the pre-fill and the hints, and nothing about gold or other volunteers", async () => {
    const c = await counting("v-view");
    const n = await next(c);
    expect(n.view).toMatchObject({ kind: "line_consensus", prefill: "שורה 0 בעמוד 1", tierA: true, aiDisagrees: false });
    expect(n.progress).toMatchObject({ ownOnly: true, total: 0, covered: 0, decidedByMe: 20 }); // the 20 gold answers
    const raw = JSON.stringify(n);
    for (const leak of ["gold", "answer", "planted", "needed", "state"]) expect(raw).not.toContain(`"${leak}"`);
    await decide(c, n.proposal!.id, "correct");
    const m = await next(c);
    expect(m.view).toMatchObject({ prefill: "שורה 1 בעמוד 1", aiDisagrees: true });
  });

  it("two agreeing volunteers make a reference; the line is not offered again", async () => {
    const [a, b, c] = [await counting("v-a"), await counting("v-b"), await counting("v-c")];
    const id = (await ids()).get(`${A}#l0`)!.id;
    expect((await decide(a, await serveUntil(a, `${A}#l0`), "correct")).status).toBe(200);
    expect(await lineState(id)).toEqual({ state: "open", needed: 1 });
    expect((await decide(b, await serveUntil(b, `${A}#l0`), "edit", "  שורה 0 בעמוד 1 ")).status).toBe(200);
    expect(await lineState(id)).toEqual({ state: "agreed", needed: 0 });
    const n = await next(c);
    expect(n.proposal!.externalId).not.toBe(`${A}#l0`);
  });

  it("a disagreement sends only that line to a third, then to the maintainer; the maintainer decides it blind", async () => {
    const [a, b, c, d] = [await counting("w-a"), await counting("w-b"), await counting("w-c"), await counting("w-d")];
    const target = `${A}#l1`;
    const id = (await ids()).get(target)!.id;
    await decide(a, await serveUntil(a, target), "correct");
    await decide(b, await serveUntil(b, target), "unreadable");
    expect(await lineState(id)).toEqual({ state: "open", needed: 1 });
    // The third gets the disputed line first (lines needing one more come first).
    expect((await next(c)).proposal!.externalId).toBe(target);
    await decide(c, id, "not_on_page");
    expect(await lineState(id)).toEqual({ state: "to_maintainer", needed: 0 });
    for (;;) {
      const n = await next(d);
      if (!n.proposal) break;
      expect(n.proposal.externalId).not.toBe(target);
      await decide(d, n.proposal.id, "correct");
    }
    const m = new Client();
    admins = await m.signIn("maintainer");
    await m.acceptTerms();
    const queue: string[] = [];
    for (;;) {
      const n = await next(m);
      if (!n.proposal) break;
      queue.push(n.proposal.externalId);
      // Blind: the maintainer gets the line and its pre-fill, never a volunteer's decision.
      expect(n.proposal.mine).toBeNull();
      expect(JSON.stringify(n)).not.toMatch(/"(decisions|reviewer|reviewers|votes)"/);
      await decide(m, n.proposal.id, n.proposal.externalId === target ? "edit" : "not_on_page", n.proposal.externalId === target ? "שורה 1 בעמוד 1!" : undefined);
    }
    expect(queue.sort()).toEqual([`${A}#l1`, `${A}#l3`]);
    expect(await lineState(id)).toEqual({ state: "maintainer", needed: 0 });
    const exp = await call<{ problems: string[]; files: Record<string, { lines: { page_key: string; i: number; outcome: string; reference: unknown }[]; decisions: { i: number; page_key: string; role: string }[] }> }>(
      m,
      "GET",
      `/api/admin/batches/${LINES}/export`,
    );
    expect(exp.status).toBe(200);
    expect(exp.body.problems).toEqual([]);
    const file = exp.body.files["line_consensus_decisions.json"]!;
    expect(file.lines.find((l) => l.page_key === A && l.i === 1)).toMatchObject({ outcome: "maintainer", reference: { action: "edit", text: "שורה 1 בעמוד 1!" } });
    expect(file.decisions.filter((d) => d.page_key === A && d.i === 1).map((d) => d.role)).toEqual(["first", "second", "third", "maintainer"]);
  });

  it("decisions are final, and a line not served to you cannot be decided", async () => {
    const a = await counting("f-a");
    const n = await next(a);
    expect((await decide(a, n.proposal!.id, "correct")).status).toBe(200);
    expect((await decide(a, n.proposal!.id, "unreadable")).status).toBe(409);
    const other = (await ids()).get(`${B}#l1`)!.id;
    expect((await decide(a, other, "correct")).status).toBe(409);
    expect((await call(a, "GET", `/api/proposals/${other}`)).status).toBe(409);
  });

  it("before 20 gold lines a volunteer's decision does not fill a slot; below the floor it does not either", async () => {
    const [p, low, a] = [await volunteer("p-new"), await volunteer("p-low"), await counting("p-a")];
    await giveGold(p.id, 19);
    await giveGold(low.id, 18, 2);
    const target = `${A}#l2`;
    const id = (await ids()).get(target)!.id;
    await decide(a, await serveUntil(a, target), "correct");
    await decide(p, await serveUntil(p, target), "correct");
    expect(await lineState(id)).toEqual({ state: "open", needed: 1 });
    await decide(low, await serveUntil(low, target), "correct");
    expect(await lineState(id)).toEqual({ state: "open", needed: 1 });
  });

  it("the admin switch excludes a volunteer from agreement and reopens their lines, and can include them again", async () => {
    const [a, b] = [await counting("x-a"), await counting("x-b")];
    const target = `${B}#l0`;
    const id = (await ids()).get(target)!.id;
    await decide(a, await serveUntil(a, target), "correct");
    await decide(b, await serveUntil(b, target), "correct");
    expect(await lineState(id)).toEqual({ state: "agreed", needed: 0 });
    const m = new Client();
    admins = await m.signIn("admin-x");
    expect((await call(b, "PUT", `/api/admin/batches/${LINES}/reviewers/${b.id}/exclusion`, { excluded: true })).status).toBe(403);
    const off = await call<{ volunteers: { id: string; standing: string }[] }>(m, "PUT", `/api/admin/batches/${LINES}/reviewers/${b.id}/exclusion`, { excluded: true });
    expect(off.status).toBe(200);
    expect(off.body.volunteers.find((v) => v.id === b.id)!.standing).toBe("excluded");
    expect(await lineState(id)).toEqual({ state: "open", needed: 1 });
    await call(m, "PUT", `/api/admin/batches/${LINES}/reviewers/${b.id}/exclusion`, { excluded: false });
    expect(await lineState(id)).toEqual({ state: "agreed", needed: 0 });
    const report = await call<{ states: Record<string, number>; volunteers: { id: string; goldSeen: number; accuracy: number }[] }>(m, "GET", `/api/admin/batches/${LINES}/volunteers`);
    expect(report.body.volunteers.find((v) => v.id === a.id)).toMatchObject({ goldSeen: 20, accuracy: 1 });
    expect(report.body.states.agreed).toBe(1);
    expect((await call(a, "GET", `/api/admin/batches/${LINES}/volunteers`)).status).toBe(403);
  });

  it("mixes in gold lines at the reviewer's seeded point, each once, looking like any other line", async () => {
    // A volunteer whose seed puts their first gold line within their first few lines.
    let c: (Client & { id: string }) | null = null;
    for (let k = 0; k < 40 && !c; k++) {
      const v = await volunteer(`g-${k}`);
      if (goldOffset(v.id) < 0.3) c = v;
    }
    expect(c).not.toBeNull();
    const gold = new Set([...(await ids())].filter(([, v]) => v.gold).map(([, v]) => v.id));
    const servedGold: number[] = [];
    for (let k = 0; k < 6; k++) {
      const n = await next(c!);
      if (!n.proposal) break;
      expect(n.view!.kind).toBe("line_consensus");
      if (gold.has(n.proposal.id)) servedGold.push(n.proposal.id);
      expect((await decide(c!, n.proposal.id, "correct")).status).toBe(200);
    }
    expect(servedGold.length).toBeGreaterThanOrEqual(1);
    expect(new Set(servedGold).size).toBe(servedGold.length);
  });
});
