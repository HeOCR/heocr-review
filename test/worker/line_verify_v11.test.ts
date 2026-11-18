import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { LineVerifyView, NextResponse, ProposalView } from "../../src/shared/api";
import { decisionsFileProblems } from "../../src/tasks/line_verify/schema";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

// The line_verify_items.v1.1 fixture (test/fixtures/line_verify_v11): pre-check flags on the two hardest lines, and a
// blind second pass for the hardest line (L002) and one Sefaria line.
const V11 = "fixture_line_verify_v11";
const HARDEST = "wikisource_he_proofread:fixture_lines__p0001#L002";
const SEFARIA = "benyehuda_nli_aligned:fixture_pby_42__p0003#L001";
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const DAY_AGO = () => new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

beforeEach(async () => {
  await env.DB.batch(env.TEST_LINE_VERIFY_V11_SQL.map((s) => env.DB.prepare(s)));
});

async function reviewer(name: string): Promise<Client> {
  const c = new Client();
  await c.signIn(name);
  await c.acceptTerms();
  return c;
}

async function next(c: Client): Promise<{ proposal: ProposalView | null; view: LineVerifyView | null }> {
  const res = await c.get<NextResponse>(`/api/batches/${V11}/next`);
  expect(res.status).toBe(200);
  const view = res.body.proposal?.view ?? null;
  if (view && view.kind !== "line_verify") throw new Error(`expected a line view, got ${view.kind}`);
  return { proposal: res.body.proposal, view };
}

async function idOf(externalId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM proposals WHERE batch_id = ?1 AND external_id = ?2").bind(V11, externalId).first<{ id: number }>();
  return row!.id;
}

/** Decide every pass-1 line (the pass-2 lines are not open yet); `value` per line, exact by default. */
async function decideAllPass1(c: Client, value: (externalId: string) => string = () => "exact"): Promise<string[]> {
  const seen: string[] = [];
  for (;;) {
    const { proposal } = await next(c);
    if (!proposal) return seen;
    expect(proposal.externalId).not.toContain("@pass2");
    seen.push(proposal.externalId);
    expect((await c.post(`/api/proposals/${proposal.id}/decision`, { value: value(proposal.externalId) })).status).toBe(200);
  }
}

const age = (externalId: string, at: string) =>
  idOf(externalId).then((id) => env.DB.prepare("UPDATE decisions SET created_at = ?1 WHERE proposal_id = ?2").bind(at, id).run());

describe("line verification v1.1", () => {
  it("shows the page's script and the pre-check's reasons on pass 1, never a proposed text", async () => {
    const c = await reviewer("v11-view");
    const { proposal, view } = await next(c);
    expect(proposal!.externalId).toBe(HARDEST);
    expect(view!.script).toEqual({ id: "square", label: { he: "אותיות מרובעות", en: "Square script" } });
    expect(view!.precheck).toEqual({ reasons: [{ id: "spelling", label: { he: "כתיב", en: "spelling" } }] });
    expect(view!.source.id).toBe("wikisource_he");
    expect(view!.provenance.label.en).toBe("Proofread and validated on Wikisource");
    expect(view!.runs.some((r) => r.attention)).toBe(true);
    expect(JSON.stringify(view!.precheck)).not.toContain(view!.candidate.slice(0, 4));
    // A line whose pre-check found nothing has no flag.
    await c.post(`/api/proposals/${proposal!.id}/decision`, { value: "exact" });
    await c.post(`/api/proposals/${(await next(c)).proposal!.id}/decision`, { value: "exact" });
    expect((await next(c)).view!.precheck).toBeNull();
  });

  it("opens the blind second pass only to the same reviewer, 24 hours after their answer, unaided, and closes pass 1 meanwhile", async () => {
    const a = await reviewer("v11-a");
    const pass2 = await idOf(`${HARDEST}@pass2`);
    expect((await a.get(`/api/proposals/${pass2}`)).status).toBe(409);
    const seen = await decideAllPass1(a);
    expect(seen).toHaveLength(11);
    // Decided just now: pass 2 is not open yet.
    expect((await next(a)).proposal).toBeNull();
    await age(HARDEST, DAY_AGO());
    const blind = await next(a);
    expect(blind.proposal!.externalId).toBe(`${HARDEST}@pass2`);
    expect(blind.proposal!.mine).toBeNull();
    expect(blind.view!.precheck).toBeNull();
    expect(blind.view!.runs.some((r) => r.attention)).toBe(false);
    // While pass 2 is open and undecided, pass 1 is closed to this reviewer.
    const pass1 = await idOf(HARDEST);
    expect((await a.get(`/api/proposals/${pass1}`)).status).toBe(409);
    expect((await a.post(`/api/proposals/${pass1}/decision`, { value: "misaligned" })).status).toBe(409);
    // Another reviewer who has not answered the line never gets this reviewer's pass 2.
    const b = await reviewer("v11-b");
    expect((await b.get(`/api/proposals/${pass2}`)).status).toBe(409);
    expect((await a.post(`/api/proposals/${pass2}/decision`, { value: "exact" })).status).toBe(200);
    expect((await a.get(`/api/proposals/${pass1}`)).status).toBe(200);
    // The other blind line was answered just now: still closed; nothing else is left.
    expect((await next(a)).proposal).toBeNull();
  });

  it("gives no pass 2 for a line marked unreadable or misaligned", async () => {
    const c = await reviewer("v11-unreadable");
    await decideAllPass1(c, (id) => (id === HARDEST ? "unreadable" : id === SEFARIA ? "misaligned" : "exact"));
    await age(HARDEST, DAY_AGO());
    await age(SEFARIA, DAY_AGO());
    expect((await next(c)).proposal).toBeNull();
    expect((await c.get(`/api/proposals/${await idOf(`${HARDEST}@pass2`)}`)).status).toBe(409);
  });

  it("exports line_verify_decisions.v1.2 with each pass, and the pass-1 answer that stood when pass 1 was revised after pass 2", async () => {
    const admin = new Client();
    const adminId = await admin.signIn("maintainer");
    const e = { ...env, ADMIN_REVIEWER_IDS: adminId };
    const a = await reviewer("v11-export");
    await decideAllPass1(a);
    await age(HARDEST, DAY_AGO());
    const pass2 = (await next(a)).proposal!;
    await a.post(`/api/proposals/${pass2.id}/decision`, { value: "edited", text: "שורה אחרת לגמרי" });
    // Pass 2 an hour ago, then pass 1 changed.
    await age(`${HARDEST}@pass2`, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    await a.post(`/api/proposals/${await idOf(HARDEST)}/decision`, { value: "edited", text: "שורה אחרת לגמרי" });

    const res = await handle(new Request(`http://localhost/api/admin/batches/${V11}/export`, { headers: { cookie: admin.cookie } }), e, exec);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { problems: string[]; files: Record<string, Record<string, unknown>> };
    expect(body.problems).toEqual([]);
    const file = body.files["line_verify_decisions.json"]!;
    expect(file.schema_version).toBe("line_verify_decisions.v1.2");
    const decisions = file.decisions as Record<string, unknown>[];
    expect(decisions).toHaveLength(12);
    expect(decisions.every((d) => d.pass === 1 || d.pass === 2)).toBe(true);
    const mine = decisions.filter((d) => d.item_id === HARDEST);
    expect(mine.map((d) => [d.pass, d.decision])).toEqual([
      [1, "edited"],
      [2, "edited"],
    ]);
    expect(mine[1]!.decision_id).toBe(`decision:${HARDEST}@pass2:${String(mine[1]!.reviewer)}`);
    expect(mine[0]).toMatchObject({ revised_after_pass2: true, pass1_at_pass2: { decision: "exact" } });
    // A blind line whose pass 2 was not decided carries no revision mark; a line without a blind pass never does.
    expect(decisions.find((d) => d.item_id === SEFARIA)).not.toHaveProperty("revised_after_pass2");
    expect(decisions.filter((d) => "revised_after_pass2" in d)).toHaveLength(1);

    const rows = (await env.DB.prepare("SELECT external_id, payload_json FROM proposals WHERE batch_id = ?1").bind(V11).all<{ external_id: string; payload_json: string }>()).results;
    const items = rows
      .filter((r) => !r.external_id.endsWith("@pass2"))
      .map((r) => {
        const x = JSON.parse(r.payload_json) as { candidate_text: string; blind: boolean };
        return { item_id: r.external_id, candidate_text: x.candidate_text, blind: x.blind };
      });
    expect(decisionsFileProblems(file, V11, items)).toEqual([]);
    // Without the blind flag, a pass-2 decision is refused.
    expect(decisionsFileProblems(file, V11, items.map((i) => ({ ...i, blind: false }))).join("\n")).toContain("has no blind second pass");
  });
});
