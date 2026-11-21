import { expect, it } from "vitest";
import { fitRanking } from "../../scripts/lib/fit-realism-ranking";
import { parseRankingManifest } from "../../src/tasks/synth_realism/ranking";
import { rankingExport, type RankingRow } from "../../src/tasks/synth_realism/ranking-export";

const pin = (c: string) => c.repeat(64);
const clearance = {
  schema: "synth_realism_clearance.v1",
  references: [{ id: "genuine", split: "train", source: "invented fixture", license: "CC0",
    page_sha256: pin("a"), line_sha256: pin("b") }],
};
const manifest = {
  schema: "realism_ranking_manifest.v1", batch_id: "invented", title: "Fixture",
  images: [
    { item_id: "synth-a", arm_id: "a", path: "images/a.jpg", sha256: pin("c") },
    { item_id: "synth-b", arm_id: "b", path: "images/b.jpg", sha256: pin("d") },
    { item_id: "real-a", arm_id: null, path: "images/c.jpg", sha256: pin("a"), real_ref_id: "genuine" },
  ],
  pairs: [{ pair_id: "pair-1", item_a: "synth-a", item_b: "synth-b" }, { pair_id: "pair-2", item_a: "synth-b", item_b: "real-a" }],
};

it("pins real controls to TRAIN and allows separate comparison components", () => {
  expect(parseRankingManifest(manifest, clearance)).toEqual(manifest);
  const dev = JSON.parse(JSON.stringify(clearance));
  dev.references[0].split = "dev";
  expect(() => parseRankingManifest(manifest, dev)).toThrow("TRAIN");
  const mismatch = JSON.parse(JSON.stringify(manifest));
  mismatch.images[2].sha256 = pin("1");
  expect(() => parseRankingManifest(mismatch, clearance)).toThrow("TRAIN");
  const repeat = { ...manifest, pairs: [...manifest.pairs, { pair_id: "repeat", item_a: "real-a", item_b: "synth-b" }] };
  expect(() => parseRankingManifest(repeat, clearance)).toThrow("repeated");
  const disconnected = {
    ...manifest, images: [...manifest.images, { item_id: "synth-c", arm_id: "c", path: "images/d.jpg", sha256: pin("e") }],
    pairs: [...manifest.pairs, { pair_id: "unconnected", item_a: "real-a", item_b: "synth-c" }],
  };
  expect(() => parseRankingManifest(disconnected, clearance)).toThrow("cross-arm comparisons for every arm");
  expect(parseRankingManifest({
    ...disconnected,
    images: [...disconnected.images, { item_id: "synth-d", arm_id: "d", path: "images/e.jpg", sha256: pin("f") }],
    pairs: [...disconnected.pairs, { pair_id: "component-2", item_a: "synth-c", item_b: "synth-d" }],
  }, clearance).images).toHaveLength(5);
});

const rank = (id: string, a: string | null, b: string | null, choice: 0 | 1): RankingRow => ({
  pair_id: id, item_a: "img-1", arm_a: a, item_b: "img-2", arm_b: b, reviewer: "rv_fixture",
  swapped: 0, choice, latency_ms: 36, chosen_at: 1,
});

it("fits regularized Bradley–Terry intervals under separation and reports controls independently", () => {
  const standard = Array.from({ length: 12 }, (_, i) => rank(`std-${i}`, "a", "b", 0));
  const rows = [...standard, rank("c-1", null, "b", 0), rank("c-2", null, "a", 1), rank("c-3", null, null, 1)];
  const fit = (observations: RankingRow[]) => fitRanking(rankingExport("fixture", observations, new Date(0).toISOString(), true));
  const report = fit(rows);
  expect(report.components).toEqual(fit(standard).components);
  expect(report.standard_pairs).toBe(12);
  expect(report.controls).toMatchObject({ real_synth: { answered: 2, correct: 1, accuracy: 0.5 },
    real_real: { answered: 1, chose_left: 0, chose_right: 1 } });
  const arms = report.components[0]!.arms;
  expect(arms.map(a => a.arm_id)).toEqual(["a", "b"]);
  expect(arms[0]!.centered_log_strength).toBeGreaterThan(0);
  expect(arms[0]!.centered_log_strength + arms[1]!.centered_log_strength).toBeCloseTo(0);
  for (const arm of arms) {
    expect(arm.laplace_95[0]).toBeLessThan(arm.centered_log_strength);
    expect(arm.laplace_95[1]).toBeGreaterThan(arm.centered_log_strength);
  }
  const flipped = fit(rows.map(row => ({ ...row, swapped: 1, choice: row.choice === 0 ? 1 : 0 }))).components[0]!.arms;
  for (const [i, arm] of arms.entries()) {
    expect(flipped[i]!.arm_id).toBe(arm.arm_id);
    expect(flipped[i]!.centered_log_strength).toBeCloseTo(arm.centered_log_strength, 10);
    expect(flipped[i]!.laplace_95[0]).toBeCloseTo(arm.laplace_95[0]!, 10);
    expect(flipped[i]!.laplace_95[1]).toBeCloseTo(arm.laplace_95[1]!, 10);
  }
  expect(fit([...rows, rank("island", "c", "d", 1)])).toMatchObject({ cross_component_ranks_identifiable: false });
});
