import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import { imageFrame } from "../../src/worker/handwriting/image";

const files: string[] = [];
afterEach(() => {
  for (const file of files.splice(0)) {
    // The fixture owns this exact temp directory.
    rmSync(file, { recursive: true });
  }
});

it("prepares ten true-pixel crops and discards original metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heocr-crop-fixture-"));
  files.push(dir);
  const original = join(dir, "original.jpg");
  const poly = join(dir, "geometry.json");
  const output = join(dir, "out.json");
  const source = await sharp({ create: { width: 64, height: 100, channels: 3, background: "#552177" } })
    .withExif({ IFD0: { Artist: "invented fixture metadata" } }).jpeg().toBuffer();
  writeFileSync(original, source);
  const polygons = Array.from({ length: 10 }, (_, i) => [[3, i*10], [53, i*10], [53, i*10+8], [27, i*10+8]]);
  writeFileSync(poly, JSON.stringify(polygons));
  const run = (pin: string) => spawnSync(process.execPath, [
    "--import", "tsx", "scripts/prepare-handwriting-crops.ts", original, "--sha256", pin, "--polygons", poly, "--output", output,
  ], { encoding: "utf8" });
  expect(run("0".repeat(64)).status).toBe(1);
  const pin = createHash("sha256").update(source).digest("hex");
  const result = run(pin);
  expect(result.status, result.stderr).toBe(0);
  const content = JSON.parse(readFileSync(output, "utf8")) as { originalSha: string; preparedPage: string; crops: string[] };
  expect(content.originalSha).toBe(pin);
  expect(statSync(output).mode & 0o777).toBe(0o600);
  expect(imageFrame(Buffer.from(content.preparedPage, "base64"), true)).toMatchObject({ width: 64, height: 100 });
  expect(content.crops).toHaveLength(10);
  for (const encoded of content.crops) {
    const png = Buffer.from(encoded, "base64");
    expect(imageFrame(png, true)).toMatchObject({ width: 50, height: 8 });
    const pixels = await sharp(png).raw().toBuffer();
    expect(pixels[4 * 7 * 50 + 3]).toBe(0);
    expect(pixels[4 * (7 * 50 + 40) + 3]).toBe(255);
  }
});
