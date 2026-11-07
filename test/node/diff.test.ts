import { describe, expect, it } from "vitest";
import { diffText, sides } from "../../src/shared/diff";
import { codePoints, visibleTokens } from "../../src/shared/visible";

describe("diffText", () => {
  it("marks a single changed letter", () => {
    expect(diffText("הוא", "היא")).toEqual([
      { op: "equal", text: "ה" },
      { op: "delete", text: "ו" },
      { op: "insert", text: "י" },
      { op: "equal", text: "א" },
    ]);
  });

  it("marks a moved space as one deletion and one insertion", () => {
    const d = diffText("ודונג ,אם", "ודונג, אם");
    expect(d.filter((s) => s.op !== "equal").map((s) => s.op).sort()).toEqual(["delete", "insert"]);
    const { before, after } = sides(d);
    expect(before.map((s) => s.text).join("")).toBe("ודונג ,אם");
    expect(after.map((s) => s.text).join("")).toBe("ודונג, אם");
  });

  it("keeps a letter and its niqqud together", () => {
    const d = diffText("בָּרָא", "בָּרְא");
    expect(d.find((s) => s.op === "delete")!.text).toBe("רָ");
  });

  it("handles insertion into empty and deletion to empty", () => {
    expect(diffText("", "ו")).toEqual([{ op: "insert", text: "ו" }]);
    expect(diffText("[מלה לא ברורה]", "")).toEqual([{ op: "delete", text: "[מלה לא ברורה]" }]);
  });
});

describe("visibleTokens", () => {
  it("shows spaces, no-break spaces and direction marks", () => {
    const tokens = visibleTokens("א b ‏");
    expect(tokens.map((t) => t.kind)).toEqual(["text", "space", "text", "special", "special"]);
    expect(tokens.map((t) => t.shown).join("")).toBe("א␣b⍽⟨RLM⟩");
  });

  it("flags presentation-form letters that look ordinary", () => {
    const [t] = visibleTokens("ﬠ");
    expect(t!.kind).toBe("special");
    expect(t!.label).toContain("U+FB20");
  });

  it("lists code points", () => {
    expect(codePoints("ע ")).toBe("U+05E2 U+0020");
  });
});
