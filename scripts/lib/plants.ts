/**
 * Plan a plant import (heocr-eval's reference_triage_v1 amendment 2, heocr-restricted-eval#154): match a ratified
 * triage_plants.v1 file to a live triage batch. Pure; scripts/import-plants.ts applies it.
 *
 * Each plant must name a live pass-1 line whose current candidate is the one it was made on (candidate_sha256), and
 * its planted_text must hash to planted_sha256, differ from the candidate, and be a valid line. A line the reviewer
 * has already answered keeps no plant (it was seen without one).
 */
import { sha256Hex } from "../../src/shared/sha256";
import { lineTextProblems } from "../../src/tasks/line_verify/schema";
import { candidateOf } from "../../src/tasks/line_verify/triage";
import type { ProposalRecord } from "../../src/tasks/types";

export const PLANTS_SCHEMA = "triage_plants.v1";

export interface PlantEntry {
  item_id: string;
  type: string;
  /** eval's position: a code-point offset, or a pair such as ["ins", 10]; stored as JSON. */
  position: unknown;
  planted_text: string;
  candidate_sha256: string;
  planted_sha256: string;
}

export interface LivePlantLine {
  proposal: ProposalRecord;
  decisions: number;
}

export interface PlantPlan {
  rows: { proposal_id: number; item_id: string; plant_type: string; position: string; planted_text: string; planted_sha256: string; candidate_sha256: string }[];
  skipped_decided: string[];
  refused: { item_id: string; reason: string }[];
}

export function planPlants(raw: unknown, live: LivePlantLine[]): PlantPlan {
  const file = raw as { schema?: unknown; plants?: unknown };
  if (!file || file.schema !== PLANTS_SCHEMA || !Array.isArray(file.plants)) throw new Error(`not a ${PLANTS_SCHEMA} file`);
  const byItem = new Map(live.filter((l) => (l.proposal.payload as { pass?: number }).pass !== 2).map((l) => [(l.proposal.payload as { item_id?: string }).item_id ?? l.proposal.externalId, l]));
  const plan: PlantPlan = { rows: [], skipped_decided: [], refused: [] };
  const seen = new Set<string>();
  for (const p of file.plants as PlantEntry[]) {
    const refuse = (reason: string) => plan.refused.push({ item_id: String(p?.item_id), reason });
    if (!p || typeof p.item_id !== "string" || typeof p.planted_text !== "string" || typeof p.type !== "string" || p.position === undefined) {
      refuse("malformed plant");
      continue;
    }
    if (seen.has(p.item_id)) {
      refuse("listed twice");
      continue;
    }
    seen.add(p.item_id);
    const line = byItem.get(p.item_id);
    if (!line) {
      refuse("not a pass-1 line of the batch");
      continue;
    }
    const candidate = candidateOf(line.proposal);
    if (candidate === "") refuse("the line has no candidate");
    else if (sha256Hex(candidate) !== p.candidate_sha256) refuse("candidate_sha256 is not the line's current candidate");
    else if (sha256Hex(p.planted_text) !== p.planted_sha256) refuse("planted_sha256 is not planted_text's");
    else if (p.planted_text === candidate) refuse("planted_text equals the candidate");
    else if (lineTextProblems(p.planted_text).length) refuse(`planted_text ${lineTextProblems(p.planted_text).join("; ")}`);
    else if (line.decisions > 0) plan.skipped_decided.push(p.item_id);
    else {
      plan.rows.push({
        proposal_id: line.proposal.id,
        item_id: p.item_id,
        plant_type: p.type,
        position: JSON.stringify(p.position),
        planted_text: p.planted_text,
        planted_sha256: p.planted_sha256,
        candidate_sha256: p.candidate_sha256,
      });
    }
  }
  return plan;
}
