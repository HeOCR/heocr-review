import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs, str } from "./lib/args";
import { fitRanking } from "./lib/fit-realism-ranking";

const { flags } = parseArgs(process.argv.slice(2));
const data = fitRanking(JSON.parse(readFileSync(str(flags, "input"), "utf8")));
writeFileSync(str(flags, "out"), JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ standard_pairs: data.standard_pairs, components: data.components.length,
  scored_controls: data.controls.real_synth.decisive,
  unscored_controls: data.controls.real_real.answered + data.controls.real_synth.ties,
  control_ties: data.controls.overall.ties }));
