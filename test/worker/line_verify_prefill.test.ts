import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { LineVerifyView, NextResponse, ProposalView } from "../../src/shared/api";
import { sha256Hex } from "../../src/shared/sha256";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

// Pre-fill amendment 1 on the v1.2 fixture (test/fixtures/line_verify_v12): one typed line, which also has a blind
// pass, gets a model's draft the way scripts/prefill-swap.ts writes it (payload candidate_text and provenance).
const V12 = "fixture_line_verify_v12";
const DRAFTED = "benyehuda_nli_aligned:fixture_pby_42__p0003#L001";
const DRAFT = "שורה מן הטיוטה";
const PROVENANCE = `llm:claude-opus-5-5:${"c".repeat(64)}`;
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

beforeEach(async () => {
  await env.DB.batch(env.TEST_LINE_VERIFY_V12_SQL.map((s) => env.DB.prepare(s)));
  await env.DB.prepare("UPDATE proposals SET payload_json = json_set(payload_json, '$.candidate_text', ?1, '$.candidate_provenance', ?2) WHERE batch_id = ?3 AND external_id = ?4")
    .bind(DRAFT, PROVENANCE, V12, DRAFTED)
    .run();
});

async function next(c: Client): Promise<{ proposal: ProposalView | null; view: LineVerifyView | null }> {
  const res = await c.get<NextResponse>(`/api/batches/${V12}/next`);
  const view = res.body.proposal?.view ?? null;
  if (view && view.kind !== "line_verify") throw new Error(`expected a line view, got ${view.kind}`);
  return { proposal: res.body.proposal, view };
}

async function exportFile(): Promise<{ problems: string[]; decisions: Record<string, unknown>[] }> {
  const admin = new Client();
  const adminId = await admin.signIn("maintainer");
  const res = await handle(new Request(`http://localhost/api/admin/batches/${V12}/export`, { headers: { cookie: admin.cookie } }), { ...env, ADMIN_REVIEWER_IDS: adminId }, exec);
  const body = (await res.json()) as { problems: string[]; files: Record<string, { decisions: Record<string, unknown>[] }> };
  return { problems: body.problems, decisions: body.files["line_verify_decisions.json"]!.decisions };
}

describe("line verification: a typed line's draft (pre-fill amendment 1)", () => {
  it("starts the drafted line's typing box with the draft, other typed lines blank, and exports which draft was shown", async () => {
    const c = new Client();
    await c.signIn("prefill");
    await c.acceptTerms();
    const typed: string[] = [];
    for (;;) {
      const { proposal, view } = await next(c);
      if (!proposal) break;
      let body: Record<string, unknown> = { value: "exact" };
      if (view!.lineKind === "type") {
        typed.push(proposal.externalId);
        if (proposal.externalId === DRAFTED) {
          expect(view).toMatchObject({ mode: "type", pass: 1, draft: true, candidate: DRAFT, runs: [], precheck: null });
          expect(view!.provenance.label.en).toBe("Claude's draft");
          body = { value: "typed", text: "שורה מתוקנת" };
        } else {
          expect(view).toMatchObject({ mode: "type", draft: false, candidate: "" });
          body = { value: "typed", text: "שורה" };
        }
      }
      expect((await c.post(`/api/proposals/${proposal.id}/decision`, body)).status, proposal.externalId).toBe(200);
    }
    expect(typed).toContain(DRAFTED);
    // The blind pass of the drafted line is typed from a blank box, as always.
    await env.DB.prepare("UPDATE decisions SET created_at = ?1").bind(new Date(Date.now() - 25 * 3600 * 1000).toISOString()).run();
    const blinds: string[] = [];
    for (let blind = await next(c); blind.proposal; blind = await next(c)) {
      blinds.push(blind.proposal.externalId);
      expect(blind.view).toMatchObject({ mode: "type", pass: 2, draft: false });
      if (blind.proposal.externalId === `${DRAFTED}@pass2`) expect(blind.view!.candidate).toBe("");
      expect((await c.post(`/api/proposals/${blind.proposal.id}/decision`, { value: "typed", text: "שורה" })).status).toBe(200);
    }
    expect(blinds).toContain(`${DRAFTED}@pass2`);

    const { problems, decisions } = await exportFile();
    expect(problems).toEqual([]);
    const mine = decisions.filter((d) => d.item_id === DRAFTED);
    expect(mine.find((d) => d.pass === 1)).toMatchObject({ decision: "typed", text: "שורה מתוקנת", candidate_sha256: sha256Hex(DRAFT), prefill_provenance: PROVENANCE });
    const pass2 = mine.find((d) => d.pass === 2)!;
    expect("candidate_sha256" in pass2 || "prefill_provenance" in pass2).toBe(false);
    for (const d of decisions.filter((x) => x.kind === "type" && x.item_id !== DRAFTED)) expect("prefill_provenance" in d || "candidate_sha256" in d).toBe(false);
  });
});
