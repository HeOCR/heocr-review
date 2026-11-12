import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BatchSummary, LineVerifyView, NextResponse, ProposalView } from "../../src/shared/api";
import { decisionsFileProblems } from "../../src/tasks/line_verify/schema";
import { handle } from "../../src/worker/index";
import { BATCH, Client } from "./helpers";

const LINES = "fixture_line_verify_v1";
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function nextLine(c: Client): Promise<NextResponse & { view: LineVerifyView | null }> {
  const res = await c.get<NextResponse>(`/api/batches/${LINES}/next`);
  expect(res.status).toBe(200);
  const view = res.body.proposal?.view ?? null;
  if (view && view.kind !== "line_verify") throw new Error(`expected a line view, got ${view.kind}`);
  return { ...res.body, view };
}

async function reviewer(name: string): Promise<Client> {
  const c = new Client();
  await c.signIn(name);
  await c.acceptTerms();
  return c;
}

describe("line verification", () => {
  it("lists every task type for the picker, with their labels", async () => {
    const c = await reviewer("picker");
    const res = await c.get<{ batches: BatchSummary[] }>("/api/batches");
    expect(res.body.batches.map((b) => [b.id, b.taskType])).toEqual([
      [BATCH, "reference_audit"],
      [LINES, "line_verify"],
      ["newprinted_midcentury_v0", "page_review"],
    ]);
    const lines = res.body.batches[1]!;
    expect(lines.taskLabel).toEqual({ he: "אימות שורות מול הסריקה", en: "Line verification" });
    expect(lines.progress).toMatchObject({ total: 11, remainingForMe: 11, covered: 0 });
  });

  it("serves the hardest line first, with its crop, attention runs, attribution and licence", async () => {
    const c = await reviewer("lena");
    const n = await nextLine(c);
    const p = n.proposal!;
    expect(p.externalId).toBe("wikisource_he_proofread:fixture_lines__p0001#L002"); // bundle rank 0
    const v = n.view!;
    expect(v.candidate).toBe("הילד הלך אל בית הספר בבוקר השכם.");
    expect(v.runs.filter((r) => r.attention).map((r) => r.text)).toEqual(["בבוקר"]);
    expect(v.runs.map((r) => r.text).join("")).toBe(v.candidate);
    expect(v.lineIndex).toBe(2);
    expect(v.source.id).toBe("wikisource_he_proofread");
    expect(v.provenance.id).toBe("wikisource_quality3_single_proofreader");
    expect(v.textLicense).toContain("CC BY-SA 4.0");
    expect(v.attribution).toContain("Synthetic");
    expect(v.crop!.url).toMatch(/^\/media\//);
    expect(v.crop!.box).not.toBeNull();
    expect(v.page!.box).not.toBeNull();
    expect(p.options.map((o) => o.value)).toEqual(["exact", "edited", "unreadable", "misaligned", "pointed_print"]);
    // The next lines' crops only: the full page is fetched when the reviewer asks for it.
    expect(n.prefetch.length).toBeGreaterThan(0);
    expect(n.prefetch.some((u) => u.endsWith("/page.jpg"))).toBe(false);
  });

  it("walks the queue in the bundle's rank order and counts progress", async () => {
    const c = await reviewer("rank");
    const seen: string[] = [];
    for (;;) {
      const n = await nextLine(c);
      if (!n.proposal) break;
      seen.push(n.proposal.externalId.replace(/^.*:/, ""));
      expect((await c.post(`/api/proposals/${n.proposal.id}/decision`, { value: "exact" })).status).toBe(200);
    }
    expect(seen).toEqual([
      "fixture_lines__p0001#L002",
      "fixture_lines__p0001#L004",
      "fixture_lines__p0001#L003",
      "fixture_lines__p0001#L005",
      "fixture_lines__p0001#L007",
      "fixture_pby_42__p0003#L002", // rank 5, tie broken by item_id
      "fixture_pby_42__p0003#L004", // rank 5
      "fixture_lines__p0001#L001",
      "fixture_lines__p0001#L006",
      "fixture_pby_42__p0003#L001",
      "fixture_pby_42__p0003#L003",
    ]);
    const n = await nextLine(c);
    expect(n.progress).toMatchObject({ total: 11, covered: 11, decidedByMe: 11, remainingForMe: 0 });
  });

  it("validates decisions on the server", async () => {
    const c = await reviewer("val");
    const { proposal, view } = await nextLine(c);
    const url = `/api/proposals/${proposal!.id}/decision`;
    for (const bad of [
      { value: "accepted" },
      { value: "exact", text: "x" },
      { value: "unreadable", text: "" },
      { value: "edited" },
      { value: "edited", text: "   " },
      { value: "edited", text: "שורה\nשנייה" },
      { value: "edited", text: "א\u0007" },
      { value: "edited", text: "א".repeat(1001) },
      { value: "pointed_print", text: "שָׁלוֹם" },
      { value: "pointed_print", text: "  " },
    ]) {
      const res = await c.post(url, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error).toBe("invalid_decision");
    }
    // An edit is stored as NFC without edge whitespace; one equal to the candidate is exact.
    const same = await c.post<{ value: string; text: string | null }>(url, { value: "edited", text: ` ${view!.candidate} ` });
    expect(same.body).toMatchObject({ value: "exact", text: null });
    const unordered = "שָׁלום";
    const own = await c.post<{ value: string; text: string | null }>(url, { value: "edited", text: `${unordered} ` });
    expect(own.body).toMatchObject({ value: "edited", text: unordered.normalize("NFC") });
    for (const value of ["unreadable", "misaligned", "pointed_print"]) {
      expect((await c.post<{ value: string }>(url, { value })).body.value).toBe(value);
    }
    // pointed_print with the letters corrected keeps them; unchanged letters are stored without text.
    const fixed = await c.post<{ value: string; text: string | null }>(url, { value: "pointed_print", text: "שורה מתוקנת " });
    expect(fixed.body).toMatchObject({ value: "pointed_print", text: "שורה מתוקנת" });
    const unchanged = await c.post<{ value: string; text: string | null }>(url, { value: "pointed_print", text: view!.candidate });
    expect(unchanged.body).toMatchObject({ value: "pointed_print", text: null });
  });

  it("lets a reviewer go back and change the last decision (the new one supersedes it)", async () => {
    const c = await reviewer("undo");
    const first = (await nextLine(c)).proposal!;
    await c.post(`/api/proposals/${first.id}/decision`, { value: "misaligned" });
    expect((await nextLine(c)).proposal!.id).not.toBe(first.id);
    const back = await c.get<{ proposal: ProposalView }>(`/api/proposals/${first.id}`);
    expect(back.body.proposal.mine).toMatchObject({ value: "misaligned", text: null });
    await c.post(`/api/proposals/${first.id}/decision`, { value: "exact" });
    const rows = await env.DB.prepare("SELECT value, superseded_at FROM decisions WHERE proposal_id = ?1 ORDER BY created_at").bind(first.id).all();
    expect(rows.results.map((r) => [r.value, r.superseded_at === null])).toEqual([
      ["misaligned", false],
      ["exact", true],
    ]);
  });

  it("skips a line and brings it back on request", async () => {
    const c = await reviewer("skipper");
    const first = (await nextLine(c)).proposal!;
    expect((await c.post(`/api/proposals/${first.id}/skip`)).status).toBe(200);
    expect((await nextLine(c)).proposal!.id).not.toBe(first.id);
    await c.post(`/api/batches/${LINES}/skips/clear`);
    expect((await nextLine(c)).proposal!.id).toBe(first.id);
  });

  it("exports line_verify_decisions.v1.1 for the admin, validated against the items", async () => {
    const admin = new Client();
    const adminId = await admin.signIn("maintainer");
    const e = { ...env, ADMIN_REVIEWER_IDS: adminId };
    const a = await reviewer("lv-a");
    const b = await reviewer("lv-b");
    const rows = (await env.DB.prepare("SELECT id, external_id, payload_json FROM proposals WHERE batch_id = ?1 ORDER BY rank").bind(LINES).all<{
      id: number;
      external_id: string;
      payload_json: string;
    }>()).results;
    await a.post(`/api/proposals/${rows[0]!.id}/decision`, { value: "edited", text: "הילד הלך אל בית הספר בבקר השכם." });
    await b.post(`/api/proposals/${rows[0]!.id}/decision`, { value: "edited", text: "הילד הלך אל בית הספר בבקר השכם." });
    await a.post(`/api/proposals/${rows[1]!.id}/decision`, { value: "unreadable" });
    await a.post(`/api/proposals/${rows[3]!.id}/decision`, { value: "misaligned" });
    await b.post(`/api/proposals/${rows[3]!.id}/decision`, { value: "exact" }); // conflict
    await a.post(`/api/proposals/${rows[4]!.id}/decision`, { value: "pointed_print", text: "אותיות מתוקנות" });
    const res = await handle(new Request(`http://localhost/api/admin/batches/${LINES}/export`, { headers: { cookie: admin.cookie } }), e, exec);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { problems: string[]; counts: Record<string, number>; files: Record<string, Record<string, unknown>> };
    expect(body.problems).toEqual([]);
    const file = body.files["line_verify_decisions.json"]!;
    expect(Object.keys(file)).toEqual(["schema_version", "batch_id", "decisions"]);
    expect(file.batch_id).toBe(LINES);
    const decisions = file.decisions as Record<string, unknown>[];
    expect(decisions).toHaveLength(6);
    expect(file.schema_version).toBe("line_verify_decisions.v1.1");
    expect(decisions.find((d) => d.decision === "pointed_print")).toMatchObject({ text: "אותיות מתוקנות" });
    expect(decisions.filter((d) => d.decision === "edited").map((d) => d.text)).toEqual(["הילד הלך אל בית הספר בבקר השכם.", "הילד הלך אל בית הספר בבקר השכם."]);
    for (const d of decisions) {
      expect(d.checked_by).toBe("human");
      expect(d.decided_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (d.decision !== "edited" && d.decision !== "pointed_print") expect("text" in d).toBe(false);
    }
    const items = rows.map((r) => ({ item_id: r.external_id, candidate_text: (JSON.parse(r.payload_json) as { candidate_text: string }).candidate_text }));
    expect(decisionsFileProblems(file, LINES, items)).toEqual([]);
    expect(body.counts).toMatchObject({ proposals: 11, decisions_exported: 6, conflict: 1, undecided: 7, reviewers: 2 });
    expect(body.files["line_verify_decisions_ledger.json"]).toMatchObject({ task_type: "line_verify", batch_id: LINES });
  });
});
