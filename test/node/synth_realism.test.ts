import { describe, expect, it } from "vitest";
import { parseManifest, verifyClearance } from "../../src/tasks/synth_realism/schema";
import { realismExport, type RealismRow } from "../../src/tasks/synth_realism/export";

const image = (name: string, hex: string) => ({ path: `images/${name}.jpg`, sha256: hex.repeat(64) });
const item = {
  item_id: "pair-1", control_kind: "standard", generator_id: "gen", generator_version: "v3", params_hash: "6".repeat(64),
  real_ref_id: "dev-a", synthetic_image: image("a", "1"), synthetic_line_crop: image("al", "2"),
  real_ref_image: image("b", "3"), real_ref_line_crop: image("bl", "4"),
};
const manifest = { schema: "synth_realism_manifest.v1", batch_id: "pilot", items: [item] };
const clearance = {
  schema: "synth_realism_clearance.v1",
  references: [{ id: "dev-a", source: "public-dev-corpus", license: "CC BY 4.0", split: "dev", page_sha256: "3".repeat(64), line_sha256: "4".repeat(64) }],
};

describe("realism bundle contract", () => {
  it("requires clearance for both the scan and its exact crop", () => {
    const valid = parseManifest(manifest);
    expect(() => verifyClearance(clearance, valid)).not.toThrow();
    expect(() => verifyClearance({ ...clearance, references: [{ ...clearance.references[0]!, split: "test" }] }, valid)).toThrow(/train\/dev/);
    expect(() => verifyClearance(clearance, parseManifest({ ...manifest, items: [{ ...item, real_ref_line_crop: image("other", "5") }] }))).toThrow(/must match/);
    expect(() => parseManifest({ ...manifest, items: [{ ...item, real_ref_image: { ...item.real_ref_image, path: "images/../real.jpg" } }] })).toThrow();
    expect(() => parseManifest({ ...manifest, items: [{ ...item, control_kind: "attention" }] })).toThrow(/control counts/);
  });

  it("computes Wilson bounds with controls excluded and preserves incomplete decisions", () => {
    const row: RealismRow = { item_id: "a", generator_id: "gen", generator_version: "v1", params_hash: "cfg", control_kind: "standard",
      reviewer: "rv_a", swapped: 0, choice: 0, chosen_at: 100, latency_ms: 23, score: 8, tags_json: '["too_clean"]', comment: null, completed_at: 150 };
    const result = realismExport("pilot", [row, { ...row, item_id: "b", choice: 1, score: null, tags_json: null, completed_at: null },
      { ...row, item_id: "c", control_kind: "real_real", score: 1 }, { ...row, item_id: "d", control_kind: "attention", choice: 1, score: 1 }],
    "2026-11-20T00:00:00.000Z", false);
    expect(result.generators).toMatchObject([{ choices: 2, fooled: 1, fooling_rate: .5, scored: 1, mean_score: 8, tag_counts: { too_clean: 1 } }]);
    expect(result.generators[0]!.wilson_95[0]).toBeCloseTo(.0945, 3);
    expect(result.generators[0]!.wilson_95[1]).toBeCloseTo(.9055, 3);
    expect(result.decisions.map((d) => d.correct)).toEqual([false, true, null, true]);
    expect(result.controls).toEqual({ real_real: { choices: 1, rejected_left: 0, rejected_right: 1 }, attention: { choices: 1, correct: 1 } });
    expect(realismExport("fixture", [row], "2026-11-20T00:00:00.000Z", true).generators).toEqual([]);
  });
});
