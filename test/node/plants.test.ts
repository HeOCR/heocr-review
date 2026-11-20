import { describe, expect, it } from "vitest";
import { planPlants } from "../../scripts/lib/plants";
import { sha256Hex } from "../../src/shared/sha256";
import type { ProposalRecord } from "../../src/tasks/types";

// Invented lines in the live shape the planner reads: two edition lines and a typed line without a draft.
const line = (id: number, itemId: string, payload: Record<string, unknown>): { proposal: ProposalRecord; decisions: number } => ({
  proposal: { id, externalId: itemId, payload: { item_id: itemId, pass: 1, ...payload } } as unknown as ProposalRecord,
  decisions: 0,
});
const A = line(1, "a#1", { kind: "verify", candidate_text: "שורה אחת", candidate_provenance: "pby_human_typed" });
const B = line(2, "b#1", { kind: "verify", candidate_text: "שורה שנייה", candidate_provenance: "pby_human_typed" });
const T = line(3, "t#1", { kind: "type", candidate_text: "", candidate_provenance: "none" });
const plant = (item_id: string, candidate: string, planted: string) => ({ item_id, type: "confusion", position: 0, planted_text: planted, candidate_sha256: sha256Hex(candidate), planted_sha256: sha256Hex(planted) });
const file = (plants: unknown[]) => ({ schema: "triage_plants.v1", seed: "s", rate: 0.02, plants });

describe("plant import plan", () => {
  it("plants a line whose candidate is the one the plant was made on, and skips an answered line", () => {
    const decidedB = { ...B, decisions: 1 };
    const plan = planPlants(file([plant("a#1", "שורה אחת", "שורה אחח"), plant("b#1", "שורה שנייה", "שורה שגייה")]), [A, decidedB, T]);
    expect(plan.rows.map((r) => [r.proposal_id, r.planted_text])).toEqual([[1, "שורה אחח"]]);
    expect(plan.skipped_decided).toEqual(["b#1"]);
    expect(plan.refused).toEqual([]);
  });

  it("refuses a plant on another candidate, a wrong planted sha, a line without a candidate, or an unknown line", () => {
    const bad = { ...plant("a#1", "שורה אחת", "שורה אחח"), planted_sha256: "0".repeat(64) };
    const plan = planPlants(file([plant("a#1", "שורה אחרת", "x"), bad, plant("t#1", "", "x"), plant("z#9", "a", "b")]), [A, T]);
    expect(plan.refused.map((r) => r.reason)).toEqual([
      "candidate_sha256 is not the line's current candidate",
      "listed twice",
      "the line has no candidate",
      "not a pass-1 line of the batch",
    ]);
    expect(() => planPlants({ schema: "other", plants: [] }, [A])).toThrow(/triage_plants\.v1/);
  });
});
