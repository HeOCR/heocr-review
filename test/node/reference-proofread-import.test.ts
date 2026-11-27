import { expect, it } from "vitest";
import { proofreadBundle, proofreadDigest } from "../../scripts/lib/reference-proofread-import";

it("preserves sealed scan text and orders the hard positions before agreed ones", () => {
  const before = ["נוֹסָח ישן", "[?]", "שורה אחרונה", "פתיחה"];
  const positions = [
    { leaf: "leaf-a", region: 1, ordinal: 1, hard: false },
    { leaf: "leaf-a", region: 1, ordinal: 2, hard: true },
    { leaf: "leaf-a", region: 2, ordinal: 3, hard: true },
    { leaf: "leaf-b", region: 1, ordinal: 1, hard: false },
  ];
  const manifest = {
    schema: "reference_proofread.v1",
    reference_sha256: proofreadDigest(before.join("\n") + "\n"),
    rows: positions.map((row, i) => ({ ...row, position: i + 1, before: before[i], crop_sha256: "a".repeat(64), width: 80, height: 30 })),
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
  expect(result.bundle.items).toHaveLength(3);
  expect(result.hard).toBe(2);

  expect(() => proofreadBundle(raw, "b".repeat(64), id, "Invented test")).toThrow(/manifest pin/);
  manifest.rows[0]!.before = "שכתוב";
  const repinned = Buffer.from(JSON.stringify(manifest));
  expect(() => proofreadBundle(repinned, proofreadDigest(repinned), id, "Invented test")).toThrow(/sealed reference/);
});
