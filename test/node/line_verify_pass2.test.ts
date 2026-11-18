import { describe, expect, it } from "vitest";
import { settingProblem } from "../../scripts/batch-setting";
import { normalizeTypedDecision } from "../../src/tasks/line_verify";
import { decisionsFileProblems } from "../../src/tasks/line_verify/schema";

const ITEM = "wikisource_he:x__p0001#L001";
const items = [{ item_id: ITEM, candidate_text: "שורה", blind: true }];
const file = (d: Record<string, unknown>) => ({
  schema_version: "line_verify_decisions.v1.2",
  batch_id: "b",
  decisions: [{ decision_id: `decision:${ITEM}@pass2:rv_1a2b3c4d`, item_id: ITEM, reviewer: "rv_1a2b3c4d", pass: 2, same_reviewer: true, decided_at: "2026-11-18", checked_by: "human", ...d }],
});

describe("blind second pass decisions (v1.2)", () => {
  it.each([
    [{ decision: "typed", text: "שורה" }],
    [{ decision: "typed", text: "שורה אחרת" }],
    [{ decision: "pointed_print", text: "שורה" }],
    [{ decision: "unreadable" }],
    [{ decision: "misaligned" }],
  ])("accepts %j", (d) => expect(decisionsFileProblems(file(d), "b", items)).toEqual([]));

  it.each([
    [{ decision: "exact" }, "a pass-2 decision must be one of"],
    [{ decision: "edited", text: "x" }, "a pass-2 decision must be one of"],
    [{ decision: "typed" }, "text must be a string"],
    [{ decision: "pointed_print" }, "text must be a string"],
    [{ decision: "typed", text: "שָׁלוֹם" }, "letters only"],
    [{ decision: "unreadable", text: "x" }, "only a typed or pointed_print decision carries text"],
    [{ decision: "typed", text: "x", same_reviewer: "yes" }, "same_reviewer is a boolean"],
  ])("refuses %j", (d, message) => expect(decisionsFileProblems(file(d), "b", items).join("\n")).toContain(message));

  it("refuses same_reviewer on pass 1, and pass-1 values like typed", () => {
    const one = { decision_id: `decision:${ITEM}:rv_1a2b3c4d`, item_id: ITEM, reviewer: "rv_1a2b3c4d", pass: 1, decided_at: "2026-11-18", checked_by: "human" };
    const f = (d: Record<string, unknown>) => ({ schema_version: "line_verify_decisions.v1.2", batch_id: "b", decisions: [{ ...one, ...d }] });
    expect(decisionsFileProblems(f({ decision: "exact" }), "b", items)).toEqual([]);
    expect(decisionsFileProblems(f({ decision: "exact", same_reviewer: true }), "b", items).join("\n")).toContain("same_reviewer");
    expect(decisionsFileProblems(f({ decision: "typed", text: "שורה" }), "b", items).join("\n")).toContain("decision must be one of");
  });

  it("normalizes what the reviewer typed: NFC, trimmed, one line, letters only", () => {
    expect(normalizeTypedDecision("typed", "  שורה  ")).toEqual({ ok: true, value: "typed", text: "שורה" });
    expect(normalizeTypedDecision("pointed_print", "שורה")).toEqual({ ok: true, value: "pointed_print", text: "שורה" });
    expect(normalizeTypedDecision("unreadable", undefined)).toEqual({ ok: true, value: "unreadable", text: null });
    for (const [v, t] of [["typed", undefined], ["typed", "  "], ["typed", "שָׁלוֹם"], ["typed", "א\nב"], ["exact", undefined], ["edited", "x"], ["misaligned", "x"]] as const) {
      expect(normalizeTypedDecision(v, t).ok, `${v} ${String(t)}`).toBe(false);
    }
  });
});

describe("batch-setting", () => {
  const row = { id: "b", task_type: "line_verify", pass2_reviewer: "same", updated_at: null, updated_by: null };
  it("changes pass2_reviewer on line_verify batches only, and says who", () => {
    expect(settingProblem(row, "other", "heocr-lead")).toBeNull();
    expect(settingProblem(row, "same", "heocr-lead")).toBeNull();
    expect(settingProblem(undefined, "other", "x")).toBe("no such batch");
    expect(settingProblem(row, "anyone", "x")).toContain("must be one of");
    expect(settingProblem({ ...row, task_type: "page_review" }, "other", "x")).toContain("line_verify batches only");
    expect(settingProblem(row, "other", " ")).toContain("--by");
  });
});
