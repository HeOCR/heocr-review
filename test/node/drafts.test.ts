import { describe, expect, it } from "vitest";
import { checkDraft } from "../../src/worker/drafts";

const shown = new Set([0, 2, 3]);
const row = (over: Record<string, unknown> = {}) => ({ src: [0], action: "edit", text: "שורה", looked: true, ...over });

describe("checkDraft", () => {
  it("keeps the draft's fields only", () => {
    const r = checkDraft({ readingOrder: false, rows: [{ ...row(), extra: "x" }, row({ src: [2, 3], action: "merge" }), row({ src: [], action: "added" })] }, shown);
    expect(r).toEqual({
      ok: true,
      body: {
        readingOrder: false,
        rows: [row(), row({ src: [2, 3], action: "merge" }), row({ src: [], action: "added" })],
      },
    });
  });

  it.each([
    ["no readingOrder", { rows: [] }, "readingOrder"],
    ["a line the page does not show", { readingOrder: true, rows: [row({ src: [1] })] }, "src must be lines of this page"],
    ["an unknown action", { readingOrder: true, rows: [row({ action: "guess" })] }, "unknown action"],
    ["a non-string text", { readingOrder: true, rows: [row({ text: 5 })] }, "text must be"],
    ["no looked", { readingOrder: true, rows: [row({ looked: undefined })] }, "looked"],
  ])("refuses %s", (_name, input, needle) => {
    const r = checkDraft(input as Record<string, unknown>, shown);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(needle);
  });
});
