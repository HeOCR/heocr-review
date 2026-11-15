/** A batch subset's definition file (eval's interim set) → subset_members rows and SQL. Pure: no I/O. */
import { lit } from "./sql";

export const INTERIM_SCHEMA = "heocr_midcentury_interim.v1";

/**
 * Registered definition files and their sha256, from heocr-restricted-eval
 * preregistration/midcentury_interim_2026-11-14/SHA256SUMS (heocr-restricted-eval#10). The import refuses any
 * other content: a subset changes only through a new registered file.
 */
export const REGISTERED_SHA256: Record<string, string> = {
  "interim_v1.json": "b1c02742809a591ad967bd068bed55db49b26489068c67109e662efddeaf8355",
};

export interface SubsetMember {
  stratum: string;
  position: number;
  externalId: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";

export function interimProblems(raw: unknown): string[] {
  if (!isObj(raw)) return ["the file must be a JSON object"];
  if (raw.schema !== INTERIM_SCHEMA) return [`schema must be ${INTERIM_SCHEMA}`];
  if (!isStr(raw.manifest_sha256)) return ["manifest_sha256 is missing"];
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) return ["pages must be a non-empty list"];
  const out: string[] = [];
  const strata = new Set<string>();
  const ids = new Set<string>();
  for (const [k, p] of raw.pages.entries()) {
    if (!(isObj(p) && isStr(p.key) && isStr(p.stratum) && Array.isArray(p.alternates) && p.alternates.every(isStr))) {
      out.push(`pages[${k}] must have key, stratum and alternates (a list of keys)`);
      continue;
    }
    if (strata.has(p.stratum)) out.push(`stratum ${p.stratum} is listed twice`);
    strata.add(p.stratum);
    for (const id of [p.key, ...(p.alternates as string[])]) {
      if (ids.has(id)) out.push(`${id} is listed twice`);
      ids.add(id);
    }
  }
  return out;
}

/** Per stratum: the pick at position 0, then its alternates in the file's order. */
export function interimMembers(raw: unknown): SubsetMember[] {
  const pages = (raw as { pages: { key: string; stratum: string; alternates: string[] }[] }).pages;
  return pages.flatMap((p) => [p.key, ...p.alternates].map((externalId, position) => ({ stratum: p.stratum, position, externalId })));
}

/** Replace the subset's members (decisions, proposals and other subsets are never touched). */
export function buildSubsetStatements(
  batchId: string,
  subset: { id: string; title: string; sourceSha256: string },
  members: SubsetMember[],
  importedAt: string,
): string[] {
  const b = lit(batchId);
  const s = lit(subset.id);
  return [
    `INSERT INTO subsets (batch_id, id, title, source_sha256, imported_at) VALUES (${b}, ${s}, ${lit(subset.title)}, ${lit(subset.sourceSha256)}, ${lit(importedAt)})
  ON CONFLICT (batch_id, id) DO UPDATE SET title = excluded.title, source_sha256 = excluded.source_sha256, imported_at = excluded.imported_at;`,
    `DELETE FROM subset_members WHERE batch_id = ${b} AND subset_id = ${s};`,
    ...members.map(
      (m) => `INSERT INTO subset_members (batch_id, subset_id, stratum, position, external_id) VALUES (${b}, ${s}, ${lit(m.stratum)}, ${m.position}, ${lit(m.externalId)});`,
    ),
  ];
}
