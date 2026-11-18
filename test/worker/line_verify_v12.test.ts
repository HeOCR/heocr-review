import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { LineVerifyView, NextResponse, ProposalView } from "../../src/shared/api";
import { decisionsFileProblems } from "../../src/tasks/line_verify/schema";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

// The line_verify_items.v1.2 fixture (test/fixtures/line_verify_v12): page p0001 is hybrid (5 verify lines, 2 typed,
// book group "later"), page p0003 fully typed (4 lines, "early"); blind pass on one verify and one typed line.
const V12 = "fixture_line_verify_v12";
const TYPED_BLIND = "benyehuda_nli_aligned:fixture_pby_42__p0003#L001";
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const DAY_AGO = () => new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

beforeEach(async () => {
  await env.DB.batch(env.TEST_LINE_VERIFY_V12_SQL.map((s) => env.DB.prepare(s)));
});

async function reviewer(name: string): Promise<Client> {
  const c = new Client();
  await c.signIn(name);
  await c.acceptTerms();
  return c;
}

async function next(c: Client): Promise<{ proposal: ProposalView | null; view: LineVerifyView | null; res: NextResponse }> {
  const res = await c.get<NextResponse>(`/api/batches/${V12}/next`);
  expect(res.status).toBe(200);
  const view = res.body.proposal?.view ?? null;
  if (view && view.kind !== "line_verify") throw new Error(`expected a line view, got ${view.kind}`);
  return { proposal: res.body.proposal, view, res: res.body };
}

const idOf = async (externalId: string) =>
  (await env.DB.prepare("SELECT id FROM proposals WHERE batch_id = ?1 AND external_id = ?2").bind(V12, externalId).first<{ id: number }>())!.id;

const age = async (externalId: string, at: string) =>
  env.DB.prepare("UPDATE decisions SET created_at = ?1 WHERE proposal_id = ?2").bind(at, await idOf(externalId)).run();

/** Decide every open line: exact on a verify line, a typed text on a typed line (or `typed(id)`'s answer). */
async function decideAll(c: Client, typed: (id: string) => Record<string, unknown> = () => ({ value: "typed", text: "שורה מוקלדת" })): Promise<string[]> {
  const seen: string[] = [];
  for (;;) {
    const { proposal, view } = await next(c);
    if (!proposal) return seen;
    seen.push(proposal.externalId);
    const body = view!.lineKind === "type" ? typed(proposal.externalId) : { value: "exact" };
    expect((await c.post(`/api/proposals/${proposal.id}/decision`, body)).status, proposal.externalId).toBe(200);
  }
}

async function exportFile(): Promise<{ problems: string[]; file: Record<string, unknown> & { decisions: Record<string, unknown>[] } }> {
  const admin = new Client();
  const adminId = await admin.signIn("maintainer");
  const res = await handle(new Request(`http://localhost/api/admin/batches/${V12}/export`, { headers: { cookie: admin.cookie } }), { ...env, ADMIN_REVIEWER_IDS: adminId }, exec);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { problems: string[]; files: Record<string, Record<string, unknown> & { decisions: Record<string, unknown>[] }> };
  return { problems: body.problems, file: body.files["line_verify_decisions.json"]! };
}

describe("line verification v1.2: typed lines", () => {
  it("serves a typed line as a blank box with H's box problems, and lets pass 1 be changed", async () => {
    const c = await reviewer("v12-type");
    let n = await next(c);
    while (n.view!.lineKind !== "type") {
      expect(n.view!.mode).toBe("verify");
      await c.post(`/api/proposals/${n.proposal!.id}/decision`, { value: "exact" });
      n = await next(c);
    }
    const { proposal, view } = n;
    expect(view).toMatchObject({ mode: "type", pass: 1, lineKind: "type", candidate: "", runs: [], precheck: null });
    expect(proposal!.options.map((o) => o.value)).toEqual(["typed", "pointed_print", "unreadable", "not_one_line", "no_text", "continued"]);
    const url = `/api/proposals/${proposal!.id}/decision`;
    for (const bad of [{ value: "exact" }, { value: "edited", text: "x" }, { value: "misaligned" }, { value: "typed" }, { value: "typed", text: "שָׁלוֹם" }, { value: "no_text", text: "x" }]) {
      expect((await c.post(url, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    for (const value of ["not_one_line", "no_text", "continued", "unreadable"]) expect((await c.post<{ value: string }>(url, { value })).body.value).toBe(value);
    // Pass 1 of a typed line is not final: a new answer replaces the last.
    expect((await c.post<{ value: string; text: string }>(url, { value: "typed", text: " שורה " })).body).toMatchObject({ value: "typed", text: "שורה" });
    expect((await c.get<{ proposal: ProposalView }>(`/api/proposals/${proposal!.id}`)).body.proposal.mine).toMatchObject({ value: "typed", text: "שורה" });
  });

  it("gives a typed line's blind pass as a second typing, 24 hours after a typed answer, final", async () => {
    const c = await reviewer("v12-blind");
    expect(await decideAll(c)).toHaveLength(11);
    await age(TYPED_BLIND, DAY_AGO());
    const blind = await next(c);
    expect(blind.proposal!.externalId).toBe(`${TYPED_BLIND}@pass2`);
    expect(blind.view).toMatchObject({ mode: "type", pass: 2, lineKind: "type", candidate: "" });
    const url = `/api/proposals/${blind.proposal!.id}/decision`;
    expect((await c.post(url, { value: "typed", text: "שורה אחרת" })).status).toBe(200);
    expect((await c.post(url, { value: "typed", text: "שורה שלישית" })).status).toBe(409);
  });

  it("gives no pass 2 for a typed line whose pass 1 was a box problem", async () => {
    const c = await reviewer("v12-box");
    await decideAll(c, (id) => (id === TYPED_BLIND ? { value: "continued" } : { value: "typed", text: "שורה" }));
    await age(TYPED_BLIND, DAY_AGO());
    expect((await next(c)).proposal).toBeNull();
  });

  it("with two typings switched on for a group, serves that group's typed lines to a second reviewer only", async () => {
    await env.DB.prepare(
      "INSERT INTO batch_settings (batch_id, updated_at, updated_by, two_typings_groups, two_typings_set_at) VALUES (?1, ?2, 'test', ?3, ?2)",
    )
      .bind(V12, "2026-11-18T10:00:00.000Z", JSON.stringify(["early"]))
      .run();
    const a = await reviewer("v12-first");
    expect(await decideAll(a)).toHaveLength(11);
    const b = await reviewer("v12-second");
    const second = await decideAll(b);
    // Only the early group's typed lines (page p0003, all typed) need a second typing; the later page's do not.
    expect(second.sort()).toEqual([0, 1, 2, 3].map((i) => `benyehuda_nli_aligned:fixture_pby_42__p0003#L00${i + 1}`));
    expect((await next(b)).res.progress).toMatchObject({ remainingForMe: 0 });
    const { problems, file } = await exportFile();
    expect(problems).toEqual([]);
    expect(file.two_typings).toEqual({ groups: ["early"], set_at: "2026-11-18T10:00:00.000Z" });
    expect(file.decisions.filter((d) => d.item_id === TYPED_BLIND && d.pass === 1)).toHaveLength(2);
  });

  it("exports line_verify_decisions.v1.3: kind on every decision, box_reason on not_on_page, and which pages are done", async () => {
    const c = await reviewer("v12-export");
    // Decide all but one typed line of the hybrid page, with a box problem on another.
    let skipped = "";
    for (;;) {
      const { proposal, view } = await next(c);
      if (!proposal) break;
      if (view!.lineKind === "type" && proposal.externalId.includes("p0001") && !skipped) {
        skipped = proposal.externalId;
        await c.post(`/api/proposals/${proposal.id}/skip`);
        continue;
      }
      const body = view!.lineKind === "type" ? (proposal.externalId.endsWith("L002") ? { value: "no_text" } : { value: "typed", text: "שורה" }) : { value: "exact" };
      await c.post(`/api/proposals/${proposal.id}/decision`, body);
    }
    const { problems, file } = await exportFile();
    expect(problems).toEqual([]);
    expect(file.schema_version).toBe("line_verify_decisions.v1.3");
    expect(Object.keys(file)).toEqual(["schema_version", "batch_id", "pass2_reviewer", "blind_second_pass", "two_typings", "pages", "decisions"]);
    expect(file.two_typings).toEqual({ groups: [], set_at: null });
    expect(file.pages).toEqual([
      { page_id: "benyehuda_nli_aligned:fixture_pby_42__p0003", book_group: "early", kraken_lines: 4, resolved: 4, done: true, unreadable: 0 },
      { page_id: "wikisource_he_proofread:fixture_lines__p0001", book_group: "later", kraken_lines: 7, resolved: 6, done: false, unreadable: 0 },
    ]);
    for (const d of file.decisions) expect(["verify", "type"]).toContain(d.kind);
    const box = file.decisions.find((d) => d.item_id === "benyehuda_nli_aligned:fixture_pby_42__p0003#L002")!;
    expect(box).toMatchObject({ kind: "type", decision: "not_on_page", box_reason: "no_text", pass: 1 });
    expect(box).not.toHaveProperty("candidate_sha256");
    expect(file.decisions.find((d) => d.kind === "verify")).toHaveProperty("candidate_sha256");

    const rows = (await env.DB.prepare("SELECT external_id, payload_json FROM proposals WHERE batch_id = ?1").bind(V12).all<{ external_id: string; payload_json: string }>()).results;
    const items = rows
      .filter((r) => !r.external_id.endsWith("@pass2"))
      .map((r) => {
        const x = JSON.parse(r.payload_json) as { candidate_text: string; blind: boolean; kind: "verify" | "type" };
        return { item_id: r.external_id, candidate_text: x.candidate_text, blind: x.blind, kind: x.kind };
      });
    expect(decisionsFileProblems(file, V12, items)).toEqual([]);
    const bad = structuredClone(file);
    delete bad.decisions.find((d) => d.decision === "not_on_page")!.box_reason;
    bad.decisions.find((d) => d.kind === "verify")!.kind = "type";
    const out = decisionsFileProblems(bad, V12, items).join("\n");
    expect(out).toContain("box_reason");
    expect(out).toContain("kind must be the item's");
  });

  it("on a verify line, misaligned carries the line as typed, opens the blind pass, and exports with its text", async () => {
    const c = await reviewer("v12-misaligned");
    const first = (await next(c)).proposal!;
    expect(first.externalId).toBe("wikisource_he_proofread:fixture_lines__p0001#L002");
    expect(first.options.find((o) => o.value === "misaligned")).toMatchObject({ withText: true });
    const url = `/api/proposals/${first.id}/decision`;
    for (const bad of [{ value: "misaligned" }, { value: "misaligned", text: " " }, { value: "misaligned", text: "שָׁלוֹם" }]) {
      expect((await c.post(url, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await c.post<{ value: string; text: string }>(url, { value: "misaligned", text: " שורה אחרת " })).body).toMatchObject({ value: "misaligned", text: "שורה אחרת" });
    await decideAll(c, (id) => (id.endsWith("p0003#L002") ? { value: "unreadable" } : { value: "typed", text: "שורה" }));
    // A typed misaligned answer is a text answer: the line's blind pass opens 24 hours later.
    await age("wikisource_he_proofread:fixture_lines__p0001#L002", DAY_AGO());
    expect((await next(c)).proposal!.externalId).toBe("wikisource_he_proofread:fixture_lines__p0001#L002@pass2");
    const { problems, file } = await exportFile();
    expect(problems).toEqual([]);
    expect(file.decisions.find((d) => d.decision === "misaligned")).toMatchObject({ kind: "verify", pass: 1, text: "שורה אחרת" });
    // The unreadable line is resolved, and counted on its page.
    expect((file.pages as Record<string, unknown>[]).find((p) => String(p.page_id).endsWith("p0003"))).toMatchObject({ resolved: 4, done: true, unreadable: 1 });
  });
});
