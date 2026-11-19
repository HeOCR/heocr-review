/**
 * Refuse a file that may not be published (src/tasks/public_export.ts): any per-pseudonym accuracy, standing or
 * counted status, or a gold-line decision. Run it on every file before it goes to a public repository or release.
 *
 *   npm run check-public -- out/line_verify_decisions.public.json [more files...]
 *
 * Prints problems (paths and key names only, never values) and exits 1 when any file has one.
 */
import { readFileSync } from "node:fs";
import { publicProblems } from "../src/tasks/public_export";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: npm run check-public -- <file.json> [...]");
  process.exit(2);
}
let bad = 0;
for (const f of files) {
  const problems = publicProblems(JSON.parse(readFileSync(f, "utf8")));
  if (problems.length) {
    bad++;
    console.error(`${f}: ${problems.length} problem(s)\n  ${problems.slice(0, 20).join("\n  ")}`);
  } else console.log(`${f}: public-safe`);
}
process.exit(bad ? 1 : 0);
