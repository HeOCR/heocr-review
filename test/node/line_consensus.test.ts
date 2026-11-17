import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agree,
  goldDue,
  goldHit,
  goldNext,
  lineState,
  norm,
  resolve,
  standing,
  type LineDecision,
  type Vote,
} from "../../src/tasks/line_consensus/consensus";

/** eval's agreement.py: its CASES verbatim, and its norm() on 400 seeded strings (generated in Python). */
const REF = JSON.parse(readFileSync("test/fixtures/line_consensus/agreement_reference.json", "utf8")) as {
  cases: [LineDecision, LineDecision, string, boolean][];
  norm_vectors: [string, string][];
};

describe("the port of eval's agreement.py", () => {
  it.each(REF.cases.map((c, k) => [k + 1, ...c] as const))("case %i", (_k, d1, d2, prefill, want) => {
    expect(agree(d1, d2, prefill)).toBe(want);
  });
  it("norm() gives Python's result on every vector", () => {
    for (const [s, want] of REF.norm_vectors) expect([s, norm(s)]).toEqual([s, want]);
  });
  it("resolve(): agreement.py's two resolution cases, and the rest of its states", () => {
    expect(resolve([{ action: "correct" }, { action: "edit", text: "y" }, { action: "correct" }], "x").status).toBe("majority");
    expect(resolve([{ action: "correct" }, { action: "edit", text: "y" }, { action: "unreadable" }], "x").status).toBe("to_maintainer");
    expect(resolve([{ action: "correct" }], "x").status).toBe("pending");
    expect(resolve([{ action: "correct" }, { action: "edit", text: "x " }], "x").status).toBe("agreed");
    expect(resolve([{ action: "correct" }, { action: "unreadable" }], "x").status).toBe("needs_third");
  });
  it("gold_hit compares with the pre-fill shown, so accepting a planted error is a miss", () => {
    const gold = { action: "correct" as const, text: "סעיף 3 (א)" };
    expect(goldHit({ action: "correct" }, gold, "סעיף 3 (א)")).toBe(true);
    expect(goldHit({ action: "correct" }, gold, "סעיף 8 (א)")).toBe(false);
    expect(goldHit({ action: "edit", text: "סעיף 3 (א)" }, gold, "סעיף 8 (א)")).toBe(true);
  });
});

let t = 0;
const vote = (reviewerId: string, d: LineDecision, s: Vote["standing"] = "counting"): Vote => ({
  ...d,
  reviewerId,
  standing: s,
  at: new Date(Date.UTC(2026, 10, 18, 0, 0, t++)).toISOString(),
});
const C = { action: "correct" } as const;
const U = { action: "unreadable" } as const;
const N = { action: "not_on_page" } as const;

describe("a line's routing", () => {
  it("two volunteers, then a third only on disagreement, then the maintainer", () => {
    expect(lineState([], "x")).toEqual({ state: "open", needed: 2 });
    expect(lineState([vote("a", C)], "x")).toEqual({ state: "open", needed: 1 });
    expect(lineState([vote("a", C), vote("b", { action: "edit", text: "x" })], "x")).toMatchObject({ state: "agreed", reviewers: ["a", "b"] });
    expect(lineState([vote("a", C), vote("b", U)], "x")).toEqual({ state: "open", needed: 1 });
    expect(lineState([vote("a", C), vote("b", U), vote("c", U)], "x")).toMatchObject({ state: "majority", reviewers: ["a", "b", "c"] });
    expect(lineState([vote("a", C), vote("b", U), vote("c", N)], "x")).toMatchObject({ state: "to_maintainer" });
  });
  it("a provisional volunteer's decision does not fill a slot, and counts in decision order once they reach the floor", () => {
    const p = vote("p", C, "provisional");
    const a = vote("a", C);
    expect(lineState([p, a], "x")).toEqual({ state: "open", needed: 1 });
    const b = vote("b", U);
    expect(lineState([{ ...p, standing: "counting" }, a, b], "x")).toMatchObject({ state: "agreed", reviewers: ["p", "a"] });
  });
  it("a volunteer below the floor or excluded gives the slot back, past decisions included", () => {
    expect(lineState([vote("a", C), vote("x", C, "below_floor")], "x")).toEqual({ state: "open", needed: 1 });
    expect(lineState([vote("a", C), vote("x", C, "excluded"), vote("b", C)], "x")).toMatchObject({ state: "agreed", reviewers: ["a", "b"] });
  });
  it("orders by decision time whatever the input order, and a late extra vote never undoes an agreement", () => {
    const a = vote("a", C);
    const b = vote("b", C);
    const c = vote("c", U);
    expect(lineState([c, b, a], "x")).toMatchObject({ state: "agreed", reviewers: ["a", "b"] });
  });
});

describe("standing (§4)", () => {
  it("nothing counts before 20 gold lines", () => {
    expect(standing(19, 19, false).state).toBe("provisional");
  });
  it("95% from 20 on: 19 of 20 counts, 18 of 20 does not", () => {
    expect(standing(20, 19, false).state).toBe("counting");
    expect(standing(20, 18, false).state).toBe("below_floor");
    expect(standing(40, 38, false).state).toBe("counting");
  });
  it("an admin exclusion always wins", () => {
    expect(standing(40, 40, true).state).toBe("excluded");
  });
});

describe("gold placement (§4)", () => {
  it("1 in 10 over the first 100 lines, then 1 in 20", () => {
    expect(goldDue(100)).toBe(10);
    expect(goldDue(300)).toBe(20);
  });
  it("serves about the due number of gold lines, wherever the seed puts them", () => {
    for (const offset of [0, 0.37, 0.99]) {
      let lines = 0;
      let gold = 0;
      for (let k = 0; k < 1100; k++) {
        if (goldNext(lines, gold, offset)) gold++;
        else lines++;
      }
      expect(Math.abs(gold - goldDue(lines))).toBeLessThanOrEqual(1);
    }
  });
});
