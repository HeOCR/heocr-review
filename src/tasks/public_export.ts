/**
 * The public view of an export: what may leave for a public repository or release. The privacy policy says a
 * volunteer's accuracy on check lines is "visible to admins only and never published" (2026-11-18-v3), so nothing
 * that states or implies one pseudonym's accuracy or standing may be in it:
 *
 * - per decision: `counted`, `not_counted_reason`, `step` (line_verify v1.4; "uncounted" implies below the floor),
 *   `gold_id`, `gold_hit` (line_consensus);
 * - decisions on gold lines (their answers grade the reviewer), in the decisions file and in the ledger;
 * - per reviewer: the line_consensus `reviewers` list (gold seen and hit, standing, decisions counted);
 * - `admin_exclusions` (who an admin excluded from agreement);
 * - line_verify v1.4's `pair` (which decisions counted);
 * - line_verify v1.5's `gold` section (every P-hist gold decision and its `hit`).
 *
 * The private export (scripts/export.ts without --public) keeps all of it for eval's restricted ingest.
 */
import type { ExportFile, ProposalRecord } from "./types";

/** Keys that never appear, at any depth, in a public file. */
export const PUBLIC_FORBIDDEN_KEYS = [
  "counted",
  "not_counted_reason",
  "step",
  "gold_id",
  "gold_hit",
  "gold_seen",
  "gold_hits",
  "planted_seen",
  "planted_hits",
  "standing",
  "decisions_counted",
  "admin_exclusions",
  "pair",
  "accuracy",
  "hit",
  "pointed_book_drops",
] as const;
const FORBIDDEN = new Set<string>(PUBLIC_FORBIDDEN_KEYS);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The external ids of the gold (check) lines among a batch's proposals. */
export function goldProposalIds(proposals: ProposalRecord[]): Set<string> {
  return new Set(proposals.filter((p) => isObj(p.payload) && isObj((p.payload as Record<string, unknown>).gold)).map((p) => p.externalId));
}

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!FORBIDDEN.has(k)) out[k] = strip(x);
  return out;
}

/** The public copy of a decisions file: gold-line decisions and the reviewers list dropped, then every forbidden key. */
export function publicDecisions(content: unknown): unknown {
  if (!isObj(content)) return strip(content);
  const c: Record<string, unknown> = { ...content };
  if (Array.isArray(c.decisions)) c.decisions = c.decisions.filter((d) => !(isObj(d) && d.role === "gold"));
  if (Array.isArray(c.reviewers)) delete c.reviewers;
  if (Array.isArray(c.gold)) delete c.gold;
  return strip(c);
}

/** The public copy of a ledger: the gold lines' proposals dropped, then every forbidden key. */
export function publicLedger(content: unknown, gold: Set<string>): unknown {
  if (!isObj(content)) return strip(content);
  const c: Record<string, unknown> = { ...content };
  if (Array.isArray(c.proposals)) c.proposals = c.proposals.filter((p) => !(isObj(p) && gold.has(String(p.proposal_id))));
  return strip(c);
}

/**
 * Why a file may not be published (empty when it may): a forbidden key anywhere, a gold-line decision, or a list of
 * reviewer records. `gold`, when given, also refuses a ledger entry for a gold line.
 */
export function publicProblems(content: unknown, gold: Set<string> = new Set()): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (!isObj(v)) return;
    if (v.role === "gold") out.push(`${path}: a decision on a gold line`);
    if (typeof v.proposal_id === "string" && gold.has(v.proposal_id)) out.push(`${path}: a gold line's proposal`);
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN.has(k)) out.push(`${path}.${k}: not allowed in a public file`);
      walk(x, `${path}.${k}`);
    }
  };
  walk(content, "$");
  if (isObj(content) && Array.isArray(content.reviewers)) out.push("$.reviewers: per-reviewer records are not allowed in a public file");
  if (isObj(content) && Array.isArray(content.gold)) out.push("$.gold: gold decisions are not allowed in a public file");
  return out;
}

/** Both public files, checked; throws if anything forbidden is left. Same file names with `.public` before `.json`. */
export function publicFiles(decisionsFile: ExportFile, ledgerFile: ExportFile, gold: Set<string>): ExportFile[] {
  const files = [
    { fileName: decisionsFile.fileName.replace(/\.json$/, ".public.json"), content: publicDecisions(decisionsFile.content) },
    { fileName: ledgerFile.fileName.replace(/\.json$/, ".public.json"), content: publicLedger(ledgerFile.content, gold) },
  ];
  for (const f of files) {
    const problems = publicProblems(f.content, gold);
    if (problems.length) throw new Error(`${f.fileName} is not public-safe:\n  ${problems.slice(0, 20).join("\n  ")}`);
  }
  return files;
}
