import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  CAPTURE_DIGEST, captureRoot, captureRoster, formCaptureRoot, formCaptureRoster, trainCaptureRoot, trainCaptureRoster,
  type FormCapturePack,
} from "../src/shared/registered-captures";
import { captureMetadata, makeCaptureWorkingPng } from "./lib/capture-exif";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type CaptureScope = "eval" | "train" | FormCapturePack;

/** Read exact originals from a private mirror and optionally stage metadata-free working copies. */
export async function summarizeCaptureExif(bucket: string, scope: CaptureScope, pin: string, workingCopies = false) {
  if (!CAPTURE_DIGEST.test(pin)) throw new Error("invalid roster digest");
  const root = join(bucket, scope === "eval" ? captureRoot(pin) :
    scope === "train" ? trainCaptureRoot(pin) : formCaptureRoot(scope, pin));
  const rosterBytes = await readFile(join(root, "roster.json"));
  if (sha256(rosterBytes) !== pin) throw new Error("roster digest mismatch");
  const raw: unknown = JSON.parse(rosterBytes.toString("utf8"));
  const { pages } = scope === "eval" ? captureRoster(raw) :
    scope === "train" ? trainCaptureRoster(raw) : formCaptureRoster(raw, scope);
  const summary = {
    scope, roster_sha256: pin, expected: 0, active: 0,
    exif: { present: 0, absent: 0, unreadable: 0 }, orientations: {} as Record<string, number>,
    gps: { yes: 0, no: 0, unknown: 0 },
  };
  const models = new Map<string, number>(), resolutions = new Map<string, number>(), compressions = new Map<string, number>();
  const count = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const histogram = (map: Map<string, number>) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));
  const files: { page_id: string; slot: string; path: string; sha256: string; original_sha256: string }[] = [];
  const target = join(root, "working");
  if (workingCopies && await lstat(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
    return null;
  })) throw new Error("working copy directory already exists");
  const staging = workingCopies ? await mkdtemp(join(root, ".working-")) : null;
  try {
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
        const { gps, model, resolution, compression } = captureMetadata(photo, meta);
        summary.gps[gps]++;
        count(models, model);
        count(resolutions, resolution);
        count(compressions, compression);
        if (!meta) summary.exif.unreadable++;
        else if (!meta.exif) summary.exif.absent++;
        else {
          summary.exif.present++;
          const orientation = meta.orientation && meta.orientation >= 1 && meta.orientation <= 8 ? String(meta.orientation) : "unknown";
          summary.orientations[orientation] = (summary.orientations[orientation] ?? 0) + 1;
        }
        if (staging && meta) {
          const png = await makeCaptureWorkingPng(photo).catch(() => null);
          if (png) {
            const path = `${page.page_id}-${slot}.png`;
            await writeFile(join(staging, path), png, { mode: 0o600, flag: "wx" });
            files.push({ page_id: page.page_id, slot, path, sha256: sha256(png), original_sha256: active.sha256 });
          }
        }
      }
    }
    if (staging) {
      const manifest = { schema: "capture_working_copies.v1", scope, roster_sha256: pin, files };
      await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(staging, target);
    }
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
  return {
    ...summary, device_models: histogram(models), resolution: histogram(resolutions), compression: histogram(compressions),
    ...(workingCopies ? { working_copies: { ready: files.length, unavailable: summary.active - files.length } } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [scope, bucket, pin, mode, ...extra] = process.argv.slice(2);
  if ((scope !== "eval" && scope !== "train" && scope !== "TRN-FM01" && scope !== "TRN-FM01-G") || !bucket || !pin || extra.length ||
    (mode !== undefined && mode !== "--working-copies")) {
    console.error("Usage: tsx scripts/capture-exif-summary.ts <eval|train|TRN-FM01|TRN-FM01-G> <private-bucket-mirror> <roster-sha256> [--working-copies]");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await summarizeCaptureExif(bucket, scope, pin, mode === "--working-copies"), null, 2));
    } catch {
      // Provider/decoder errors can contain paths or embedded metadata.
      console.error("Capture summary failed. Check the local roster, slot receipts and original hashes.");
      process.exitCode = 1;
    }
  }
}
