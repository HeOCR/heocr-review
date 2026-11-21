import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  CAPTURE_DIGEST, captureRoot, captureRoster, trainCaptureRoot, trainCaptureRoster,
} from "../src/shared/registered-captures";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Read a private, read-only copy of one bucket. Emit aggregate metadata only. */
export async function summarizeCaptureExif(bucket: string, scope: "eval" | "train", pin: string) {
  if (!CAPTURE_DIGEST.test(pin)) throw new Error("invalid roster digest");
  const root = join(bucket, scope === "train" ? trainCaptureRoot(pin) : captureRoot(pin));
  const rosterBytes = await readFile(join(root, "roster.json"));
  if (sha256(rosterBytes) !== pin) throw new Error("roster digest mismatch");
  const raw: unknown = JSON.parse(rosterBytes.toString("utf8"));
  const { pages } = scope === "train" ? trainCaptureRoster(raw) : captureRoster(raw);
  const summary = {
    scope, roster_sha256: pin, expected: 0, active: 0,
    exif: { present: 0, absent: 0, unreadable: 0 }, orientations: {} as Record<string, number>,
  };
  for (const page of pages) {
    for (const { slot } of page.slots) {
      summary.expected++;
      const receipt = await readFile(join(root, "slots", page.page_id, slot + ".json"), "utf8").catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
        return null;
      });
      if (receipt === null) continue;
      const record = JSON.parse(receipt);
      const active = Array.isArray(record?.revisions) ? record.revisions.at(-1) : null;
      if (record?.page_id !== page.page_id || record?.slot !== slot ||
        typeof active?.sha256 !== "string" || !CAPTURE_DIGEST.test(active.sha256)) throw new Error("invalid slot receipt");
      const photo = await readFile(join(root, "originals", active.sha256));
      if (sha256(photo) !== active.sha256 || active.bytes !== photo.length) throw new Error("capture readback mismatch");
      summary.active++;
      const meta = await sharp(photo).metadata().catch(() => null);
      if (!meta) {
        summary.exif.unreadable++;
        continue;
      }
      if (!meta.exif) {
        summary.exif.absent++;
        continue;
      }
      summary.exif.present++;
      const orientation = meta.orientation && meta.orientation >= 1 && meta.orientation <= 8 ? String(meta.orientation) : "unknown";
      summary.orientations[orientation] = (summary.orientations[orientation] ?? 0) + 1;
    }
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [scope, bucket, pin] = process.argv.slice(2);
  if ((scope !== "eval" && scope !== "train") || !bucket || !pin) {
    console.error("Usage: tsx scripts/capture-exif-summary.ts <eval|train> <private-bucket-mirror> <roster-sha256>");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await summarizeCaptureExif(bucket, scope, pin), null, 2));
    } catch {
      // Provider/decoder errors can contain paths or embedded metadata.
      console.error("Capture summary failed. Check the local roster, slot receipts and original hashes.");
      process.exitCode = 1;
    }
  }
}
