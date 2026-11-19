import { describe, expect, it } from "vitest";
import { PUBLIC_FORBIDDEN_KEYS, goldProposalIds, publicDecisions, publicLedger, publicProblems } from "../../src/tasks/public_export";
import type { ProposalRecord } from "../../src/tasks/types";

// Made-up records; no reviewer, text or line from any source.
describe("public export view", () => {
  it("refuses every forbidden key at any depth, and gold-line decisions and reviewer lists", () => {
    for (const k of PUBLIC_FORBIDDEN_KEYS) expect(publicProblems({ a: [{ b: { [k]: 1 } }] })).toEqual([`$.a[0].b.${k}: not allowed in a public file`]);
    expect(publicProblems({ decisions: [{ role: "gold" }] })).toEqual(["$.decisions[0]: a decision on a gold line"]);
    expect(publicProblems({ reviewers: [{ reviewer: "rv_0" }] })).toEqual(["$.reviewers: per-reviewer records are not allowed in a public file"]);
    expect(publicProblems({ proposals: [{ proposal_id: "g1" }] }, new Set(["g1"]))).toEqual(["$.proposals[0]: a gold line's proposal"]);
    expect(publicProblems({ counts: { reviewers: 3 }, decisions: [{ role: "first", reviewer: "rv_0", text: "x" }] })).toEqual([]);
  });

  it("strips the decisions file and the ledger down to what may be published", () => {
    const file = {
      decisions: [
        { decision_id: "d1", reviewer: "rv_1", role: "first", counted: false, not_counted_reason: "below_floor", step: "uncounted", gold_id: null, gold_hit: null },
        { decision_id: "d2", reviewer: "rv_1", role: "gold", gold_id: "g", gold_hit: true },
      ],
      lines: [{ item_id: "i", reference: { class: "text", text: "t" }, pair: ["d1", "d3"] }],
      reviewers: [{ reviewer: "rv_1", gold_seen: 20, gold_hits: 18, standing: "below_floor" }],
      admin_exclusions: [{ reviewer: "rv_2", excluded_at: "x" }],
    };
    const pub = publicDecisions(file);
    expect(pub).toEqual({ decisions: [{ decision_id: "d1", reviewer: "rv_1", role: "first" }], lines: [{ item_id: "i", reference: { class: "text", text: "t" } }] });
    expect(publicProblems(pub)).toEqual([]);
    const ledger = { counts: { reviewers: 2 }, proposals: [{ proposal_id: "p1", decisions: [] }, { proposal_id: "g1", decisions: [{ reviewer: "rv_1" }] }] };
    expect(publicLedger(ledger, new Set(["g1"]))).toEqual({ counts: { reviewers: 2 }, proposals: [{ proposal_id: "p1", decisions: [] }] });
  });

  it("names the gold proposals by their payload", () => {
    const p = (externalId: string, gold: unknown) => ({ externalId, payload: { gold } }) as unknown as ProposalRecord;
    expect([...goldProposalIds([p("a", null), p("b", { gold_id: "g" }), p("c", undefined)])]).toEqual(["b"]);
  });
});
