import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { summarizeCaptureExif } from "../../scripts/capture-exif-summary";
import { captureMetadata } from "../../scripts/lib/capture-exif";
import { trainCaptureRoot } from "../../src/shared/registered-captures";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

it("reports aggregate metadata from exact originals and stages metadata-free working pixels in their own scope", async () => {
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
    const create = { width: 2, height: 3, channels: 3, background: "white" } as const;
    const jpeg = await sharp({ create }).jpeg().withMetadata({ orientation: 6 })
      .withExifMerge({ IFD0: { Model: "Fixture Phone", Artist: "Private Artist Fixture" },
        IFD3: { GPSVersionID: "2 3 0 0" } }).toBuffer();
    const png = await sharp({ create }).png().toBuffer();
    const photos = [{ slot: "FLAT", bytes: jpeg }, { slot: "DIM", bytes: png },
      { slot: "OBLIQUE", bytes: Buffer.from("unsupported format fixture") }];
    for (const { slot, bytes } of photos) {
      const digest = sha(bytes);
      await writeFile(join(root, "originals", digest), bytes);
      await writeFile(join(root, "slots", page, slot + ".json"), JSON.stringify({
        page_id: page, slot, revisions: [{ sha256: "f".repeat(64) }, { sha256: digest, bytes: bytes.length }],
      }));
    }
    const aggregate = {
      scope: "train", roster_sha256: pin, expected: 3, active: 3,
      exif: { present: 1, absent: 1, unreadable: 1 }, orientations: { "6": 1 },
      gps: { yes: 1, no: 1, unknown: 1 }, device_models: { "Fixture Phone": 1, unknown: 2 },
      resolution: { "2x3": 2, unknown: 1 }, compression: { deflate: 1, jpeg: 1, unknown: 1 },
    };
    expect(await summarizeCaptureExif(dir, "train", pin)).toEqual(aggregate);
    expect(await summarizeCaptureExif(dir, "train", pin, true)).toEqual({
      ...aggregate, working_copies: { ready: 2, unavailable: 1 },
    });
    const manifest = JSON.parse(await readFile(join(root, "working", "manifest.json"), "utf8"));
    expect(manifest.files).toHaveLength(2);
    const entry = manifest.files.find((f: { slot: string }) => f.slot === "FLAT");
    const clean = await readFile(join(root, "working", entry.path));
    expect(entry).toEqual({ page_id: page, slot: "FLAT", path: page + "-FLAT.png",
      sha256: sha(clean), original_sha256: sha(jpeg) });
    const decoded = await sharp(clean).metadata();
    expect(decoded).toMatchObject({ format: "png", width: 3, height: 2 });
    expect([decoded.exif, decoded.xmp, decoded.iptc, decoded.icc, decoded.orientation]).toEqual(Array(5).fill(undefined));
    expect(JSON.stringify(manifest)).not.toMatch(/Fixture Phone|Private Artist Fixture|gps/i);
    expect(await readFile(join(root, "originals", sha(jpeg)))).toEqual(jpeg);
    await expect(summarizeCaptureExif(dir, "train", pin, true)).rejects.toThrow("already exists");
    await expect(summarizeCaptureExif(dir, "eval", pin)).rejects.toThrow();
    await writeFile(join(root, "originals", sha(jpeg)), png);
    await expect(summarizeCaptureExif(dir, "train", pin)).rejects.toThrow("capture readback mismatch");
  } finally {
    await rm(dir, { recursive: true });
  }
});

it("detects XMP location tags without returning tag values", async () => {
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLongitude="invented-private-marker"/>' +
    '</rdf:RDF></x:xmpmeta>';
  const photo = await sharp({ create: { width: 3, height: 2, channels: 3, background: "white" } })
    .jpeg().withXmp(xmp).toBuffer();
  const summary = captureMetadata(photo, await sharp(photo).metadata());
  expect(summary).toEqual({ gps: "yes", model: "unknown", resolution: "3x2", compression: "jpeg" });
  expect(JSON.stringify(summary)).not.toContain("invented-private-marker");
});
