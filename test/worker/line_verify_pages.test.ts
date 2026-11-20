import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { NextResponse } from "../../src/shared/api";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

// Page completeness (migrations/0014) on the v1.2 fixture in triage mode: page p0001 has 5 verify lines (triage) and
// 2 typed lines; page p0003 has 4 typed lines only (no triage line: its check waits for the desktop answers).
const V12 = "fixture_line_verify_v12";
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

beforeEach(async () => {
  await env.DB.batch(env.TEST_LINE_VERIFY_V12_SQL.map((s) => env.DB.prepare(s)));
  await env.DB.prepare(
    `INSERT INTO batch_settings (batch_id, updated_at, updated_by, pointed_books, mode) VALUES (?1, '2026-11-20T00:00:00.000Z', 'test', 'keep', 'triage')
     ON CONFLICT (batch_id) DO UPDATE SET pointed_books = 'keep', mode = 'triage'`,
  )
    .bind(V12)
    .run();
});

const next = async (c: Client, queue: "triage" | "fix") => (await c.get<NextResponse>(`/api/batches/${V12}/next?queue=${queue}`)).body;

describe("line verification triage: page completeness", () => {
  it("asks for a page's completeness after its triage lines, sends a missing-lines page to the desktop, and exports both", async () => {
    const c = new Client();
    await c.signIn("pages");
    await c.acceptTerms();
    // Triage the five verify lines of p0001; the page check comes next.
    for (let i = 0; i < 5; i++) {
      const n = await next(c, "triage");
      expect(n.page ?? null).toBeNull();
      expect((await c.post(`/api/proposals/${n.proposal!.id}/decision`, { value: "correct" })).status).toBe(200);
    }
    const check = await next(c, "triage");
    expect(check.proposal).toBeNull();
    expect(check.page).toMatchObject({ mode: "check", pageId: "wikisource_he_proofread:fixture_lines__p0001", added: [] });
    expect(check.page!.boxes).toHaveLength(7);
    expect(check.triage).toMatchObject({ triage: 1 });
    const base = `/api/batches/${V12}/pages/${check.page!.itemId}`;
    expect((await c.post(`${base}/check`, { answer: "maybe" })).status).toBe(400);
    // Lines can be added only to a page marked as missing lines.
    expect((await c.post(`${base}/lines`, { box: [0.1, 0.1, 0.9, 0.15], value: "typed", text: "שורה" })).status).toBe(409);
    expect((await c.post(`${base}/check`, { answer: "missing_lines" })).status).toBe(200);
    expect((await next(c, "triage")).page ?? null).toBeNull();

    // The desktop: the page comes first, to add its missing lines.
    const add = await next(c, "fix");
    expect(add.page).toMatchObject({ mode: "add", itemId: check.page!.itemId });
    expect((await c.post(`${base}/lines`, { box: [0.9, 0.1, 0.1, 0.15], value: "typed", text: "שורה" })).status).toBe(400);
    expect((await c.post(`${base}/lines`, { box: [0.1, 0.1, 0.9, 0.15], value: "typed", text: "שָׁלוֹם" })).status).toBe(400);
    const kept = (await c.post<{ id: string }>(`${base}/lines`, { box: [0.1, 0.1, 0.9, 0.15], value: "typed", text: "שורה חסרה [?] בעמוד" })).body.id;
    const dropped = (await c.post<{ id: string }>(`${base}/lines`, { box: [0.1, 0.2, 0.9, 0.25], value: "unreadable" })).body.id;
    expect((await c.json("DELETE", `/api/batches/${V12}/added-lines/${dropped}`)).status).toBe(200);
    expect((await next(c, "fix")).page!.added.map((a) => a.id)).toEqual([kept]);
    expect((await c.post(`${base}/done`, {})).status).toBe(200);

    // The typed lines on the desktop; p0003's check then comes up in triage.
    for (;;) {
      const n = await next(c, "fix");
      if (!n.proposal) break;
      expect((await c.post(`/api/proposals/${n.proposal.id}/decision`, { value: "typed", text: "שורה" })).status).toBe(200);
    }
    const second = await next(c, "triage");
    expect(second.page).toMatchObject({ mode: "check", pageId: "benyehuda_nli_aligned:fixture_pby_42__p0003" });
    expect((await c.post(`/api/batches/${V12}/pages/${second.page!.itemId}/check`, { answer: "complete" })).status).toBe(200);

    const admin = new Client();
    const adminId = await admin.signIn("maintainer");
    const res = await handle(new Request(`http://localhost/api/admin/batches/${V12}/export`, { headers: { cookie: admin.cookie } }), { ...env, ADMIN_REVIEWER_IDS: adminId }, exec);
    const body = (await res.json()) as { problems: string[]; files: Record<string, { pages: Record<string, unknown>[]; rows: Record<string, unknown>[] }> };
    expect(body.problems).toEqual([]);
    const file = body.files["reference_triage.json"]!;
    expect(file.pages).toEqual([
      { page_id: "wikisource_he_proofread:fixture_lines__p0001", completeness: expect.objectContaining({ answer: "missing_lines", lines_added_at: expect.any(String) }) },
      { page_id: "benyehuda_nli_aligned:fixture_pby_42__p0003", completeness: expect.objectContaining({ answer: "complete" }) },
    ]);
    const added = file.rows.filter((r) => r.queue === "desktop_added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ item_id: `wikisource_he_proofread:fixture_lines__p0001#added:${kept}`, candidate_sha256: null, correction: { value: "typed", text: "שורה חסרה [?] בעמוד", correction_start: "blank" } });
    expect((added[0]!.box as number[]).length).toBe(4);
  });
});
