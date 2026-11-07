import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildExport } from "../../src/tasks/export";
import { DECISIONS_DESCRIPTION, referenceAudit } from "../../src/tasks/reference_audit";
import { referenceAuditImporter } from "../../src/tasks/reference_audit/importer";
import { decisionsFileProblems, proposalsFileProblems, reviewerIdProblems } from "../../src/tasks/reference_audit/schema";
import type { BatchRecord, DecisionRecord, ProposalRecord } from "../../src/tasks/types";
import { contentSha256 } from "../../scripts/lib/importsql";

const fixture = JSON.parse(readFileSync("test/fixtures/proposals.fixture.json", "utf8")) as Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** hocrgen's committed files, when a hocrgen checkout with the E2d4 work is next to this repo. */
const HOCRGEN = process.env.HOCRGEN_DIR ?? join(homedir(), "clones", "hocrgen");
const realProposals = process.env.HOCRGEN_PROPOSALS ?? join(HOCRGEN, "docs", "reference_audit_proposals.json");

describe("reference_audit_proposals.v1 (port of hocrgen's validator)", () => {
  it("accepts the fixture", () => {
    expect(proposalsFileProblems(fixture)).toEqual([]);
    expect(referenceAuditImporter.problems(fixture)).toEqual([]);
  });

  it.runIf(existsSync(realProposals))("accepts hocrgen's committed E2d4 proposals", () => {
    const real: unknown = JSON.parse(readFileSync(realProposals, "utf8"));
    expect(referenceAuditImporter.problems(real)).toEqual([]);
    const bundle = referenceAuditImporter.bundle(real);
    expect(bundle.proposals.length).toBeGreaterThan(0);
  });

  it.each([
    ["a non-agent proposal", (f: any) => (f.proposals[0].checked_by = "human"), "checked_by must be agent"],
    ["an attested proposal", (f: any) => (f.proposals[0].status = "accepted"), "status must be agent_proposed"],
    ["a span length mismatch", (f: any) => (f.proposals[0].end += 1), "end - start must equal the length of current"],
    ["a bad box", (f: any) => (f.proposals[0].region.box_normalized = [0.5, 0.5, 0.4, 0.6]), "region.box_normalized must be fractions"],
    ["a wrong proposal_count", (f: any) => (f.pages[0].proposal_count = 9), "proposal_count 9"],
    ["overlapping proposals", (f: any) => (f.proposals[1].start = f.proposals[0].start), ""],
    ["a missing licence", (f: any) => delete f.text_license, "text_license"],
  ])("refuses %s", (_, mutate, message) => {
    const f = clone(fixture);
    mutate(f);
    const problems = referenceAuditImporter.problems(f);
    expect(problems.length).toBeGreaterThan(0);
    if (message) expect(problems.join("\n")).toContain(message);
  });

  it("counts offsets in code points like Python", () => {
    const f = clone(fixture) as any;
    const p = f.proposals[3];
    expect(p.current).toBe("ﬠ");
    expect(proposalsFileProblems(f)).toEqual([]);
  });
});

describe("reviewer handles", () => {
  it("accepts the app's pseudonyms (hocrgen's rv_ ids) and nothing else", () => {
    expect(reviewerIdProblems("rv_1a2b3c4d")).toEqual([]);
    expect(reviewerIdProblems("rv-1a2b3c4d")).not.toEqual([]);
    expect(reviewerIdProblems("rv_1a2b3c4d5")).not.toEqual([]);
    expect(reviewerIdProblems("reviewer-1")).not.toEqual([]);
  });
});

describe("export", () => {
  const bundle = referenceAuditImporter.bundle(fixture);
  const batch: BatchRecord = { id: bundle.batch.id, taskType: "reference_audit", title: "t", source: bundle.batch.source, minReviewers: 1 };
  const proposals: ProposalRecord[] = bundle.proposals.map((p, i) => ({
    id: i + 1,
    batchId: batch.id,
    externalId: p.externalId,
    itemExternalId: p.itemExternalId,
    itemTitle: "",
    category: p.category,
    confidence: p.confidence,
    rank: p.rank,
    payload: p.payload,
    media: {},
    contentSha256: contentSha256(p.contentKey),
    active: true,
  }));
  const refs = proposals.map((p) => ({ proposal_id: p.externalId, item_id: p.itemExternalId, current: p.payload.current as string }));
  let n = 0;
  const decision = (proposalId: number, reviewerId: string, value: string, extra: Partial<DecisionRecord> = {}): DecisionRecord => ({
    id: `hr-${(++n).toString(16).padStart(16, "0")}`,
    proposalId,
    reviewerId,
    value,
    text: null,
    createdAt: `2026-11-07T10:00:${String(n).padStart(2, "0")}.000Z`,
    decidedOn: "2026-11-07",
    supersededAt: null,
    proposalSha256: proposals[proposalId - 1]!.contentSha256,
    termsVersion: "t1",
    ...extra,
  });

  it("exports an empty, valid file before anyone decides", () => {
    const r = buildExport({ batch, proposals, decisions: [], credits: [], exportedAt: "x" });
    expect(r.problems).toEqual([]);
    expect((r.decisionsFile.content as { decisions: unknown[] }).decisions).toEqual([]);
    expect(r.counts.undecided).toBe(4);
  });

  it("exports every reviewer's current decision, drops superseded and stale ones, and reports outcomes", () => {
    const decisions = [
      decision(1, "rv_aaaaaaaa", "rejected", { supersededAt: "2026-11-07T11:00:00.000Z" }),
      decision(1, "rv_aaaaaaaa", "accepted"),
      decision(2, "rv_aaaaaaaa", "accepted", { proposalSha256: "0".repeat(64) }),
      decision(3, "rv_bbbbbbbb", "edited", { text: "הוי" }),
      decision(3, "rv_aaaaaaaa", "edited", { text: "הוי" }),
      decision(4, "rv_aaaaaaaa", "accepted"),
      decision(4, "rv_bbbbbbbb", "rejected"),
    ];
    const one = buildExport({ batch, proposals, decisions, credits: [], exportedAt: "x" });
    expect(one.problems).toEqual([]);
    const out = (one.decisionsFile.content as { decisions: { decision_id: string; proposal_id: string; decision: string; reviewer: string }[] }).decisions;
    const order = (id: string) => (proposals.find((p) => p.externalId === id)!.payload.order as number);
    expect(out.map((d) => order(d.proposal_id))).toEqual([...out.map((d) => order(d.proposal_id))].sort((a, b) => a - b));
    expect(out).toHaveLength(5);
    expect(out.map((d) => d.decision_id)).toContain(`decision:${proposals[2]!.externalId}:rv_aaaaaaaa`);
    expect(one.counts).toMatchObject({ decisions_stale: 1, decisions_exported: 5, reviewers: 2, agreed: 2, conflict: 1, undecided: 1 });
    const two = buildExport({ batch: { ...batch, minReviewers: 2 }, proposals, decisions, credits: [], exportedAt: "x" });
    expect(two.counts).toMatchObject({ agreed: 1, awaiting_reviewers: 1, conflict: 1 });
    expect(decisionsFileProblems(two.decisionsFile.content, batch.id, refs)).toEqual([]);
  });

  it("refuses two current decisions by one reviewer on one proposal", () => {
    const content = {
      schema_version: "reference_audit_decisions.v1",
      audit_id: batch.id,
      decisions: [1, 2].map((i) => ({
        decision_id: `d${i}`,
        proposal_id: refs[0]!.proposal_id,
        decision: "accepted",
        checked_by: "human",
        reviewer: "rv_aaaaaaaa",
        decided_at: "2026-11-07",
      })),
    };
    expect(decisionsFileProblems(content, batch.id, refs).join()).toContain("one per reviewer");
  });

  it.runIf(existsSync(join(HOCRGEN, "docs", "reference_audit_decisions.json")))("uses hocrgen's committed description", () => {
    const committed = JSON.parse(readFileSync(join(HOCRGEN, "docs", "reference_audit_decisions.json"), "utf8")) as { description: string };
    expect(DECISIONS_DESCRIPTION).toBe(committed.description);
  });

  it("produces what hocrgen's own validator accepts", () => {
    // The same file is checked with hocrgen's Python validator in CI-less local runs (see README).
    const r = buildExport({ batch, proposals, decisions: [decision(4, "rv_cccccccc", "edited", { text: "וְ" })], credits: [], exportedAt: "x" });
    expect(r.problems).toEqual([]);
    expect(referenceAudit.validateExport(batch, proposals, r.decisionsFile.content)).toEqual([]);
  });
});
