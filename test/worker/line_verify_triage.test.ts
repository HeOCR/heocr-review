import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { LineVerifyView, NextResponse } from "../../src/shared/api";
import { sha256Hex } from "../../src/shared/sha256";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

// Triage mode (migrations/0012_triage.sql) on the v1.2 fixture (test/fixtures/line_verify_v12): 5 verify lines with a
// candidate (triage), 6 typed lines without one and the blind passes (the desktop fix queue).
const V12 = "fixture_line_verify_v12";
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function setMode(mode: "standard" | "triage") {
  await env.DB.prepare(
    `INSERT INTO batch_settings (batch_id, updated_at, updated_by, pointed_books, mode) VALUES (?1, '2026-11-20T00:00:00.000Z', 'test', 'keep', ?2)
     ON CONFLICT (batch_id) DO UPDATE SET pointed_books = 'keep', mode = excluded.mode`,
  )
    .bind(V12, mode)
    .run();
}

beforeEach(async () => {
  await env.DB.batch(env.TEST_LINE_VERIFY_V12_SQL.map((s) => env.DB.prepare(s)));
  await setMode("triage");
});

async function reviewer(name: string): Promise<Client> {
  const c = new Client();
  await c.signIn(name);
  await c.acceptTerms();
  return c;
}

async function next(c: Client, queue?: "triage" | "fix") {
  const res = await c.get<NextResponse>(`/api/batches/${V12}/next${queue ? `?queue=${queue}` : ""}`);
  expect(res.status).toBe(200);
  return { proposal: res.body.proposal, view: (res.body.proposal?.view ?? null) as LineVerifyView | null, body: res.body };
}

async function exportFiles(): Promise<{ problems: string[]; files: Record<string, Record<string, unknown>> }> {
  const admin = new Client();
  const adminId = await admin.signIn("maintainer");
  const res = await handle(new Request(`http://localhost/api/admin/batches/${V12}/export`, { headers: { cookie: admin.cookie } }), { ...env, ADMIN_REVIEWER_IDS: adminId }, exec);
  expect(res.status).toBe(200);
  return (await res.json()) as { problems: string[]; files: Record<string, Record<string, unknown>> };
}

describe("line verification: triage mode", () => {
  it("serves candidate lines to triage, the rest and every 'different' to the fix queue, and exports both records", async () => {
    const c = await reviewer("triage");
    const first = await next(c);
    expect(first.body.triage).toEqual({ queue: "triage", triage: 5, fix: 6 });
    // Triage the five candidate lines: different, niqqud, then correct.
    const answers = ["different", "niqqud_mismatch", "correct", "correct", "correct"];
    const seen: { id: number; ext: string; candidate: string }[] = [];
    for (const value of answers) {
      const { proposal, view } = await next(c, "triage");
      expect(view).toMatchObject({ lineKind: "verify", pass: 1 });
      expect(view!.candidate).not.toBe("");
      seen.push({ id: proposal!.id, ext: proposal!.externalId, candidate: view!.candidate });
      // Never with text.
      expect((await c.post(`/api/proposals/${proposal!.id}/decision`, { value, text: "x" })).status).toBe(400);
      expect((await c.post(`/api/proposals/${proposal!.id}/decision`, { value })).status, value).toBe(200);
    }
    const done = await next(c, "triage");
    expect(done.proposal).toBeNull();
    expect(done.body.page ?? null).toBeNull();
    expect(done.body.triage).toMatchObject({ triage: 0, fix: 7 });

    // The fix queue: the "different" line among the typed lines; a triage answer is refused on a line without one.
    const different = seen[0]!;
    let fixed = 0;
    for (;;) {
      const { proposal, view } = await next(c, "fix");
      if (!proposal) break;
      if (proposal.id === different.id) {
        expect(proposal.mine).toMatchObject({ value: "different" });
        expect(view!.candidate).toBe(different.candidate);
        expect((await c.post(`/api/proposals/${proposal.id}/decision`, { value: "edited", text: "שורה מתוקנת" })).status).toBe(200);
      } else {
        expect(view!.lineKind).toBe("type");
        expect((await c.post(`/api/proposals/${proposal.id}/decision`, { value: "correct" })).status).toBe(400);
        expect((await c.post(`/api/proposals/${proposal.id}/decision`, { value: "typed", text: "שורה" })).status).toBe(200);
      }
      fixed++;
    }
    expect(fixed).toBe(7);

    const { problems, files } = await exportFiles();
    expect(problems).toEqual([]);
    const decisions = files["line_verify_decisions.json"]!.decisions as Record<string, unknown>[];
    const byItem = (ext: string) => decisions.find((d) => d.item_id === ext && d.pass === 1)!;
    expect(byItem(seen[0]!.ext)).toMatchObject({ decision: "edited", text: "שורה מתוקנת" });
    expect(byItem(seen[1]!.ext).decision).toBe("pointed_print");
    expect("text" in byItem(seen[1]!.ext)).toBe(false);
    expect(byItem(seen[2]!.ext).decision).toBe("exact");
    expect(decisions.some((d) => ["correct", "different", "niqqud_mismatch"].includes(d.decision as string))).toBe(false);

    const triage = files["reference_triage.json"]! as { schema: string; rows: Record<string, unknown>[]; history: Record<string, unknown>[] };
    expect(triage.schema).toBe("reference_triage.v1");
    expect(triage.rows).toHaveLength(11);
    const row = (ext: string) => triage.rows.find((r) => r.item_id === ext)!;
    expect(row(seen[0]!.ext)).toMatchObject({
      queue: "triage",
      candidate_sha256: sha256Hex(seen[0]!.candidate),
      triage: { decision: "different" },
      correction: { value: "edited", text: "שורה מתוקנת", correction_start: "candidate" },
    });
    expect(row(seen[1]!.ext)).toMatchObject({ triage: { decision: "niqqud_mismatch" }, correction: null });
    expect(row(seen[2]!.ext)).toMatchObject({ triage: { decision: "correct" }, correction: null, candidate_sha256: sha256Hex(seen[2]!.candidate) });
    const typed = triage.rows.filter((r) => r.queue === "desktop_no_candidate");
    expect(typed).toHaveLength(6);
    for (const r of typed) expect(r).toMatchObject({ candidate_sha256: null, candidate_provenance: null, triage: null, correction: { value: "typed", correction_start: "blank" } });
    expect(triage.history).toEqual([expect.objectContaining({ item_id: seen[0]!.ext, value: "different" })]);
  });

  it("shows a plant only in triage, sends it to the desktop whatever the answer, and never makes its triage answer a reference", async () => {
    const c = await reviewer("planted");
    const { proposal, view } = await next(c);
    const original = view!.candidate;
    const planted = `${original}ו`;
    await env.DB.prepare(
      `INSERT INTO triage_plants (batch_id, proposal_id, item_id, plant_type, position, planted_text, planted_sha256, candidate_sha256, plants_sha256, imported_at)
       VALUES (?1, ?2, ?3, 'insertion', '0', ?4, ?5, ?6, ?7, '2026-11-20T00:00:00.000Z')`,
    )
      .bind(V12, proposal!.id, proposal!.externalId, planted, sha256Hex(planted), sha256Hex(original), "f".repeat(64))
      .run();
    // Triage shows the planted text, with nothing that marks it (no attention runs on any triage line).
    const shown = await next(c);
    expect(shown.proposal!.id).toBe(proposal!.id);
    expect(shown.view).toMatchObject({ candidate: planted, runs: [] });
    expect((await c.get<{ proposal: { view: LineVerifyView } }>(`/api/proposals/${proposal!.id}?queue=triage`)).body.proposal.view.candidate).toBe(planted);
    // "Correct" on the plant: the line goes to the desktop, which shows the true candidate.
    expect((await c.post(`/api/proposals/${proposal!.id}/decision`, { value: "correct" })).status).toBe(200);
    expect((await next(c, "triage")).proposal!.id).not.toBe(proposal!.id);
    const fix = await next(c, "fix");
    expect(fix.proposal!.id).toBe(proposal!.id);
    expect(fix.view!.candidate).toBe(original);
    // Before the desktop answer, the plant's triage answer is not a reference.
    let { files } = await exportFiles();
    const decided = (files["line_verify_decisions.json"]!.decisions as Record<string, unknown>[]).filter((d) => d.item_id === proposal!.externalId);
    expect(decided).toEqual([]);
    expect((await c.post(`/api/proposals/${proposal!.id}/decision`, { value: "exact" })).status).toBe(200);
    ({ files } = await exportFiles());
    const row = (files["reference_triage.json"]!.rows as Record<string, unknown>[]).find((r) => r.item_id === proposal!.externalId)!;
    expect(row).toMatchObject({
      candidate_sha256: sha256Hex(planted),
      plant: { planted_sha256: sha256Hex(planted), type: "insertion" },
      triage: { decision: "correct" },
      correction: { value: "kept_candidate", correction_start: "candidate" },
    });
    expect((files["line_verify_decisions.json"]!.decisions as Record<string, unknown>[]).find((d) => d.item_id === proposal!.externalId)).toMatchObject({ decision: "exact" });
    expect(files["reference_triage_history.json"]!.replaced).toEqual([expect.objectContaining({ item_id: proposal!.externalId, triage: expect.objectContaining({ decision: "correct" }) })]);
  });

  it("refuses triage answers outside a triage batch", async () => {
    await setMode("standard");
    const c = await reviewer("standard");
    const { proposal, body } = await next(c);
    expect(body.triage).toBeUndefined();
    expect((await c.post(`/api/proposals/${proposal!.id}/decision`, { value: "correct" })).status).toBe(400);
  });

  it("lists both queue counts on the batch", async () => {
    const c = await reviewer("lister");
    const res = await c.get<{ batches: { id: string; triage?: unknown }[] }>("/api/batches");
    expect(res.body.batches.find((b) => b.id === V12)!.triage).toEqual({ triage: 5, fix: 6 });
  });
});
