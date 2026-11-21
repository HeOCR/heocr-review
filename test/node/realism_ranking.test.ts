import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { fitRanking } from "../../scripts/lib/fit-realism-ranking";
import { parseRankingManifest, validateRankingModalities } from "../../src/tasks/synth_realism/ranking";
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

it("requires one connected graph per used modality and verifies matched controls against the pinned sidecar", () => {
  const parsed = parseRankingManifest({
    ...manifest,
    images: [...manifest.images,
      { item_id: "synth-c", arm_id: "c", path: "images/d.jpg", sha256: pin("e") },
      { item_id: "synth-d", arm_id: "d", path: "images/e.jpg", sha256: pin("f") }],
    pairs: [...manifest.pairs, { pair_id: "phone", item_a: "synth-c", item_b: "synth-d" }],
  }, clearance);
  const sha = pin("1");
  const sidecar = {
    schema: "realism_ranking_modalities.v1", manifest_sha256: sha,
    items: { "synth-a": "scan", "synth-b": "scan", "real-a": "scan", "synth-c": "phone", "synth-d": "phone" },
  };
  const check = (items: Record<string, string>) => validateRankingModalities(parsed, sha, { ...sidecar, items });
  expect(check(sidecar.items)).toEqual({
    armModalities: { a: "scan", b: "scan", c: "phone", d: "phone" },
    counts: [{ modality: "scan", arms: 2, pairs: 2, standard: 1 }, { modality: "phone", arms: 2, pairs: 1, standard: 1 }],
  });
  expect(() => check({ ...sidecar.items, "synth-d": "scan" })).toThrow("mixes scan and phone");
  expect(() => check({ ...sidecar.items, "real-a": "phone" })).toThrow("mixes scan and phone");
  expect(() => check({ ...sidecar.items, "synth-c": "scan", "synth-d": "scan" })).toThrow("one connected synthetic graph");
  expect(() => validateRankingModalities(parsed, pin("2"), sidecar)).toThrow("manifest pin");
  expect(() => validateRankingModalities({
    ...parsed, images: parsed.images.map(image => image.item_id === "synth-d" ? { ...image, arm_id: "b" } : image),
  }, sha, sidecar)).toThrow("arm spans multiple modalities");
});

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

const rank = (id: string, a: string | null, b: string | null, choice: RankingRow["choice"], tie_available: 0 | 1 = 1): RankingRow => ({
  pair_id: id, item_a: "img-1", arm_a: a, item_b: "img-2", arm_b: b, reviewer: "rv_fixture",
  swapped: 0, choice, tie_available, latency_ms: 36, chosen_at: 1,
});

it("fits Davidson separately and counts ties by unordered arm pair and by control kind", () => {
  const rows = [rank("a-won", "a", "b", 0), rank("a-tied", "b", "a", 2), rank("phone-win", "c", "d", 0),
    rank("control-win", null, "a", 0), rank("control-tie", "a", null, 2),
    rank("real-real-tie", null, null, 2), rank("real-real-right", null, null, 1),
    rank("forced-win", "a", "b", 0, 0), rank("forced-control-miss", null, "a", 1, 0)];
  const fit = (results: RankingRow[]) => fitRanking(rankingExport("fixture", results, new Date(0).toISOString(), true,
    { a: "scan", b: "scan", c: "phone", d: "phone" }));
  const report = fit(rows);
  expect(report.components).toMatchObject([
    { modality: "scan", model: "davidson", comparisons: 3, ties: 1, tie_log_propensity: expect.any(Number) },
    { modality: "phone", model: "bradley_terry", comparisons: 1, ties: 0, tie_log_propensity: null },
  ]);
  expect(report.components[0]!.arms.map(a => a.arm_id)).toEqual(["a", "b"]);
  expect(report.arm_pair_ties).toEqual([
    { modality: "scan", arm_a: "a", arm_b: "b", answered: 3, tie_eligible: 2, ties: 1, tie_rate: 0.5 },
    { modality: "phone", arm_a: "c", arm_b: "d", answered: 1, tie_eligible: 1, ties: 0, tie_rate: 0 },
  ]);
  expect(report.controls).toMatchObject({
    overall: { answered: 5, tie_eligible: 4, ties: 2, tie_rate: 0.5 },
    real_synth: { answered: 3, tie_eligible: 2, ties: 1, decisive: 2, correct: 1, accuracy: 0.5, tie_rate: 0.5 },
    real_real: { answered: 2, ties: 1, chose_left: 0, chose_right: 1, tie_rate: 0.5 },
  });
  const allTies = fit([rank("all-tied", "a", "b", 2), rank("tied-control", null, "a", 2)]);
  expect(allTies.components[0]!.arms.map(x => x.centered_log_strength)).toEqual([0, 0]);
  expect(allTies.controls.real_synth).toMatchObject({ ties: 1, decisive: 0, accuracy: null, wilson_95: null });
});

it("migrates saved left/right and undone ranking rows unchanged, then accepts a timed tie", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE batches(id TEXT PRIMARY KEY); CREATE TABLE reviewers(id TEXT PRIMARY KEY);");
    db.exec(readFileSync("migrations/0020_realism_ranking.sql", "utf8"));
    db.exec(`INSERT INTO batches VALUES ('fixture');
      INSERT INTO reviewers VALUES ('reviewer');
      INSERT INTO synth_ranking_pairs VALUES
        ('fixture',1,'p1','a','one','left','b','two','right'),
        ('fixture',2,'p2','b','two','right','a','one','left'),
        ('fixture',3,'p3','a','one','left','b','two','right');
      INSERT INTO synth_ranking_answers VALUES
        ('fixture','reviewer',1,1,0,1,17,100),
        ('fixture','reviewer',2,1,1,0,19,105),
        ('fixture','reviewer',3,2,NULL,1,NULL,NULL);`);
    const snapshot = () => db.prepare("SELECT batch_id,reviewer_id,position,revision,choice,swapped,latency_ms,chosen_at FROM synth_ranking_answers ORDER BY position").all();
    const before = snapshot();
    db.exec(readFileSync("migrations/0021_realism_ranking_ties.sql", "utf8"));
    expect(snapshot()).toEqual(before);
    expect(db.prepare("SELECT SUM(tie_available) AS offered FROM synth_ranking_answers").get()?.offered).toBe(0);
    expect(() => db.exec("UPDATE synth_ranking_answers SET choice=2 WHERE position=3")).toThrow("CHECK");
    expect(() => db.exec("UPDATE synth_ranking_answers SET choice=2,latency_ms=23,chosen_at=110 WHERE position=3")).toThrow("CHECK");
    db.exec("UPDATE synth_ranking_answers SET choice=2,tie_available=1,latency_ms=23,chosen_at=110 WHERE position=3");
    expect(snapshot()[2]).toMatchObject({ choice: 2, revision: 2, latency_ms: 23, chosen_at: 110 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});

it("fits regularized Bradley–Terry intervals under separation and reports controls independently", () => {
  const standard = Array.from({ length: 12 }, (_, i) => rank(`std-${i}`, "a", "b", 0));
  const rows = [...standard, rank("c-1", null, "b", 0), rank("c-2", null, "a", 1), rank("c-3", null, null, 1)];
  const fit = (observations: RankingRow[]) => fitRanking(rankingExport("fixture", observations, new Date(0).toISOString(), true,
    { a: "scan", b: "scan", c: "phone", d: "phone" }));
  const report = fit(rows);
  expect(report.cross_component_ranks_identifiable).toBe(false); // No phone answers yet.
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
  expect(fit([...rows, rank("phone", "c", "d", 1)])).toMatchObject({
    cross_component_ranks_identifiable: false, components: [{ modality: "scan", comparisons: 12 }, { modality: "phone", comparisons: 1 }],
  });
  expect(() => fit([...rows, rank("mixed", "a", "c", 1)])).toThrow("mixed-modality comparison");
  expect(() => fitRanking(rankingExport("fixture", rows, new Date(0).toISOString(), true, undefined))).toThrow("pinned modality map");
});
