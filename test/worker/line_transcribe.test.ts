import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { LineTranscribeView, NextResponse } from "../../src/shared/api";
import { TERMS_VERSION } from "../../src/shared/terms";
import { handle } from "../../src/worker/index";
import { Client, ORIGIN } from "./helpers";

// Invented fixture pages (no real H page, no text): test/fixtures/line_transcribe/h_line_items_v1.json.
const H = "h_eval_v1_transcribe_v0";
const GATE = "newprinted_midcentury_volunteers_v0";
const P1 = "loc__fixture001__p0001";
const SEEN = "loc__fixture002__p0003";
const JRB = "nli__fixture003__p0002";
const LAD = "nli__fixture004__p0001";
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
let admins = "";

beforeEach(async () => {
  await env.DB.batch([...env.TEST_LINE_CONSENSUS_SQL, ...env.TEST_LINE_TRANSCRIBE_SQL].map((s) => env.DB.prepare(s)));
  admins = "";
});

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

/** Gold answers in the gate batch recorded directly: `hits` right and `misses` wrong. */
async function giveGold(reviewerId: string, hits: number, misses = 0): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, content_sha256, payload_json FROM proposals WHERE batch_id = ?1 AND json_extract(payload_json, '$.gold') IS NOT NULL ORDER BY rank",
  )
    .bind(GATE)
    .all<{ id: number; content_sha256: string; payload_json: string }>();
  await env.DB.batch(
    results.slice(0, hits + misses).map((r, k) => {
      const answer = JSON.parse(r.payload_json).gold.answer as { text: string };
      const [value, text] = k < hits ? ["edit", answer.text] : ["unreadable", null];
      return env.DB.prepare(
        `INSERT INTO decisions (id, proposal_id, reviewer_id, value, text, proposal_sha256, terms_version, created_at, decided_on)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '2026-11-18')`,
      ).bind(`hr-g${reviewerId}${k}`, r.id, reviewerId, value, text, r.content_sha256, TERMS_VERSION, `2026-11-18T00:00:${String(k).padStart(2, "0")}.000Z`);
    }),
  );
}

/** A volunteer past the mid-century floor: 20 of 20 gold lines right in the gate batch. */
async function counting(name: string) {
  const c = await volunteer(name);
  await giveGold(c.id, 20);
  return c;
}

async function next(c: Client, languages = "") {
  const res = await call<NextResponse>(c, "GET", `/api/batches/${H}/next${languages ? `?languages=${languages}` : ""}`);
  expect(res.status).toBe(200);
  return { ...res.body, view: res.body.proposal?.view as LineTranscribeView | undefined };
}

const decide = (c: Client, id: number, value: string, text?: string) => call(c, "POST", `/api/proposals/${id}/decision`, { value, ...(text === undefined ? {} : { text }) });
const lineState = async (id: number) => env.DB.prepare("SELECT state, needed FROM line_state WHERE proposal_id = ?1").bind(id).first<{ state: string; needed: number }>();

/** Every line `c` is served now, skipping each (so the next comes up). */
async function servedAll(c: Client, languages = ""): Promise<string[]> {
  const seen: string[] = [];
  for (let k = 0; k < 20; k++) {
    const n = await next(c, languages);
    if (!n.proposal) break;
    seen.push(n.proposal.externalId);
    await call(c, "POST", `/api/proposals/${n.proposal.id}/skip`);
  }
  return seen;
}

async function serveUntil(c: Client, externalId: string): Promise<number> {
  for (let k = 0; k < 20; k++) {
    const n = await next(c);
    if (!n.proposal) break;
    if (n.proposal.externalId === externalId) return n.proposal.id;
    await call(c, "POST", `/api/proposals/${n.proposal.id}/skip`);
  }
  throw new Error(`${externalId} was not served`);
}

describe("handwriting transcription", () => {
  it("is open to anyone, but only volunteers at the mid-century floor count toward agreement", async () => {
    const [none, low, few] = [await volunteer("t-none"), await volunteer("t-low"), await volunteer("t-few")];
    await giveGold(low.id, 18, 2);
    await giveGold(few.id, 19);
    const target = `${P1}#l0`;
    let id = 0;
    for (const c of [none, low, few]) {
      const list = await call<{ batches: { id: string }[] }>(c, "GET", "/api/batches");
      expect(list.body.batches.map((b) => b.id)).toContain(H);
      id = await serveUntil(c, target);
      expect((await decide(c, id, "edit", "בדוי")).status).toBe(200);
    }
    // Three agreeing decisions, none counted: the line is still open for two counted ones.
    expect(await lineState(id)).toEqual({ state: "open", needed: 2 });
    const [a, b] = [await counting("t-ok1"), await counting("t-ok2")];
    await decide(a, await serveUntil(a, target), "edit", "בדוי");
    await decide(b, await serveUntil(b, target), "edit", "בדוי");
    expect(await lineState(id)).toEqual({ state: "agreed", needed: 0 });
    const m = new Client();
    admins = await m.signIn("t-adm");
    await m.acceptTerms();
    const exp = await call<{ files: Record<string, { decisions: { reviewer: string; counted: boolean; not_counted_reason: string | null }[] }> }>(m, "GET", `/api/admin/batches/${H}/export`);
    const ds = exp.body.files["h_line_transcriptions.json"]!.decisions;
    expect(ds.find((d) => d.reviewer === low.id)).toMatchObject({ counted: false, not_counted_reason: "below_floor" });
    expect(ds.find((d) => d.reviewer === few.id)).toMatchObject({ counted: false, not_counted_reason: "fewer_than_20_gold" });
    expect(ds.filter((d) => d.counted)).toHaveLength(2);
  });

  it("shows no text of any kind, and serves other-script lines only for the languages the volunteer reads", async () => {
    const a = await counting("t-lang");
    const n = await next(a);
    expect(n.view).toMatchObject({ kind: "line_transcribe", spanMarker: "[?]" });
    expect(JSON.stringify(n.proposal)).not.toMatch(/"(prefill|text|candidate|draft)"/);
    expect(n.proposal!.options.map((o) => o.value)).toEqual(["edit", "print_has_niqqud", "unreadable", "not_on_page"]);
    await call(a, "POST", `/api/proposals/${n.proposal!.id}/skip`);
    const plain = [n.proposal!.externalId, ...(await servedAll(a))];
    expect(plain.sort()).toEqual([`${P1}#l0`, `${P1}#l1`, `${SEEN}#l0`]);
    await call(a, "POST", `/api/batches/${H}/skips/clear`);
    expect((await servedAll(a, "jrb")).sort()).toEqual([`${P1}#l0`, `${P1}#l1`, `${SEEN}#l0`, `${JRB}#l0`]);
    await call(a, "POST", `/api/batches/${H}/skips/clear`);
    const both = await servedAll(a, "jrb,lad");
    expect(both).toContain(`${LAD}#l0`);
    const j = await next(await counting("t-lang2"), "jrb");
    expect(j.proposal).not.toBeNull();
    expect((await call(a, "GET", `/api/batches/${H}/next?languages=Judeo-Arabic`)).status).toBe(400);
  });

  it("refuses an untyped line: no `correct`, no empty text, not only illegible spans", async () => {
    const a = await counting("t-val");
    const id = (await next(a)).proposal!.id;
    expect((await decide(a, id, "correct")).status).toBe(400);
    expect((await decide(a, id, "edit", "   ")).status).toBe(400);
    expect((await decide(a, id, "edit", "[?] [?]")).status).toBe(400);
    expect((await decide(a, id, "print_has_niqqud", "שָׁלוֹם")).status).toBe(400);
    expect((await decide(a, id, "edit", "שורה [?] בדויה")).status).toBe(200);
    expect((await decide(a, id, "edit", "אחרת")).status).toBe(409);
  });

  it("two agreeing transcriptions admit a line; a disagreement goes to a blind third, then to the maintainer", async () => {
    const [a, b, c, d] = [await counting("t-a"), await counting("t-b"), await counting("t-c"), await counting("t-d")];
    const agreed = `${P1}#l0`;
    const id0 = await serveUntil(a, agreed);
    await decide(a, id0, "edit", "שורה  בדויה");
    await decide(b, await serveUntil(b, agreed), "edit", "שורה בדויה");
    expect(await lineState(id0)).toEqual({ state: "agreed", needed: 0 });

    const split = `${P1}#l1`;
    const id1 = await serveUntil(a, split);
    await decide(a, id1, "edit", "מילה אחת");
    await decide(b, await serveUntil(b, split), "edit", "מילה אחרת");
    expect(await lineState(id1)).toEqual({ state: "open", needed: 1 });
    const third = await next(c);
    // The third transcriber is blind: no one's text reaches them.
    expect(JSON.stringify(third)).not.toMatch(/מילה/);
    await decide(c, await serveUntil(c, split), "unreadable");
    expect(await lineState(id1)).toEqual({ state: "to_maintainer", needed: 0 });
    // The tie-break is the maintainer's alone.
    for (let k = 0; k < 6; k++) {
      const n = await next(d);
      if (!n.proposal) break;
      expect(n.proposal.externalId).not.toBe(split);
      await call(d, "POST", `/api/proposals/${n.proposal.id}/skip`);
    }
    const m = new Client();
    admins = await m.signIn("t-maintainer");
    await m.acceptTerms();
    const mn = await next(m);
    expect(mn.proposal!.externalId).toBe(split);
    expect(JSON.stringify(mn)).not.toMatch(/מילה/);
    await decide(m, mn.proposal!.id, "edit", "מילה אחת");
    expect(await lineState(id1)).toEqual({ state: "maintainer", needed: 0 });

    const exp = await call<{ problems: string[]; files: Record<string, Record<string, unknown>> }>(m, "GET", `/api/admin/batches/${H}/export`);
    expect(exp.status).toBe(200);
    expect(exp.body.problems).toEqual([]);
    const file = exp.body.files["h_line_transcriptions.json"] as {
      schema_version: string;
      rule: { gate_batch: string; span_marker: string };
      strata: Record<string, Record<string, number>>;
      lines: { page_key: string; i: number; stratum: string; outcome: string; reference: unknown }[];
      decisions: { page_key: string; i: number; role: string; counted: boolean }[];
      reviewers: { reviewer: string; standing: string }[];
    };
    expect(file.schema_version).toBe("h_line_transcriptions.v0");
    expect(file.rule).toMatchObject({ gate_batch: GATE, span_marker: "[?]" });
    expect(file.strata.primary).toEqual({ agreed: 1, maintainer: 1 });
    expect(file.strata.seen_writer).toEqual({ pending: 1 });
    expect(file.lines.find((l) => l.i === 0 && l.page_key === P1)).toMatchObject({ stratum: "primary", outcome: "agreed", reference: { action: "edit", text: "שורה  בדויה" } });
    expect(file.decisions.filter((x) => x.page_key === P1 && x.i === 1).map((x) => x.role)).toEqual(["first", "second", "third", "maintainer"]);
    expect(file.reviewers.every((r) => r.standing === "counting")).toBe(true);
  });

  it("a volunteer excluded in the mid-century batch stops counting here too, and counts again when included", async () => {
    const [a, b] = [await counting("t-xa"), await counting("t-xb")];
    const target = `${P1}#l0`;
    const id = await serveUntil(a, target);
    await decide(a, id, "edit", "בדוי");
    await decide(b, await serveUntil(b, target), "edit", "בדוי");
    expect(await lineState(id)).toEqual({ state: "agreed", needed: 0 });
    const m = new Client();
    admins = await m.signIn("t-admin");
    await m.acceptTerms();
    expect((await call(m, "PUT", `/api/admin/batches/${GATE}/reviewers/${b.id}/exclusion`, { excluded: true })).status).toBe(200);
    expect(await lineState(id)).toEqual({ state: "open", needed: 1 });
    await call(m, "PUT", `/api/admin/batches/${GATE}/reviewers/${b.id}/exclusion`, { excluded: false });
    expect(await lineState(id)).toEqual({ state: "agreed", needed: 0 });
    // Excluded in this batch only: the same.
    await call(m, "PUT", `/api/admin/batches/${H}/reviewers/${a.id}/exclusion`, { excluded: true });
    expect(await lineState(id)).toEqual({ state: "open", needed: 1 });
  });
});
