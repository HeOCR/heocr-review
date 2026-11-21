import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { summarizeCaptureExif } from "../../scripts/capture-exif-summary";
import { trainCaptureRoot } from "../../src/shared/registered-captures";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

it("counts only active, hash-verified originals and returns aggregate EXIF without embedded tags", async () => {
  const dir = await mkdtemp(join(tmpdir(), "capture-exif-fixture-"));
  try {
    const page = "TRAIN-FIXTURE-01";
    const roster = Buffer.from(JSON.stringify({
      schema: "train_phone_captures.v1", pack_sha256: "a".repeat(64), source_manifest_sha256: "b".repeat(64),
      pages: [{ page_id: page, slots: ["FLAT", "OBLIQUE", "DIM"].map(slot => ({ slot, condition: slot })) }],
    }));
    const pin = sha(roster);
    const root = join(dir, trainCaptureRoot(pin));
    await mkdir(join(root, "slots", page), { recursive: true });
    await mkdir(join(root, "originals"));
    await writeFile(join(root, "roster.json"), roster);
    const create = { width: 2, height: 2, channels: 3, background: "white" } as const;
    const jpeg = await sharp({ create }).jpeg().withMetadata({ orientation: 6 })
      .withExifMerge({ IFD0: { Artist: "Invented fixture" } }).toBuffer();
    const png = await sharp({ create }).png().toBuffer();
    const photos = [{ slot: "FLAT", bytes: jpeg }, { slot: "DIM", bytes: png }];
    for (const { slot, bytes } of photos) {
      const digest = sha(bytes);
      await writeFile(join(root, "originals", digest), bytes);
      await writeFile(join(root, "slots", page, slot + ".json"), JSON.stringify({
        page_id: page, slot, revisions: [{ sha256: "f".repeat(64) }, { sha256: digest, bytes: bytes.length }],
      }));
    }
    expect(await summarizeCaptureExif(dir, "train", pin)).toEqual({
      scope: "train", roster_sha256: pin, expected: 3, active: 2,
      exif: { present: 1, absent: 1, unreadable: 0 }, orientations: { "6": 1 },
    });
    await expect(summarizeCaptureExif(dir, "eval", pin)).rejects.toThrow();
    await writeFile(join(root, "originals", sha(jpeg)), png);
    await expect(summarizeCaptureExif(dir, "train", pin)).rejects.toThrow("capture readback mismatch");
  } finally {
    await rm(dir, { recursive: true });
  }
});
