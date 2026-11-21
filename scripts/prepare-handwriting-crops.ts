/** Run offline on the private, privacy-screened original. Coordinates are the original raster's pixels. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import sharp from "sharp";
import { parseArgs, str } from "./lib/args";
import { linePolygons, polygonBounds } from "../src/shared/handwriting-geometry";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function cleanPng(png: Buffer) {
  // Keep just the pixel encoding. This also drops export-time resolution and profile chunks.
  const kept = [png.subarray(0, 8)];
  for (let i = 8; i < png.length;) {
    const end = i + 12 + png.readUInt32BE(i);
    if (["IHDR", "IDAT", "IEND"].includes(png.toString("ascii", i + 4, i + 8))) kept.push(png.subarray(i, end));
    i = end;
  }
  return Buffer.concat(kept).toString("base64");
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const input = readFileSync(positional[0]!);
  if (input.length > 12 * 1024 * 1024 || digest(input) !== str(flags, "sha256")) throw Error();
  const { width, height, format } = await sharp(input, { failOn: "error", limitInputPixels: 40_000_000 }).metadata();
  if (!width || !height || !["jpeg","png"].includes(format)) throw Error();
  const original = sharp(input, { failOn: "error", limitInputPixels: 40_000_000 });
  const polygons = linePolygons(JSON.parse(readFileSync(str(flags, "polygons"), "utf8")), width, height);
  if (!polygons) throw Error();
  const output = resolve(str(flags, "output"));
  const parent = realpathSync(dirname(output));
  const checkout = realpathSync(resolve(import.meta.dirname, ".."));
  if (parent === checkout || parent.startsWith(checkout + sep)) throw Error();
  const raw = await original.toColourspace("srgb").flatten({ background: "#ffffff" }).raw().toBuffer({ resolveWithObject: true });
  const raster = () => sharp(raw.data, { raw: { width, height, channels: raw.info.channels } });
  const preparedPage = cleanPng(await raster().png().toBuffer());
  const crops = [];
  for (const poly of polygons) {
    const bounds = polygonBounds(poly);
    const extracted = await raster().extract(bounds).ensureAlpha().raw().toBuffer();
    const vertices = poly.map(([x,y]) => (x - bounds.left) + "," + (y - bounds.top)).join(" ");
    const mask = Buffer.from(`<svg width="${bounds.width}" height="${bounds.height}"><polygon points="${vertices}" fill="white"/></svg>`);
    const crop = await sharp(extracted, { raw: { width: bounds.width, height: bounds.height, channels: 4 } })
      .composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    crops.push(cleanPng(crop));
  }
  writeFileSync(output, JSON.stringify({ originalSha: digest(input), replaces: str(flags, "replaces", "") || null,
    polygons, preparedPage, crops }), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ crops: 10, originalFrame: { width, height } }));
}
main().catch(() => { console.error("Could not prepare the private raster and ten line polygons."); process.exitCode = 1; });
