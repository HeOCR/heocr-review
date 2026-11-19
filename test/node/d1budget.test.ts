import { describe, expect, it } from "vitest";
import { FREE_DAILY_WRITES, SAFE_SHARE, budgetProblem, estimateImportWrites } from "../../scripts/lib/d1budget";
import { LARGE_BATCH } from "../../scripts/lib/importsql";

describe("D1 write budget", () => {
  it("estimates an import's rows written, counting the large-batch reset twice", () => {
    expect(estimateImportWrites({ items: 10, proposals: 100, existingProposals: 0 })).toBe(10 * 3 + 100 * 4 + 1);
    const big = LARGE_BATCH + 1;
    expect(estimateImportWrites({ items: 0, proposals: big, existingProposals: big })).toBe(big * 4 + 2 * big + 1);
    // The volunteer batch re-imported (18,245 stored lines, 17,817 queued, 218 pages, a state row per line): ~110k.
    expect(estimateImportWrites({ items: 218, proposals: 17_817, existingProposals: 18_245, afterRowsPerProposal: 2 })).toBeGreaterThan(100_000);
  });

  it("refuses when today's writes plus the import would pass the safe share of the budget", () => {
    const cap = FREE_DAILY_WRITES * SAFE_SHARE;
    expect(budgetProblem(0, cap, FREE_DAILY_WRITES)).toBeNull();
    expect(budgetProblem(1, cap, FREE_DAILY_WRITES)).toMatch(/would write about/);
    expect(budgetProblem(275_306, 10, FREE_DAILY_WRITES)).toMatch(/written 275,306 today/);
    expect(budgetProblem(275_306, 10, 50_000_000)).toBeNull(); // a paid plan's budget
  });
});
