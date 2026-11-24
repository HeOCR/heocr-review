import type { BatchRecord } from "../tasks/types";
import { isRestrictedDraftVerification } from "../tasks/restricted_reference";
import { HttpError } from "./http";

export const CONSENSUS_ON = `EXISTS (SELECT 1 FROM reference_consensus_runs rr
  WHERE rr.batch_id=i.batch_id AND rr.active=1)`;

/** Use only an exact current machine agreement. An audit still needs a human answer. */
export const MACHINE_ACCEPTED = `EXISTS (SELECT 1 FROM current_reference_consensus_lines mc
  WHERE mc.proposal_id=p.id AND mc.lane='accepted')`;

export type ReferenceLane = "ordinary" | "audit" | "accepted";

export async function referenceConsensusActive(db: D1Database, batch: BatchRecord): Promise<boolean> {
  if (!isRestrictedDraftVerification(batch)) return false;
  return !!await db.prepare("SELECT 1 FROM reference_consensus_runs WHERE batch_id=?1 AND active=1").bind(batch.id).first();
}

export async function referenceLane(db: D1Database, batch: BatchRecord, proposal: number): Promise<ReferenceLane | null> {
  if (!await referenceConsensusActive(db, batch)) return null;
  const row = await db.prepare("SELECT lane FROM current_reference_consensus_lines WHERE proposal_id=?1 AND batch_id=?2")
    .bind(proposal, batch.id).first<{ lane: ReferenceLane }>();
  return row?.lane ?? "ordinary"; // Changed source or geometry needs another human look.
}

export async function referenceFilter(db: D1Database, batch: BatchRecord, lane: "ordinary" | "audit" | "all") {
  const rows = await db.prepare(`SELECT p.id FROM proposals p LEFT JOIN current_reference_consensus_lines c ON c.proposal_id=p.id
    WHERE p.batch_id=?1 AND p.active=1 AND (p.gate_kind IS NULL OR p.gate_kind='always')
      AND COALESCE(json_extract(p.payload_json,'$.pass'),1)=1
      AND (CASE ?2 WHEN 'audit' THEN c.lane='audit'
        WHEN 'all' THEN COALESCE(c.lane,'ordinary') IN ('ordinary','audit')
        ELSE COALESCE(c.lane,'ordinary')='ordinary' END)
    ORDER BY c.position NULLS FIRST,p.rank,p.id`).bind(batch.id, lane).all<{ id: number }>();
  const audit = lane === "audit";
  return { id: audit ? "reference-typing" : "reference-review", ids: rows.results.map(r => r.id), strata: rows.results.length,
    preserveOrder: true, omitPages: audit };
}

export function enforceReferenceRoute(lane: ReferenceLane | null, hasCurrent: boolean) {
  if (lane === "accepted" && !hasCurrent) throw new HttpError(404, "not_found");
}
