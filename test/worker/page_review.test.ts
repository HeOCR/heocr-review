import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { NextResponse, PageReviewView } from "../../src/shared/api";
import { Client } from "./helpers";

const PAGES = "newprinted_midcentury_v0";
const FIRST = "reshumot_scanned:sefer_hachukim_1#p2";

async function reviewer(name: string): Promise<Client> {
  const c = new Client();
  await c.signIn(name);
  await c.acceptTerms();
  return c;
}

async function next(c: Client): Promise<NextResponse & { view: PageReviewView | null }> {
  const res = await c.get<NextResponse>(`/api/batches/${PAGES}/next`);
  expect(res.status).toBe(200);
  const view = res.body.proposal?.view ?? null;
  if (view && view.kind !== "page_review") throw new Error(`expected a page view, got ${view.kind}`);
  return { ...res.body, view };
}

/** Confirm the served page as pre-filled (reading order checked where the page asks). */
async function confirmAsIs(c: Client, n: { proposal: NextResponse["proposal"]; view: PageReviewView | null }) {
  const v = n.view!;
  const text = JSON.stringify({ lines: v.lines.map((l) => ({ src: [l.i], action: "correct" })), reading_order_verified: v.readingOrderCheck ? true : null });
  return c.post(`/api/proposals/${n.proposal!.id}/decision`, { value: "confirm", text });
}

async function idOf(externalId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM proposals WHERE batch_id = ?1 AND external_id = ?2").bind(PAGES, externalId).first<{ id: number }>();
  return row!.id;
}

describe("page review", () => {
  it("serves the test pages hardest first, with the lines and their flags, and holds the reserves and pass 2 back", async () => {
    const c = await reviewer("pia");
    const n = await next(c);
    expect(n.proposal!.externalId).toBe(FIRST);
    expect(n.progress).toMatchObject({ total: 3, remainingForMe: 3 });
    const v = n.view!;
    expect(v.pass).toBe(1);
    expect(v.series.label.he).toBe("ספר החוקים");
    expect(v.lines.map((l) => [l.i, l.tierA, l.mismatch])).toEqual([
      [0, true, false],
      [2, true, true],
      [3, true, false],
      [4, false, false],
    ]);
    expect(v.rejectReasons.map((r) => r.value)).toEqual(["blank", "unreadable", "misfetched", "other"]);
    expect(n.proposal!.options.map((o) => o.value)).toEqual(["confirm", "reject"]);
    const seen: string[] = [];
    for (;;) {
      const m = await next(c);
      if (!m.proposal) break;
      seen.push(m.proposal.externalId);
      expect((await confirmAsIs(c, m)).status).toBe(200);
    }
    expect(seen).toEqual([FIRST, "plenary:K2_1#p3", "reshumot_scanned:kovetz_hatakanot_7#p1"]);
  });

  it("stores a corrected page and refuses an invalid one", async () => {
    const c = await reviewer("ed");
    const n = await next(c);
    const bad = await c.post(`/api/proposals/${n.proposal!.id}/decision`, { value: "confirm", text: JSON.stringify({ lines: [] }) });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("not covered");
    expect((await c.post(`/api/proposals/${n.proposal!.id}/decision`, { value: "confirm", text: "not json" })).status).toBe(400);
    const lines = n.view!.lines.map((l) => ({ src: [l.i], action: "correct" as string, text: null as string | null }));
    lines[0] = { src: [0], action: "edit", text: "חוק הדגמה, תשי\"ג–1953" };
    const res = await c.post<{ value: string; text: string }>(`/api/proposals/${n.proposal!.id}/decision`, { value: "confirm", text: JSON.stringify({ lines }) });
    expect(res.status).toBe(200);
    const stored = JSON.parse(res.body.text);
    expect(stored.lines[0]).toEqual({ i_src: [0], action: "edit", text: "חוק הדגמה, תשי\"ג–1953" });
    expect(stored.lines[1]).toEqual({ i_src: [2], action: "correct", text: "סעיף 1. הגדרות בחוק זה" });
  });

  it("opens the same stratum's reserve when a test page is rejected", async () => {
    const c = await reviewer("rex");
    await confirmAsIs(c, await next(c)); // the Reshumot page
    const plenary = await next(c);
    expect(plenary.proposal!.externalId).toBe("plenary:K2_1#p3");
    const rej = await c.post(`/api/proposals/${plenary.proposal!.id}/decision`, { value: "reject", text: JSON.stringify({ reject_reason: "misfetched" }) });
    expect(rej.status).toBe(200);
    await confirmAsIs(c, await next(c)); // the last test page
    const reserve = await next(c);
    expect(reserve.proposal!.externalId).toBe("plenary:K2_9#p5");
    expect(reserve.progress.total).toBe(4);
    // The other stratum's reserve stays closed, also by link.
    const closed = await idOf("reshumot_scanned:kovetz_hatakanot_8#p4");
    expect((await c.get(`/api/proposals/${closed}`)).status).toBe(409);
  });

  it("opens the blind second pass only to the same reviewer, 24 hours after their first decision, with its own pre-fill", async () => {
    const a = await reviewer("ana");
    const b = await reviewer("ben");
    const first = await next(a);
    expect((await confirmAsIs(a, first)).status).toBe(200);
    const pass2 = await idOf(`${FIRST}@pass2`);
    expect((await a.get(`/api/proposals/${pass2}`)).status).toBe(409);
    for (;;) {
      const m = await next(a);
      if (!m.proposal) break;
      expect(m.proposal.externalId).not.toContain("@pass2");
      await confirmAsIs(a, m);
    }
    // A day and a bit later (moving the first decision back stands in for the wait).
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await env.DB.prepare("UPDATE decisions SET created_at = ?1 WHERE proposal_id = ?2").bind(old, first.proposal!.id).run();
    const blind = await next(a);
    expect(blind.proposal!.externalId).toBe(`${FIRST}@pass2`);
    expect(blind.view!.pass).toBe(2);
    expect(blind.view!.prefillSource).toBe("stock_tesseract heb psm4");
    expect(blind.view!.lines.map((l) => l.text)).toEqual(['חוק הדגמה, תשי"ג--1953', "סעיף 1 הגדרות בחוק זה", "שורה רגילה בלי מספרים"]);
    // The first pass's answers are not shown: the pass-2 proposal has no decision of the reviewer's, and the
    // pass-1 page is closed to them (no view, no change) until they decide pass 2.
    expect(blind.proposal!.mine).toBeNull();
    const pass1 = first.proposal!.id;
    expect((await a.get(`/api/proposals/${pass1}`)).status).toBe(409);
    const change = { value: "reject", text: JSON.stringify({ reject_reason: "blank" }) };
    expect((await a.post(`/api/proposals/${pass1}/decision`, change)).status).toBe(409);
    expect((await confirmAsIs(a, blind)).status).toBe(200);
    expect((await a.get(`/api/proposals/${pass1}`)).status).toBe(200);
    // After pass 2, pass 1 can change again; the export then marks it revised_after_pass2.
    const revised = first.view!.lines.map((l) => ({ src: [l.i], action: "correct" as string, text: null as string | null }));
    revised[0] = { src: [0], action: "edit", text: "חוק הדגמה, תשי\"ג–1953" };
    expect((await a.post(`/api/proposals/${pass1}/decision`, { value: "confirm", text: JSON.stringify({ lines: revised }) })).status).toBe(200);
    // Another reviewer, who never confirmed the page, does not get it.
    expect((await next(b)).proposal).toBeNull(); // (the test pages are covered: one reviewer per page)
    expect((await b.get(`/api/proposals/${pass2}`)).status).toBe(409);
  });

  it("keeps the blind pass closed while the first-pass decision is a reject", async () => {
    const c = await reviewer("rae");
    const n = await next(c);
    await c.post(`/api/proposals/${n.proposal!.id}/decision`, { value: "reject", text: JSON.stringify({ reject_reason: "blank" }) });
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await env.DB.prepare("UPDATE decisions SET created_at = ?1 WHERE proposal_id = ?2").bind(old, n.proposal!.id).run();
    expect((await c.get(`/api/proposals/${await idOf(`${FIRST}@pass2`)}`)).status).toBe(409);
  });
});
