/**
 * Convert HASH's registered H line boxes into a line_verify_items.v1.2 bundle for the maintainer to type (eval
 * amendment 3, heocr-restricted-eval#140):
 *
 *   npx tsx scripts/convert-h-line-items.ts --hash <HASH checkout> --out <bundle dir>
 *
 * Reads data/eval/h_line_items_v2.json and data/eval/h_eval_v1/manifest.jsonl from the HASH checkout, refuses either
 * unless its sha256 is the registered one, writes <out>/items.json (deterministic: eval re-runs this for a byte-identical
 * file) and copies each page image unchanged to <out>/pages/. Then import it with
 * `npm run import -- --task line_verify --bundle <out> ...`.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, str } from "./lib/args";
import { H_EVAL_V1_MANIFEST_SHA256, H_V2_SHA256, convertH, pageImageName } from "./lib/hconvert";
import { sha256File } from "./lib/media";

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2));
  const hash = str(flags, "hash");
  const out = str(flags, "out");
  const itemsPath = join(hash, "data/eval/h_line_items_v2.json");
  const manifestPath = join(hash, "data/eval/h_eval_v1/manifest.jsonl");
  for (const [path, want] of [[itemsPath, H_V2_SHA256], [manifestPath, H_EVAL_V1_MANIFEST_SHA256]] as const) {
    const got = sha256File(path);
    if (got !== want) throw new Error(`${path}: sha256 ${got} is not the registered ${want}`);
  }
  const v2 = JSON.parse(readFileSync(itemsPath, "utf8"));
  const manifest = readFileSync(manifestPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const bundle = convertH(v2, manifest);
  mkdirSync(join(out, "pages"), { recursive: true });
  for (const p of v2.pages as { page_key: string; image: string; image_sha256: string }[]) {
    const dest = join(out, pageImageName(p));
    copyFileSync(join(hash, p.image), dest);
    if (sha256File(dest) !== p.image_sha256) throw new Error(`${p.image}: sha256 differs from v2's image_sha256`);
  }
  writeFileSync(join(out, "items.json"), JSON.stringify(bundle, null, 1) + "\n");
  const items = (bundle.items as unknown[]).length;
  console.log(JSON.stringify({ out, pages: (bundle.pages as unknown[]).length, items, items_sha256: sha256File(join(out, "items.json")) }, null, 2));
}

main();
