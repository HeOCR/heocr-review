import { describe, expect, it } from "vitest";
import { answerKey, goldHit, normalizeForAgreement, neededOf, outcome, standing, type Vote } from "../../src/tasks/line_label/consensus";

const PREFILL = "שלום  עולם";
let t = 0;
const vote = (reviewerId: string, value: Vote["value"], text: string | null = null, counts = true): Vote => ({
  reviewerId,
  value,
  text,
  counts,
  firstAt: new Date(Date.UTC(2026, 10, 18, 0, 0, t++)).toISOString(),
});

describe("eval's norm (§3)", () => {
  it("deletes bidi formatting, maps every White_Space to a space, collapses and strips", () => {
    expect(normalizeForAgreement("\u200f א\u00a0\u2003ב\u0085ג\u202a\t ")).toBe("א ב ג");
    expect(normalizeForAgreement("א\u0085ב")).toBe("א ב");
  });
  it("folds nothing else: niqqud, geresh, ZWJ and BOM stay", () => {
    expect(normalizeForAgreement("שָׁלוֹם")).not.toBe(normalizeForAgreement("שלום"));
    expect(normalizeForAgreement("צ'")).not.toBe(normalizeForAgreement("צ׳"));
    expect(normalizeForAgreement("א\ufeffב")).toBe("א\ufeffב");
  });
});

describe("answer keys", () => {
  it("correct agrees with an edit that normalises to the pre-fill", () => {
    expect(answerKey(PREFILL, { value: "correct", text: null })).toBe(answerKey(PREFILL, { value: "edit", text: " שלום עולם " }));
  });
  it("print_has_niqqud is its own class, with or without corrected letters", () => {
    const k = answerKey(PREFILL, { value: "print_has_niqqud", text: null });
    expect(k).not.toBe(answerKey(PREFILL, { value: "correct", text: null }));
    expect(k).toBe(answerKey(PREFILL, { value: "print_has_niqqud", text: "שלום עולם" }));
  });
  it("unreadable and not_on_page agree only with themselves", () => {
    expect(answerKey(PREFILL, { value: "unreadable", text: null })).not.toBe(answerKey(PREFILL, { value: "not_on_page", text: null }));
  });
  it("NFC: precomposed and decomposed text agree", () => {
    const composed = "שׁ";
    const decomposed = "שׁ"; // SHIN WITH SHIN DOT, which NFC decomposes to the same sequence
    expect(answerKey("", { value: "edit", text: composed })).toBe(answerKey("", { value: "edit", text: decomposed }));
  });
});

describe("outcome: two agree, a third decides, else the admin", () => {
  it("needs two reviewers, then one more", () => {
    expect(outcome(PREFILL, [], null)).toEqual({ state: "pending", needed: 2, counted: 0 });
    expect(outcome(PREFILL, [vote("a", "correct")], null)).toMatchObject({ state: "pending", needed: 1 });
  });
  it("two agreeing votes make a reference", () => {
    const o = outcome(PREFILL, [vote("a", "correct"), vote("b", "edit", "שלום עולם")], null);
    expect(o).toMatchObject({ state: "agreed", reviewers: ["a", "b"], answer: { value: "correct" } });
    expect(neededOf(o)).toBe(0);
  });
  it("a disagreement asks for a third, who decides", () => {
    const two = [vote("a", "correct"), vote("b", "edit", "שלום עולמ")];
    expect(outcome(PREFILL, two, null)).toEqual({ state: "pending", needed: 1, counted: 2 });
    const o = outcome(PREFILL, [...two, vote("c", "edit", "שלום עולמ")], null);
    expect(o).toMatchObject({ state: "majority", answer: { value: "edit", text: "שלום עולמ" }, reviewers: ["a", "b", "c"] });
  });
  it("three different answers go to the admin queue; the admin's decision is final", () => {
    const three = [vote("a", "correct"), vote("b", "unreadable"), vote("c", "not_on_page")];
    expect(outcome(PREFILL, three, null)).toMatchObject({ state: "admin_queue" });
    expect(neededOf(outcome(PREFILL, three, null))).toBe(0);
    expect(outcome(PREFILL, three, { value: "unreadable", text: null })).toMatchObject({ state: "admin", answer: { value: "unreadable" } });
  });
  it("votes that do not count are ignored, and the line needs another reviewer", () => {
    const o = outcome(PREFILL, [vote("a", "correct"), vote("x", "correct", null, false)], null);
    expect(o).toMatchObject({ state: "pending", needed: 1, counted: 1 });
  });
  it("only the first counting decisions decide: a late extra vote never undoes an agreement", () => {
    const o = outcome(PREFILL, [vote("a", "correct"), vote("b", "correct"), vote("c", "unreadable")], null);
    expect(o).toMatchObject({ state: "agreed", reviewers: ["a", "b"] });
  });
  it("orders votes by when each reviewer first decided, whatever the input order", () => {
    const a = vote("a", "correct");
    const b = vote("b", "unreadable");
    const c = vote("c", "correct");
    expect(outcome(PREFILL, [c, b, a], null)).toMatchObject({ state: "majority", reviewers: ["a", "b", "c"] });
  });
});

describe("standing on gold lines", () => {
  const rule = { floor: 0.8, minGold: 5 };
  it("counts until enough gold is answered", () => {
    expect(standing([false, false], rule, false)).toMatchObject({ counts: true, reason: "too_few_gold", accuracy: 0 });
  });
  it("stops counting below the floor, and counts again above it", () => {
    expect(standing([true, true, true, false, false], rule, false)).toMatchObject({ counts: false, reason: "below_floor" });
    expect(standing([true, true, true, true, false], rule, false)).toMatchObject({ counts: true, reason: "ok", accuracy: 0.8 });
  });
  it("an admin exclusion always wins", () => {
    expect(standing([true, true, true, true, true], rule, true)).toMatchObject({ counts: false, reason: "excluded" });
  });
  it("a gold hit uses the same answer key", () => {
    expect(goldHit(PREFILL, { value: "edit", text: "שלום עולם" }, { value: "correct", text: null })).toBe(true);
    expect(goldHit(PREFILL, { value: "unreadable", text: null }, { value: "correct", text: null })).toBe(false);
  });
});
