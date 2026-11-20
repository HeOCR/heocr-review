import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextResponse } from "../../src/shared/api";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

// Page completeness (migrations/0014) on the v1.2 fixture in triage mode: page p0001 has 5 verify lines (triage) and
// 2 typed lines; page p0003 has 4 typed lines only (no triage line: its check waits for the desktop answers).
const V12 = "fixture_line_verify_v12";
const EMPTY = "fixture_line_verify_empty";
const MIXED_PAGE = "wikisource_he_proofread:fixture_lines__p0001";
const DESKTOP_PAGE = "benyehuda_nli_aligned:fixture_pby_42__p0003";
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

beforeEach(async () => {
  await env.DB.batch(env.TEST_LINE_VERIFY_V12_SQL.map((s) => env.DB.prepare(s)));
  await triageMode(V12);
});

async function triageMode(batchId: string) {
  await env.DB.prepare(
    `INSERT INTO batch_settings (batch_id, updated_at, updated_by, pointed_books, mode) VALUES (?1, '2026-11-20T00:00:00.000Z', 'test', 'keep', 'triage')
     ON CONFLICT (batch_id) DO UPDATE SET pointed_books = 'keep', mode = 'triage'`,
  )
    .bind(batchId)
    .run();
}

const next = async (c: Client, queue: "triage" | "fix", batch = V12) => (await c.get<NextResponse>(`/api/batches/${batch}/next?queue=${queue}`)).body;

async function timedPost(c: Client, path: string, body: unknown, at: string): Promise<number> {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(at));
  try {
    const res = await handle(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { cookie: c.cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify(body),
    }), env, exec);
    return res.status;
  } finally {
    clock.mockRestore();
  }
}

async function exportTriage(batch: string) {
  const admin = new Client();
  const adminId = await admin.signIn("maintainer");
  const res = await handle(new Request(`http://localhost/api/admin/batches/${batch}/export`, { headers: { cookie: admin.cookie } }), { ...env, ADMIN_REVIEWER_IDS: adminId }, exec);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { problems: string[]; files: Record<string, { pages: Record<string, unknown>[]; rows: Record<string, unknown>[] }> };
  expect(body.problems).toEqual([]);
  return body.files["reference_triage.json"]!;
}

describe("line verification triage: page completeness", () => {
  it("waits for current decisions on mixed pages, rejects premature posts, and exports ordered timestamps", async () => {
    const c = new Client();
    await c.signIn("pages");
    await c.acceptTerms();
    const { id: itemId } = (await env.DB.prepare("SELECT id FROM items WHERE batch_id = ?1 AND external_id = ?2").bind(V12, MIXED_PAGE).first<{ id: number }>())!;
    const base = `/api/batches/${V12}/pages/${itemId}`;
    const today = new Date().toISOString().slice(0, 10);
    const triageAt = `${today}T00:01:00.000Z`;
    const checkAt = `${today}T23:59:00.000Z`;
    expect((await c.post(`${base}/check`, { answer: "complete" })).status).toBe(409);

    // Triage all five candidate lines, with one outstanding fix.
    let timedLine: NonNullable<NextResponse["proposal"]> | undefined;
    let staleLine: NonNullable<NextResponse["proposal"]> | undefined;
    let differentId: number | undefined;
    for (let i = 0; i < 5; i++) {
      const n = await next(c, "triage");
      expect(n.page ?? null).toBeNull();
      expect(n.proposal).not.toBeNull();
      if (i === 0) {
        timedLine = n.proposal!;
        expect(await timedPost(c, `/api/proposals/${timedLine.id}/decision`, { value: "correct" }, triageAt)).toBe(200);
      } else {
        if (i === 1) staleLine = n.proposal!;
        if (i === 4) differentId = n.proposal!.id;
        expect((await c.post(`/api/proposals/${n.proposal!.id}/decision`, { value: i === 4 ? "different" : "correct" })).status).toBe(200);
      }
    }
    expect((await next(c, "triage")).page ?? null).toBeNull();
    expect((await c.post(`${base}/check`, { answer: "missing_lines" })).status).toBe(409);

    // Settle the mixed page, including its candidate correction. The other page still needs desktop answers.
    const { results: typed } = await env.DB.prepare("SELECT id FROM proposals WHERE item_id = ?1 AND json_extract(payload_json, '$.kind') = 'type' AND json_extract(payload_json, '$.pass') = 1")
      .bind(itemId).all<{ id: number }>();
    expect(typed).toHaveLength(2);
    for (const { id } of typed) {
      expect((await c.post(`/api/proposals/${id}/decision`, { value: "typed", text: "שורה" })).status).toBe(200);
    }
    expect((await next(c, "triage")).page ?? null).toBeNull();
    expect((await c.post(`${base}/check`, { answer: "missing_lines" })).status).toBe(409);
    expect((await c.post(`/api/proposals/${differentId!}/decision`, { value: "edited", text: "שורה" })).status).toBe(200);

    // A line on changed content is offered again, and the old answer cannot unlock the page.
    const { id: staleId } = staleLine!;
    await env.DB.prepare("UPDATE proposals SET content_sha256 = ?2 WHERE id = ?1").bind(staleId, "a".repeat(64)).run();
    const retry = await next(c, "triage");
    expect(retry.page ?? null).toBeNull();
    expect(retry.proposal).toMatchObject({ id: staleId, mine: null });
    expect((await c.post(`${base}/check`, { answer: "missing_lines" })).status).toBe(409);
    expect((await c.post(`/api/proposals/${staleId}/decision`, { value: "correct" })).status).toBe(200);

    const check = await next(c, "triage");
    expect(check.proposal).toBeNull();
    expect(check.page).toMatchObject({ mode: "check", pageId: MIXED_PAGE, added: [] });
    expect(check.page!.boxes).toHaveLength(7);
    expect(check.triage).toMatchObject({ triage: 1 });
    expect((await c.post(`${base}/check`, { answer: "maybe" })).status).toBe(400);
    // Lines can be added only to a page marked as missing lines.
    expect((await c.post(`${base}/lines`, { box: [0.1, 0.1, 0.9, 0.15], value: "typed", text: "שורה" })).status).toBe(409);
    expect(await timedPost(c, `${base}/check`, { answer: "missing_lines" }, checkAt)).toBe(200);
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
    const doneAt = `${today}T23:59:01.000Z`;
    expect(await timedPost(c, `${base}/done`, {}, doneAt)).toBe(200);

    // The typed lines on the desktop; p0003's check then comes up in triage.
    for (;;) {
      const n = await next(c, "fix");
      if (!n.proposal) break;
      expect((await c.post(`/api/proposals/${n.proposal.id}/decision`, { value: "typed", text: "שורה" })).status).toBe(200);
    }
    const second = await next(c, "triage");
    expect(second.page).toMatchObject({ mode: "check", pageId: DESKTOP_PAGE });
    expect((await c.post(`/api/batches/${V12}/pages/${second.page!.itemId}/check`, { answer: "complete" })).status).toBe(200);

    const file = await exportTriage(V12);
    expect(file.pages).toEqual([
      { page_id: MIXED_PAGE, completeness: expect.objectContaining({ answer: "missing_lines", decided_at: checkAt, lines_added_at: doneAt }) },
      { page_id: DESKTOP_PAGE, completeness: expect.objectContaining({ answer: "complete" }) },
    ]);
    expect(file.rows.find((r) => r.item_id === timedLine!.externalId)).toMatchObject({ triage: { decided_at: triageAt } });
    const added = file.rows.filter((r) => r.queue === "desktop_added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ item_id: `wikisource_he_proofread:fixture_lines__p0001#added:${kept}`, candidate_sha256: null, correction: { value: "typed", text: "שורה חסרה [?] בעמוד", correction_start: "blank" } });
    expect((added[0]!.box as number[]).length).toBe(4);
  });

  it("imports zero-box pages with an image, checks them, and exports unanswered pages as non-final", async () => {
    await env.DB.batch(env.TEST_LINE_VERIFY_EMPTY_SQL.map((sql) => env.DB.prepare(sql)));
    await triageMode(EMPTY);
    const c = new Client();
    await c.signIn("empty-pages");
    await c.acceptTerms();

    const unchecked = await exportTriage(EMPTY);
    expect(unchecked.pages).toEqual([
      { page_id: MIXED_PAGE, completeness: null },
      { page_id: DESKTOP_PAGE, completeness: null },
    ]);
    expect(unchecked.rows).toEqual([]);

    const check = await next(c, "triage", EMPTY);
    expect(check.triage).toMatchObject({ triage: 2, fix: 0 });
    expect(check.page).toMatchObject({ pageId: MIXED_PAGE, mode: "check", boxes: [], image: { url: "/media/fixture/empty-page.jpg" } });
    const base = `/api/batches/${EMPTY}/pages/${check.page!.itemId}`;
    expect((await c.post(`${base}/check`, { answer: "missing_lines" })).status).toBe(200);
    expect((await next(c, "fix", EMPTY)).page).toMatchObject({ pageId: MIXED_PAGE, mode: "add" });
    expect((await c.post(`${base}/lines`, { box: [0.1, 0.1, 0.9, 0.15], value: "typed", text: "שורה" })).status).toBe(200);
    expect((await c.post(`${base}/done`)).status).toBe(200);
    expect((await next(c, "triage", EMPTY)).page).toMatchObject({ pageId: DESKTOP_PAGE, boxes: [] });

    const exported = await exportTriage(EMPTY);
    expect(exported.pages).toEqual([
      { page_id: MIXED_PAGE, completeness: expect.objectContaining({ answer: "missing_lines", lines_added_at: expect.any(String) }) },
      { page_id: DESKTOP_PAGE, completeness: null },
    ]);
    expect(exported.rows).toEqual([expect.objectContaining({ queue: "desktop_added", box: [140, 150, 1260, 225] })]);
  });
});
