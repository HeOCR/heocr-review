import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { NextResponse, PageDraft, PageReviewView, ProposalView } from "../../src/shared/api";
import { buildExport } from "../../src/tasks/export";
import { exportRows, getBatch } from "../../src/worker/db";
import { Client } from "./helpers";

const PAGES = "newprinted_midcentury_v0";
const FIRST = "reshumot_scanned:sefer_hachukim_1#p2";
type PV = ProposalView & { view: PageReviewView; draft?: PageDraft | null };

async function reviewer(name: string): Promise<Client> {
  const c = new Client();
  await c.signIn(name);
  await c.acceptTerms();
  return c;
}

async function first(c: Client): Promise<{ p: PV; progress: NextResponse["progress"] }> {
  const res = await c.get<NextResponse>(`/api/batches/${PAGES}/next`);
  expect(res.body.proposal!.externalId).toBe(FIRST);
  return { p: res.body.proposal as PV, progress: res.body.progress };
}

const draftOf = (p: PV, edited = "חוק הדגמה, תשי\"ג–1953") => ({
  prefillSha256: p.view.prefillSha256,
  readingOrder: false,
  rows: p.view.lines.map((l, k) => ({ src: [l.i], action: k === 0 ? "edit" : "correct", text: k === 0 ? edited : null, looked: k === 0 })),
});
const save = (c: Client, p: PV, body: unknown) => c.json<{ ok?: boolean; savedAt?: string; error?: string }>("PUT", `/api/proposals/${p.id}/draft`, body);
const show = async (c: Client, id: number) => (await c.get<{ proposal: PV }>(`/api/proposals/${id}`)).body.proposal;
const draftRows = () => env.DB.prepare("SELECT reviewer_id, proposal_id, prefill_sha256 FROM drafts").all();

describe("page drafts on the server", () => {
  it("saves a draft and restores it on reload or another device, for the same reviewer only", async () => {
    const c = await reviewer("dina");
    const { p } = await first(c);
    expect(p.draft).toBeNull();
    const saved = await save(c, p, draftOf(p));
    expect(saved.status).toBe(200);
    expect(saved.body.savedAt).toMatch(/Z$/);
    const again = await show(c, p.id);
    expect(again.draft).toMatchObject({ prefillSha256: p.view.prefillSha256, readingOrder: false });
    expect(again.draft!.rows[0]).toEqual({ src: [0], action: "edit", text: "חוק הדגמה, תשי\"ג–1953", looked: true });
    // Another device: a new session of the same account.
    const other = new Client();
    await other.signIn("dina");
    expect((await show(other, p.id)).draft!.rows).toEqual(again.draft!.rows);
    // Another reviewer never sees it.
    const eve = await reviewer("eve");
    expect((await show(eve, p.id)).draft).toBeNull();
    // A later save replaces it.
    expect((await save(c, p, draftOf(p, "חוק הדגמה"))).status).toBe(200);
    expect((await show(c, p.id)).draft!.rows[0]!.text).toBe("חוק הדגמה");
    expect((await draftRows()).results).toHaveLength(1);
  });

  it("refuses a draft for another pre-fill, and drops a stored one that no longer matches", async () => {
    const c = await reviewer("fay");
    const { p } = await first(c);
    const stale = await save(c, p, { ...draftOf(p), prefillSha256: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("stale_draft");
    expect((await save(c, p, draftOf(p))).status).toBe(200);
    // The page's pre-fill changes under it (a re-import): the draft is not restored, and is deleted.
    await env.DB.prepare("UPDATE drafts SET prefill_sha256 = ?1").bind("1".repeat(64)).run();
    expect((await show(c, p.id)).draft).toBeNull();
    expect((await draftRows()).results).toHaveLength(0);
  });

  it("refuses bad drafts, other origins and other task types", async () => {
    const c = await reviewer("gil");
    const { p } = await first(c);
    expect((await save(c, p, { ...draftOf(p), rows: [{ src: [1], action: "edit", text: "x", looked: true }] })).status).toBe(400);
    expect((await c.req("PUT", `/api/proposals/${p.id}/draft`, draftOf(p), { origin: "https://evil.example" })).status).toBe(403);
    const audit = await env.DB.prepare("SELECT id FROM proposals WHERE batch_id = 'fixture_reference_audit_v1' ORDER BY rank LIMIT 1").first<{ id: number }>();
    expect((await c.json("PUT", `/api/proposals/${audit!.id}/draft`, draftOf(p))).status).toBe(400);
    // A whole page's worth of text fits (well over the 16 KB other writes are held to).
    const long = { ...draftOf(p), rows: p.view.lines.map((l) => ({ src: [l.i], action: "edit", text: "א".repeat(3000), looked: true })) };
    expect(JSON.stringify(long).length * 2).toBeGreaterThan(16 * 1024);
    expect((await save(c, p, long)).status).toBe(200);
  });

  it("is not a decision: no progress, no export; confirming deletes it, and a decided page takes no draft", async () => {
    const c = await reviewer("hal");
    const { p, progress } = await first(c);
    const snapshot = async () => {
      const batch = (await getBatch(env.DB, PAGES))!;
      return JSON.stringify(buildExport({ batch, ...(await exportRows(env.DB, PAGES)), exportedAt: "2026-11-16T12:00:00.000Z" }));
    };
    const before = await snapshot();
    expect((await save(c, p, draftOf(p))).status).toBe(200);
    expect(await snapshot()).toBe(before);
    expect((await c.get<NextResponse>(`/api/batches/${PAGES}/next`)).body.progress).toEqual(progress);

    const lines = draftOf(p).rows.map((r) => ({ src: r.src, action: r.action, text: r.text }));
    expect((await c.post(`/api/proposals/${p.id}/decision`, { value: "confirm", text: JSON.stringify({ lines }) })).status).toBe(200);
    expect((await draftRows()).results).toHaveLength(0);
    const decided = await save(c, p, draftOf(p));
    expect(decided.status).toBe(409);
    expect(decided.body.error).toBe("decided");
    const view = await show(c, p.id);
    expect(view.mine).not.toBeNull();
    expect(view.draft).toBeNull();
  });

  it("discards a draft on request", async () => {
    const c = await reviewer("ivy");
    const { p } = await first(c);
    expect((await save(c, p, draftOf(p))).status).toBe(200);
    expect((await c.json("DELETE", `/api/proposals/${p.id}/draft`, {})).status).toBe(200);
    expect((await show(c, p.id)).draft).toBeNull();
  });
});
