import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LINE_FOLD_V1_SHA256, decisionValue, lineFoldV1, referenceOf, routeLine, type CountedVote } from "../../src/tasks/line_verify/resolution";

// Made-up lines; none from any source.
const vote = (id: string, value: string, text: string | null = null, reviewerId = `rv_${id}`): CountedVote => ({ decisionId: id, reviewerId, value, text, createdAt: id });

describe("line_fold_v1", () => {
  it("is eval's profile, when the planning checkout is here", () => {
    const path = `${process.env.HOME}/agents/environments/opensource/projects/heocr/tasks/eval-domains/profiles/line_fold_v1.json`;
    if (!existsSync(path)) return; // CI has no planning checkout; the folds below are its table
    const raw = readFileSync(path);
    expect(createHash("sha256").update(raw).digest("hex")).toBe(LINE_FOLD_V1_SHA256);
    const profile = JSON.parse(raw.toString("utf8")) as { folds: Record<string, string> };
    for (const [from, to] of Object.entries(profile.folds)) expect(lineFoldV1(`א${from}ב`)).toBe(`א${to}ב`);
  });

  it.each([
    ["maqaf to hyphen", "בית\u05beספר", "בית-ספר"],
    ["geresh and gershayim", "ר\u05f3 צה\u05f4ל", "ר' צה\"ל"],
    ["curly quotes", "\u201eשלום\u201d \u201cעולם\u201d", '"שלום" "עולם"'],
    ["em dash to en dash; en dash and hyphen kept", "א\u2014ב\u2013ג-ד", "א\u2013ב\u2013ג-ד"],
    ["whitespace runs collapse, ends strip", "\u00a0 א\t\tב\u2003 ג \u3000", "א ב ג"],
    ["Python's split separators U+001C-U+001F", "א\u001cב\u001fג", "א ב ג"],
    ["NFC first", "ש\u05c1\u05b8לום", "ש\u05b8\u05c1לום"],
    ["niqqud kept", "ש\u05b8\u05c1לו\u05b9ם", "ש\u05b8\u05c1לו\u05b9ם"],
  ])("%s", (_, input, out) => expect(lineFoldV1(input)).toBe(out));
});

describe("agreement values", () => {
  const cand = "הילד הלך\u05beלבית";
  it("exact is the candidate's text; edited and typed are their text; all under the fold", () => {
    expect(decisionValue({ value: "exact", text: null }, cand)).toBe(decisionValue({ value: "edited", text: "הילד  הלך-לבית" }, cand));
    expect(decisionValue({ value: "typed", text: "הילד הלך-לבית " }, "")).toBe(decisionValue({ value: "exact", text: null }, cand));
    expect(decisionValue({ value: "misaligned", text: "הילד הלך-לבית" }, "אחר")).toBe(decisionValue({ value: "exact", text: null }, cand));
  });

  it("print has niqqud is its own class, by its letters (the candidate's when none were typed)", () => {
    expect(decisionValue({ value: "pointed_print", text: null }, cand)).not.toBe(decisionValue({ value: "exact", text: null }, cand));
    expect(decisionValue({ value: "pointed_print", text: null }, cand)).toBe(decisionValue({ value: "pointed_print", text: "הילד הלך-לבית" }, "x"));
  });

  it("the non-text answers agree only with themselves", () => {
    const actions = ["unreadable", "not_one_line", "no_text", "continued"];
    for (const a of actions) for (const b of actions) expect(decisionValue({ value: a, text: null }, cand) === decisionValue({ value: b, text: null }, cand)).toBe(a === b);
    expect(decisionValue({ value: "misaligned", text: null }, cand)).toBe("misaligned");
    expect(decisionValue({ value: "unreadable", text: null }, cand)).not.toBe(decisionValue({ value: "typed", text: "unreadable" }, cand));
  });

  it("exports a reference as its class and text", () => {
    expect(referenceOf(decisionValue({ value: "typed", text: "א  ב" }, ""))).toEqual({ class: "text", text: "א ב" });
    expect(referenceOf("no_text")).toEqual({ class: "no_text", text: null });
  });
});

describe("routing", () => {
  const c = "שורה";
  it("waits for pass 1 and pass 2 from anyone", () => {
    expect(routeLine([], c, false)).toMatchObject({ resolution: "pending", next: "pass1", openTo: "anyone" });
    expect(routeLine([vote("a", "exact")], c, false)).toMatchObject({ resolution: "pending", next: "pass2", openTo: "anyone" });
  });

  it("two equal decisions agree; the pair is named", () => {
    expect(routeLine([vote("a", "exact"), vote("b", "edited", "שורה ")], c, false)).toEqual({
      resolution: "agreed",
      next: null,
      openTo: "nobody",
      reference: { value: "text\u0000שורה", pair: ["a", "b"] },
    });
  });

  it("a disagreement goes to a third; any pair then is a majority", () => {
    const two = [vote("a", "exact"), vote("b", "unreadable")];
    expect(routeLine(two, c, false)).toMatchObject({ resolution: "pending", next: "third", openTo: "anyone" });
    expect(routeLine([...two, vote("c", "unreadable")], c, false)).toMatchObject({ resolution: "majority", reference: { pair: ["b", "c"] } });
  });

  it("three different: to the maintainer, unless he has decided it; then a fourth volunteer", () => {
    const three = [vote("a", "exact"), vote("b", "unreadable"), vote("c", "no_text")];
    expect(routeLine(three, c, false)).toMatchObject({ resolution: "to_maintainer", next: "maintainer", openTo: "admin" });
    expect(routeLine(three, c, true)).toMatchObject({ resolution: "pending", next: "fourth", openTo: "non_admin" });
  });

  it("the fourth must make a pair; otherwise unresolved, and nobody is served it again", () => {
    const three = [vote("a", "exact"), vote("b", "unreadable"), vote("c", "no_text")];
    expect(routeLine([...three, vote("d", "no_text")], c, true)).toMatchObject({ resolution: "majority", reference: { pair: ["c", "d"] } });
    expect(routeLine([...three, vote("d", "continued")], c, false)).toMatchObject({ resolution: "unresolved", next: null, openTo: "nobody" });
  });
});
