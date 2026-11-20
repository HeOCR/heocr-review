import { describe, expect, it } from "vitest";
import { MIN_LEGIBLE_INK, stripPieces } from "../../src/web/views/line";

// A 4000 px wide page; a full-width line 50 px of ink tall (box as page fractions).
const img = { url: "x", width: 4000, height: 5000, box: null } as never;
const longLine: [number, number, number, number] = [0.02, 0.5, 0.98, 0.51];

describe("one continuous strip on a desktop whenever it stays legible", () => {
  it("keeps a full-width line in one piece on a wide column", () => {
    expect(stripPieces(img, longLine, 1500, true, false)).toBe(1);
  });

  it("splits only when one strip would shrink the ink below the legible height", () => {
    // 3880 px of line for 50 px of ink: one strip at width w has ink 50 * w / 3880.
    const w = Math.floor((MIN_LEGIBLE_INK * 3920) / 50) - 50;
    expect(stripPieces(img, longLine, w, true, false)).toBe(2);
  });

  it("keeps the phone's two pieces, or one with Fit width", () => {
    expect(stripPieces(img, longLine, 380, false, false)).toBe(2);
    expect(stripPieces(img, longLine, 380, false, true)).toBe(1);
  });
});
