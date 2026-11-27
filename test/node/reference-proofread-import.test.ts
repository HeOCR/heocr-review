import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { proofreadBundle, proofreadDigest, proofreadMedia } from "../../scripts/lib/reference-proofread-import";

it("preserves sealed scan text and orders the hard positions before agreed ones", () => {
  const before = ["נוֹסָח ישן", "[?]", "שורה אחרונה", "פתיחה"];
  const positions = [
    { leaf: "leaf-a", region: 1, ordinal: 1, hard: false },
    { leaf: "leaf-a", region: 1, ordinal: 2, hard: true },
    { leaf: "leaf-a", region: 2, ordinal: 3, hard: true },
    { leaf: "leaf-b", region: 1, ordinal: 1, hard: false },
  ];
  const manifest = {
    schema: "reference_proofread.v2",
    regions: positions.filter((row, i) => i !== 1).map(row => ({ leaf: row.leaf, region: row.region, sha256: "b".repeat(64), width: 80, height: row.leaf === "leaf-a" && row.region === 1 ? 60 : 30 })),
    reference_sha256: proofreadDigest(before.join("\n") + "\n"),
    rows: positions.map((row, i) => ({ ...row, position: i + 1, before: before[i], crop_sha256: "a".repeat(64), region_sha256: "b".repeat(64), model_output: "hidden", lane_name: "lane", score: 12, result: "other reading", width: 80, height: 30, box: [0, i === 1 ? 30 : 0, 80, i === 1 ? 60 : 30] })),
  };
  const raw = Buffer.from(JSON.stringify(manifest));
  const id = "private-ref-proofread-fixture";
  const result = proofreadBundle(raw, proofreadDigest(raw), id, "Invented test");
  expect(result.bundle.proposals.map(p => [p.externalId, p.payload.candidate_text, p.payload.split, p.payload.trainable])).toEqual([
    ["leaf-a-2", "[?]", "test", false],
    ["leaf-a-3", "שורה אחרונה", "test", false],
    ["leaf-a-1", "נוֹסָח ישן", "test", false],
    ["leaf-b-1", "פתיחה", "test", false],
  ]);
  for (const p of result.bundle.proposals) {
    expect(Object.keys(p.payload).sort()).toEqual([
      "candidate_text", "crop_sha256", "leaf", "line_index", "order", "pass", "region", "region_sha256", "slice_box", "split", "trainable",
    ]);
    expect(p.category).toBe("proofread");
    expect(p.confidence).toBe("");
  }
  expect(result.bundle.items).toHaveLength(3);
  expect(result.hard).toBe(2);

  expect(() => proofreadBundle(raw, "b".repeat(64), id, "Invented test")).toThrow(/manifest pin/);
  manifest.rows[0]!.region_sha256 = "a".repeat(64);
  const repinnedWrongRegion = Buffer.from(JSON.stringify(manifest));
  expect(() => proofreadBundle(repinnedWrongRegion, proofreadDigest(repinnedWrongRegion), id, "Invented test")).toThrow(/region pin or slice box/);
  manifest.rows[0]!.region_sha256 = "b".repeat(64);
  manifest.rows[0]!.before = "שכתוב";
  const repinned = Buffer.from(JSON.stringify(manifest));
  expect(() => proofreadBundle(repinned, proofreadDigest(repinned), id, "Invented test")).toThrow(/sealed reference/);
});

it("rejects a dimension-matched, correctly rehashed crop whose pixels differ from the sealed region", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proofread-pixels-"));
  const batch = "private-ref-proofread-fixture";
  const create = (background: string) => ({ width: 8, height: 3, channels: 3 as const, background });
  try {
    const parent = await sharp({ create: create("white") }).png().toBuffer();
    const wrong = await sharp({ create: create("black") }).png().toBuffer();
    const region = { leaf: "leaf-a", region: 1, sha256: proofreadDigest(parent), width: 8, height: 3 };
    const before = "נוסח בדיקה";
    const manifest = {
      schema: "reference_proofread.v2", regions: [region], reference_sha256: proofreadDigest(before + "\n"),
      rows: [{ leaf: "leaf-a", region: 1, position: 1, ordinal: 1, hard: false, before,
        region_sha256: region.sha256, crop_sha256: proofreadDigest(wrong), width: 8, height: 3, box: [0, 0, 8, 3] }],
    };
    writeFileSync(join(dir, region.sha256 + ".png"), parent);
    writeFileSync(join(dir, proofreadDigest(wrong) + ".png"), wrong);
    const bundle = () => {
      const raw = Buffer.from(JSON.stringify(manifest));
      return proofreadBundle(raw, proofreadDigest(raw), batch, "Invented test");
    };
    await expect(proofreadMedia(bundle(), dir)).rejects.toThrow(/not the lossless slice/);
    manifest.rows[0]!.crop_sha256 = region.sha256;
    expect((await proofreadMedia(bundle(), dir)).objects.size).toBe(1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
