import { describe, expect, it } from "vitest";
import { H_BATCH_ID, contextBox, convertH } from "../../scripts/lib/hconvert";
import { itemsFileProblems } from "../../src/tasks/line_verify/schema";

// A synthetic two-page v2 file and its manifest rows: invented ids, the registered file's shape.
const v2 = {
  schema: "h_line_items.v2",
  pages: [
    {
      page_key: "src_a__p0001",
      image: "data/scans/src_a/p0001.jpg",
      image_sha256: "a".repeat(64),
      image_size: [1000, 1400] as [number, number],
      segmenter: "blla",
      stratum: "primary",
      page_flag: null,
      lines: [
        { id: "v1:1", i: 1, box: [100, 300, 900, 340] as [number, number, number, number] },
        { id: "v1:0", i: 0, box: [100, 200, 900, 240] as [number, number, number, number] },
      ],
    },
    {
      page_key: "src_b__p0002",
      image: "data/scans/src_b/p0002.png",
      image_sha256: "b".repeat(64),
      image_size: [800, 600] as [number, number],
      segmenter: "legacy",
      stratum: "seen_writer",
      page_flag: "poor_boxes",
      lines: [{ id: "j:v1:0+v1:1", i: 0, box: [50, 10, 750, 60] as [number, number, number, number] }],
    },
  ],
};
const row = (entry_id: string, source_id: string, license_expression: string) => ({
  entry_id,
  title: "A letter",
  holding_institution: "A library",
  holding_shelfmark: null,
  provider: "A provider",
  source_id,
  source_url: "https://example.org/item",
  license_expression,
  rights_basis: "public_domain",
  attribution: null,
  sequence: { label: "p1" },
});
const manifest = [row("src_a__p0001", "src_a", "PDM-1.0"), row("src_b__p0002", "src_b", "LicenseRef-Public-Domain-Israel")];

describe("H line boxes v2 → line_verify typed lines", () => {
  it("makes one type item per v2 line, in v2's reading order, with v2's ids and boxes and no candidate", () => {
    const out = convertH(v2, manifest);
    expect(out.batch_id).toBe(H_BATCH_ID);
    const items = out.items as Record<string, unknown>[];
    expect(items.map((i) => [i.item_id, i.line_index, i.box])).toEqual([
      ["src_a__p0001#v1:0", 0, [100, 200, 900, 240]],
      ["src_a__p0001#v1:1", 1, [100, 300, 900, 340]],
      ["src_b__p0002#j:v1:0+v1:1", 0, [50, 10, 750, 60]],
    ]);
    expect(items.every((i) => i.kind === "type" && i.candidate_text === null)).toBe(true);
    const pages = out.pages as Record<string, unknown>[];
    expect(pages.map((p) => [p.image, p.source, p.script, p.release_split, p.kraken_lines, p.book_group])).toEqual([
      ["pages/src_a__p0001.jpg", "hash_eval", "handwriting", "test", 2, "primary"],
      ["pages/src_b__p0002.png", "hash_eval", "handwriting", "test", 1, "seen_writer"],
    ]);
    expect(pages[1]!.text_license).toBe("Public domain (LicenseRef-Public-Domain-Israel)");
  });

  it("is a valid line_verify_items.v1.2 file", () => {
    expect(itemsFileProblems(convertH(v2, manifest))).toEqual([]);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(convertH(v2, manifest))).toBe(JSON.stringify(convertH(v2, manifest)));
  });

  it("keeps the context band inside the page", () => {
    expect(contextBox([10, 20, 90, 60], 100)).toEqual([10, 0, 90, 100]);
    expect(contextBox([10, 400, 90, 440], 1000)).toEqual([10, 340, 90, 500]);
  });

  it("refuses a page missing from the manifest, a page not in the public domain, or a gap in the line order", () => {
    expect(() => convertH(v2, manifest.slice(0, 1))).toThrow(/not in the h_eval_v1 manifest/);
    expect(() => convertH(v2, [{ ...manifest[0]!, rights_basis: "licensed" }, manifest[1]!])).toThrow(/public_domain/);
    const gap = structuredClone(v2);
    gap.pages[0]!.lines[0]!.i = 2;
    expect(() => convertH(gap, manifest)).toThrow(/0\.\.n-1/);
    expect(() => convertH({ ...v2, schema: "h_line_items.v1" }, manifest)).toThrow(/h_line_items\.v2/);
  });
});
