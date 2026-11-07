import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { NextResponse, ProposalView } from "../../src/shared/api";
import { decisionsFileProblems } from "../../src/tasks/reference_audit/schema";
import { BATCH, Client } from "./helpers";

/** The fixture's spacing proposal (current " ,", proposed ", "); it is served last. */
async function spacingProposal(c: Client): Promise<ProposalView> {
  const row = await env.DB.prepare("SELECT id FROM proposals WHERE external_id = 'fx-p0001-001'").first<{ id: number }>();
  const res = await c.get<{ proposal: ProposalView }>(`/api/proposals/${row!.id}`);
  expect(res.status).toBe(200);
  return res.body.proposal;
}

async function nextProposal(c: Client): Promise<NextResponse> {
  const res = await c.get<NextResponse>(`/api/batches/${BATCH}/next`);
  expect(res.status).toBe(200);
  return res.body;
}

describe("review flow", () => {
  it("serves config with the dev sign-in on localhost", async () => {
    const c = new Client();
    const res = await c.get<{ devAuth: boolean; termsStatus: string; termsVersion: string; googleClientId: string }>("/api/config");
    expect(res.body.devAuth).toBe(true);
    expect(res.body.termsStatus).toBe("APPROVED");
    expect(res.body.termsVersion).toBe("2026-11-07-v1");
    expect(res.body.googleClientId).toBe("test-client.apps.googleusercontent.com");
  });

  it("requires a session for reads and writes", async () => {
    const c = new Client();
    expect((await c.get("/api/me")).status).toBe(401);
    expect((await c.get(`/api/batches/${BATCH}/next`)).status).toBe(401);
    expect((await c.post("/api/proposals/1/decision", { value: "accepted" })).status).toBe(401);
  });

  it("gives a stable pseudonym and stores no identity details", async () => {
    const a = new Client();
    const id1 = await a.signIn("alice");
    const b = new Client();
    const id2 = await b.signIn("alice");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^rv_[0-9a-f]{8}$/);
    const row = await env.DB.prepare("SELECT * FROM reviewers WHERE id = ?1").bind(id1).first<Record<string, unknown>>();
    expect(Object.keys(row!).sort()).toEqual(
      ["blocked", "created_at", "display_name", "display_name_consented_at", "id", "last_seen_at", "terms_accepted_at", "terms_version"].sort(),
    );
    expect(row!.display_name).toBeNull();
  });

  it("sets a HttpOnly, Secure, SameSite=Lax session cookie", async () => {
    const c = new Client();
    const res = await c.req("POST", "/api/auth/dev", { subject: "cookie" });
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-hr_session=v1\.rv_[0-9a-f]{8}\.\d+\.[A-Za-z0-9_-]+;/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("asks for the terms before the first decision and records consent", async () => {
    const c = new Client();
    const id = await c.signIn("bob");
    const { proposal } = await nextProposal(c);
    const blocked = await c.post(`/api/proposals/${proposal!.id}/decision`, { value: "accepted" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("terms_required");
    expect((await c.acceptTerms()).status).toBe(200);
    const ok = await c.post(`/api/proposals/${proposal!.id}/decision`, { value: "accepted" });
    expect(ok.status).toBe(200);
    const events = await env.DB.prepare("SELECT kind, terms_version FROM consent_events WHERE reviewer_id = ?1").bind(id).all();
    expect(events.results).toHaveLength(1);
    expect(events.results[0]!.kind).toBe("contribution_terms");
  });

  it("serves the most informative proposals first (spacing last, lower confidence first) and shows progress", async () => {
    const c = new Client();
    await c.signIn("carol");
    await c.acceptTerms();
    const seen: string[] = [];
    for (;;) {
      const n = await nextProposal(c);
      if (!n.proposal) {
        expect(n.progress.remainingForMe).toBe(0);
        expect(n.progress.covered).toBe(4);
        break;
      }
      const v = n.proposal.view;
      if (v.kind !== "text_correction") throw new Error("expected a text-correction view");
      seen.push(`${v.confidence.id}:${v.category.id}`);
      expect(n.progress.total).toBe(4);
      expect((await c.post(`/api/proposals/${n.proposal.id}/decision`, { value: "rejected" })).status).toBe(200);
    }
    expect(seen).toEqual(["medium:letter_confusion", "high:letter_confusion", "low:missing_text", "high:spacing"]);
  });

  it("returns the text-correction view with crop and page", async () => {
    const c = new Client();
    await c.signIn("dana");
    const { prefetch } = await nextProposal(c);
    const proposal = await spacingProposal(c);
    const v = proposal.view;
    if (v.kind !== "text_correction") throw new Error("expected a text-correction view");
    expect(v.current).toBe(" ,");
    expect(v.proposed).toBe(", ");
    expect(v.crop!.url).toMatch(/^\/media\//);
    expect(v.page!.box).toEqual([0.55, 0.1, 0.7, 0.14]);
    expect(proposal.options.map((o) => o.value)).toEqual(["accepted", "rejected", "edited"]);
    expect(prefetch.length).toBeGreaterThan(0);
  });

  it("normalises edits: equal to current is a rejection, equal to the proposal an acceptance", async () => {
    const c = new Client();
    await c.signIn("erez");
    await c.acceptTerms();
    const id = (await spacingProposal(c)).id;
    const asCurrent = await c.post<{ value: string }>(`/api/proposals/${id}/decision`, { value: "edited", text: " ," });
    expect(asCurrent.body.value).toBe("rejected");
    const asProposed = await c.post<{ value: string }>(`/api/proposals/${id}/decision`, { value: "edited", text: ", " });
    expect(asProposed.body.value).toBe("accepted");
    const own = await c.post<{ value: string; text: string }>(`/api/proposals/${id}/decision`, { value: "edited", text: "," });
    expect(own.body).toMatchObject({ value: "edited", text: "," });
    // All three are kept; only the last is current.
    const rows = await env.DB.prepare("SELECT value, superseded_at FROM decisions WHERE proposal_id = ?1 ORDER BY created_at").bind(id).all();
    expect(rows.results).toHaveLength(3);
    expect(rows.results.filter((r) => r.superseded_at === null)).toHaveLength(1);
    const shown = await c.get<{ proposal: ProposalView }>(`/api/proposals/${id}`);
    expect(shown.body.proposal.mine).toMatchObject({ value: "edited", text: "," });
  });

  it("rejects bad decisions and caps input", async () => {
    const c = new Client();
    await c.signIn("fay");
    await c.acceptTerms();
    const { proposal } = await nextProposal(c);
    const id = proposal!.id;
    expect((await c.post(`/api/proposals/${id}/decision`, { value: "maybe" })).status).toBe(400);
    expect((await c.post(`/api/proposals/${id}/decision`, { value: "accepted", text: "x" })).status).toBe(400);
    expect((await c.post(`/api/proposals/${id}/decision`, { value: "edited", text: "x".repeat(1001) })).status).toBe(400);
    expect((await c.post(`/api/proposals/${id}/decision`, { value: "edited", text: "a\u0000b" })).status).toBe(400);
    const big = await c.req("POST", `/api/proposals/${id}/decision`, { value: "edited", text: "x".repeat(20000) });
    expect(big.status).toBe(413);
    expect((await c.post(`/api/proposals/999999/decision`, { value: "accepted" })).status).toBe(404);
  });

  it("skips, then brings skipped proposals back on request", async () => {
    const c = new Client();
    await c.signIn("gil");
    const first = (await nextProposal(c)).proposal!;
    expect((await c.post(`/api/proposals/${first.id}/skip`)).status).toBe(200);
    const second = (await nextProposal(c)).proposal!;
    expect(second.id).not.toBe(first.id);
    const n = await nextProposal(c);
    expect(n.progress.skippedByMe).toBe(1);
    await c.post(`/api/batches/${BATCH}/skips/clear`);
    // The skipped one (rank 0) is first again; the lease on `second` belongs to this reviewer and does not demote it.
    expect((await nextProposal(c)).proposal!.id).toBe(first.id);
  });

  it("spreads concurrent reviewers over the queue with a short lease", async () => {
    const a = new Client();
    await a.signIn("hila");
    const b = new Client();
    await b.signIn("ido");
    const pa = (await nextProposal(a)).proposal!;
    const pb = (await nextProposal(b)).proposal!;
    expect(pb.id).not.toBe(pa.id);
  });

  it("offers a covered proposal to nobody else and records every reviewer's decision", async () => {
    const a = new Client();
    await a.signIn("yael");
    await a.acceptTerms();
    const p = (await nextProposal(a)).proposal!;
    await a.post(`/api/proposals/${p.id}/decision`, { value: "accepted" });
    const b = new Client();
    await b.signIn("zvi");
    await b.acceptTerms();
    expect((await nextProposal(b)).proposal!.id).not.toBe(p.id);
    // b can still open it directly (for a second review) and decide; both decisions are kept.
    await b.post(`/api/proposals/${p.id}/decision`, { value: "rejected" });
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM decisions WHERE proposal_id = ?1 AND superseded_at IS NULL").bind(p.id).first<{ n: number }>();
    expect(rows!.n).toBe(2);
  });

  it("lets a reviewer opt in to a credit name and withdraw it", async () => {
    const c = new Client();
    const id = await c.signIn("noa");
    expect((await c.acceptTerms("Noa L.")).status).toBe(200);
    expect((await c.get<{ displayName: string }>("/api/me")).body.displayName).toBe("Noa L.");
    expect((await c.post("/api/me/display-name", { displayName: "x@example.com", consent: true })).status).toBe(400);
    expect((await c.post("/api/me/display-name", { displayName: "Noa", consent: false })).status).toBe(400);
    expect((await c.post("/api/me/display-name", { displayName: null })).status).toBe(200);
    const kinds = await env.DB.prepare("SELECT kind FROM consent_events WHERE reviewer_id = ?1 ORDER BY id").bind(id).all();
    expect(kinds.results.map((r) => r.kind)).toEqual(["contribution_terms", "display_name_credit", "display_name_withdrawn"]);
  });
});

describe("admin", () => {
  it("is forbidden to non-admins", async () => {
    const c = new Client();
    await c.signIn("someone");
    expect((await c.get("/api/admin/progress")).status).toBe(403);
    expect((await c.get(`/api/admin/batches/${BATCH}/export`)).status).toBe(403);
  });

  it("exports exactly hocrgen's decisions format: every reviewer's current decision", async () => {
    const admin = new Client();
    const adminId = await admin.signIn("maintainer");
    const e = { ...env, ADMIN_REVIEWER_IDS: ` ${adminId} ,rv_00000000` };
    // ADMIN_REVIEWER_IDS is a binding; call the handler with an env that names this admin.
    const { handle } = await import("../../src/worker/index");
    const call = async (path: string) => {
      const res = await handle(new Request("http://localhost" + path, { headers: { cookie: admin.cookie } }), e, {
        waitUntil() {},
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const r1 = new Client();
    const id1 = await r1.signIn("rev1");
    await r1.acceptTerms("Reviewer One");
    const r2 = new Client();
    const id2 = await r2.signIn("rev2");
    await r2.acceptTerms();
    const rows = (await env.DB.prepare("SELECT id, external_id FROM proposals").all<{ id: number; external_id: string }>()).results;
    const ids = ["fx-p0001-001", "fx-p0002-001", "fx-p0001-002", "fx-p0001-003"].map((ext) => rows.find((r) => r.external_id === ext)!);
    await r1.post(`/api/proposals/${ids[0]!.id}/decision`, { value: "rejected" });
    await r1.post(`/api/proposals/${ids[0]!.id}/decision`, { value: "accepted" }); // supersedes
    await r1.post(`/api/proposals/${ids[1]!.id}/decision`, { value: "edited", text: "\u05e2" }); // = proposed: accepted
    await r1.post(`/api/proposals/${ids[2]!.id}/decision`, { value: "accepted" });
    await r2.post(`/api/proposals/${ids[2]!.id}/decision`, { value: "rejected" }); // conflict
    await r1.post(`/api/proposals/${ids[3]!.id}/decision`, { value: "edited", text: "וְ" });

    const progress = await call("/api/admin/progress");
    expect(progress.status).toBe(200);
    const res = await call(`/api/admin/batches/${BATCH}/export`);
    expect(res.status).toBe(200);
    expect(res.body.problems).toEqual([]);
    const files = res.body.files as Record<string, Record<string, unknown>>;
    const decisionsFile = files["reference_audit_decisions.json"]!;
    const ledger = files["reference_audit_decisions_ledger.json"]!;
    expect(Object.keys(decisionsFile)).toEqual(["schema_version", "audit_id", "description", "decisions"]);
    const decisions = decisionsFile.decisions as Record<string, unknown>[];
    for (const d of decisions) {
      expect(Object.keys(d)).toEqual(
        d.decision === "edited"
          ? ["decision_id", "proposal_id", "item_id", "decision", "text", "checked_by", "reviewer", "decided_at"]
          : ["decision_id", "proposal_id", "item_id", "decision", "checked_by", "reviewer", "decided_at"],
      );
      expect(d.checked_by).toBe("human");
      expect(d.decision_id).toBe(`decision:${String(d.proposal_id)}:${String(d.reviewer)}`);
      expect(d.decided_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // In the proposals file's order (not serving order), reviewers sorted within a proposal; both conflict sides kept.
    const [lo, hi] = [id1, id2].sort();
    expect(decisions.map((d) => [d.proposal_id, d.reviewer, d.decision])).toEqual([
      ["fx-p0001-001", id1, "accepted"],
      ["fx-p0001-002", lo, lo === id1 ? "accepted" : "rejected"],
      ["fx-p0001-002", hi, hi === id1 ? "accepted" : "rejected"],
      ["fx-p0001-003", id1, "edited"],
      ["fx-p0002-001", id1, "accepted"],
    ]);
    const refs = (await env.DB.prepare("SELECT p.external_id, i.external_id AS item, p.payload_json FROM proposals p JOIN items i ON i.id = p.item_id").all<{
      external_id: string;
      item: string;
      payload_json: string;
    }>()).results.map((r) => ({ proposal_id: r.external_id, item_id: r.item, current: (JSON.parse(r.payload_json) as { current: string }).current }));
    expect(decisionsFileProblems(decisionsFile, "fixture_reference_audit_v1", refs)).toEqual([]);
    const counts = ledger.counts as Record<string, number>;
    expect(counts).toMatchObject({ proposals: 4, decisions_exported: 5, decisions_recorded: 6, agreed: 3, conflict: 1, reviewers: 2 });
    const conflict = (ledger.proposals as { proposal_id: string; status: string; reviewer_count: number }[]).find((p) => p.status === "conflict")!;
    expect(conflict).toMatchObject({ proposal_id: "fx-p0001-002", reviewer_count: 2 });
    expect(ledger.credits).toEqual([expect.objectContaining({ reviewer: id1, display_name: "Reviewer One" })]);
  });
});
