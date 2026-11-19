import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BLOCK,
  FRONT_LINES,
  contextBoxOf,
  goldDue,
  goldFileProblems,
  goldHit,
  goldImport,
  goldOrder,
  phistReason,
  scheduleSeed,
  type GoldFile,
} from "../../src/tasks/line_verify/gold";

// The synthetic fixture (made-up text, no real scan).
const fixture = () => JSON.parse(readFileSync("test/fixtures/line_verify_gold/phist_gold_v1_1_1.json", "utf8")) as GoldFile;

describe("P-hist gold file", () => {
  it("accepts the fixture", () => expect(goldFileProblems(fixture())).toEqual([]));

  it("refuses the wrong schema, a page without an open licence, a closed answer and a stray page key", () => {
    expect(goldFileProblems({ ...fixture(), schema: "phist_volunteer_gold.v1.1" })[0]).toMatch(/schema must be/);
    const f = fixture();
    const key = Object.keys(f.pages)[0]!;
    f.pages[key]!.text_license = "CC BY-NC 4.0";
    f.gold[0]!.answer = { action: "unreadable", text: null };
    f.gold[1]!.page_key = "nope";
    const p = goldFileProblems(f).join("\n");
    expect(p).toMatch(/open licence/);
    expect(p).toMatch(/gold\[0\]: answer must be/);
    expect(p).toMatch(/gold\[1\]: page_key must name a page/);
  });

  it("maps each gold line to a proposal that looks like a P-hist line", () => {
    const { items, proposals } = goldImport(fixture());
    expect(items).toHaveLength(2);
    for (const p of proposals) {
      expect(p.externalId).toMatch(/^wikisource:fixture_extra__p000[12]#L\d{3}$/);
      const x = p.payload as { page: { source: string }; candidate_provenance: string; kind: string; candidate_text: string; gold: { gold_id: string } };
      expect(x.page.source).toBe("wikisource_he"); // labelled as the bundles label Hebrew Wikisource
      expect(x.candidate_provenance).toBe(x.kind === "verify" ? "wikisource_quality4_validated" : "none");
      if (x.kind === "type") expect(x.candidate_text).toBe(""); // a typed line shows the blank box
      else expect(x.candidate_text.length).toBeGreaterThan(0);
      expect(x.gold.gold_id).toMatch(/^fixture-x-/);
    }
  });

  it("widens the context box by 1.5 line heights, clamped to the page", () => {
    expect(contextBoxOf([10, 100, 90, 140], { width: 100, height: 1000 })).toEqual([10, 40, 90, 200]);
    expect(contextBoxOf([10, 10, 90, 50], { width: 100, height: 80 })).toEqual([10, 0, 90, 80]);
  });
});

describe("schedule", () => {
  it("puts 15 gold lines in a reviewer's first 75, one per block of 5, then one per block of 15", () => {
    for (const id of ["rv_00000000", "rv_12345678", "rv_deadbeef", "rv_0badf00d"]) {
      const seed = scheduleSeed(id);
      const due = Array.from({ length: FRONT_LINES + 3 * BLOCK }, (_, n) => goldDue(n, seed));
      expect(due.slice(0, FRONT_LINES).filter(Boolean)).toHaveLength(15);
      for (let b = 0; b < FRONT_LINES / 5; b++) expect(due.slice(b * 5, b * 5 + 5).filter(Boolean)).toHaveLength(1);
      for (let b = 0; b < 3; b++) expect(due.slice(FRONT_LINES + b * BLOCK, FRONT_LINES + (b + 1) * BLOCK).filter(Boolean)).toHaveLength(1);
    }
  });

  it("orders gold lines per reviewer, deterministically", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(goldOrder("rv_1", ids)).toEqual(goldOrder("rv_1", [...ids].reverse()));
    expect(new Set(goldOrder("rv_1", ids))).toEqual(new Set(ids));
  });
});

describe("grading and the second gate", () => {
  const answer = { action: "text", text: "שורה לבדיקה" };
  it("hits on the folded answer; exact on a planted error, print has niqqud and non-text answers miss", () => {
    expect(goldHit({ value: "exact", text: null }, "שורה לבדיקה", "verify", answer)).toBe(true);
    expect(goldHit({ value: "exact", text: null }, "שורח לבדיקה", "verify", answer)).toBe(false); // planted error accepted
    expect(goldHit({ value: "edited", text: "שורה  לבדיקה " }, "שורח לבדיקה", "verify", answer)).toBe(true);
    expect(goldHit({ value: "typed", text: " שורה לבדיקה" }, "", "type", answer)).toBe(true);
    expect(goldHit({ value: "pointed_print", text: "שורה לבדיקה" }, "", "type", answer)).toBe(false);
    expect(goldHit({ value: "pointed_print", text: null }, "", "type", answer)).toBe(false); // refused upstream: a miss here
    expect(goldHit({ value: "unreadable", text: null }, "שורה לבדיקה", "verify", answer)).toBe(false);
  });

  it("needs 15 graded lines at 90% or better", () => {
    expect(phistReason(14, 14)).toBe("fewer_than_15_phist_gold");
    expect(phistReason(15, 13)).toBe("below_phist_floor");
    expect(phistReason(15, 14)).toBeNull();
    expect(phistReason(20, 18)).toBeNull();
  });
});
