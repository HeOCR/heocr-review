import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ICONS } from "../../src/web/icons.gen";

describe("the app's design assets match design/review (HeOCR/heocr-review#51)", () => {
  it("has every icon in the design, and mirrors exactly Previous, Skip, Back and Sign out in Hebrew", () => {
    const files = readdirSync("design/review/icons").filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)).sort();
    expect(Object.keys(ICONS).sort()).toEqual(files);
    const flipped = Object.entries(ICONS).filter(([, v]) => v.flip).map(([k]) => k).sort();
    expect(flipped).toEqual(["back", "previous", "sign-out", "skip"]);
  });

  it("has icons up to date with design/review/icons (run node scripts/gen-icons.mjs after an icon changes)", () => {
    for (const [name, def] of Object.entries(ICONS)) {
      const svg = readFileSync(`design/review/icons/${name}.svg`, "utf8");
      expect((svg.match(/<(rect|path|circle|line|polyline|polygon|ellipse)\b/g) ?? []).length, name).toBe(def.shapes.length);
    }
  });

  it("serves the design's stylesheets and fonts byte for byte", () => {
    for (const f of ["tokens.css", "fonts.css", "review.css"]) expect(readFileSync(`public/css/${f}`, "utf8"), f).toBe(readFileSync(`design/review/css/${f}`, "utf8"));
    for (const f of readdirSync("design/review/fonts").filter((x) => x.endsWith(".woff2"))) {
      expect(readFileSync(`public/fonts/${f}`).equals(readFileSync(`design/review/fonts/${f}`)), f).toBe(true);
    }
  });
});
