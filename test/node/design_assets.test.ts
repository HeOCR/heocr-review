import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ICONS } from "../../src/web/icons.gen";
import STRINGS from "../../src/web/strings.json";

describe("the app's design assets match design/review (HeOCR/heocr-review#51)", () => {
  it("keeps the design's string keys, so the maintainer's review of design/review/strings.json applies to the app", () => {
    const design = JSON.parse(readFileSync("design/review/strings.json", "utf8")) as Record<string, unknown>;
    for (const key of Object.keys(design)) expect(STRINGS, key).toHaveProperty(key);
  });

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

  it("has no gold branch in the line screens: a gold line is drawn exactly like any other (SPEC §4.1)", () => {
    for (const f of ["src/web/views/line.ts", "src/web/views/consensus.ts", "src/web/views/taskparts.ts"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/gold/i);
  });
});
