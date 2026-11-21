/**
 * Triage mode (migrations/0012_triage.sql; heocr-eval's reference_triage_v1, heocr-restricted-eval#153).
 *
 * In a line_verify batch set to 'triage', a pass-1 line with a candidate (an edition line's candidate, or a typed line's
 * model draft) is answered with one of three answers and never edited there: `correct` (the candidate is the line as
 * printed), `different` (it is not: the line goes to the reviewer's desktop fix queue) or `niqqud_mismatch` (the print
 * is pointed and the batch is not). A line without a candidate, and the blind second pass, are never triaged: they are
 * answered on the desktop as before. The fix of a `different` line is an ordinary answer that supersedes it.
 *
 * Exports: line_verify_decisions keeps its contract (correct is exact, or the draft as typed; niqqud_mismatch is
 * pointed_print; an unfixed different is not a reference and is left out), and reference_triage.json (this file's
 * referenceTriageFile) gives eval one row per line and answering reviewer: the triage answer, the correction and
 * where the correction started, with every earlier answer in `history`.
 */
import { sha256Hex } from "../../shared/sha256";
import { isRestrictedDraftVerification } from "../restricted_reference";
import type { BatchRecord, DecisionRecord, ExportFile, ProposalRecord, ResolvedProposal, TriagePages } from "../types";
import type { LineVerifyPayload } from "./index";

export const TRIAGE_VALUES = ["correct", "different", "niqqud_mismatch"] as const;
export type TriageValue = (typeof TRIAGE_VALUES)[number];
export const isTriageValue = (v: string): v is TriageValue => (TRIAGE_VALUES as readonly string[]).includes(v);
export const REFERENCE_TRIAGE_SCHEMA = "reference_triage.v1";
export const REFERENCE_TRIAGE_FILE = "reference_triage.json";
export const REFERENCE_TRIAGE_HISTORY_SCHEMA = "reference_triage_history.v1";
export const REFERENCE_TRIAGE_HISTORY_FILE = "reference_triage_history.json";

const payloadOf = (p: ProposalRecord) => p.payload as unknown as LineVerifyPayload;
const passOf = (p: ProposalRecord) => payloadOf(p).pass ?? 1;
const kindOf = (p: ProposalRecord) => payloadOf(p).kind ?? "verify";

/** The candidate shown on this line, or "" when there is none (a typed line without a draft). */
export function candidateOf(p: ProposalRecord): string {
  const x = payloadOf(p);
  if (kindOf(p) === "verify") return x.candidate_text;
  return x.candidate_text !== "" && x.candidate_provenance.startsWith("llm:") ? x.candidate_text : "";
}

/** A line the triage screen answers: pass 1, with a candidate. Everything else is the desktop's. */
export const triageable = (p: ProposalRecord): boolean => passOf(p) === 1 && candidateOf(p) !== "";

/** SQL over proposals p: the same test as triageable (kept in step with it; the worker tests check both). */
export const TRIAGEABLE_SQL = `(COALESCE(json_extract(p.payload_json, '$.pass'), 1) = 1
  AND json_extract(p.payload_json, '$.candidate_text') <> ''
  AND (COALESCE(json_extract(p.payload_json, '$.kind'), 'verify') = 'verify'
    OR json_extract(p.payload_json, '$.candidate_provenance') LIKE 'llm:%'))`;

/** SQL over decision d and proposal p: the answer matches the line content. */
export const CONTENT_MATCH_SQL = "d.proposal_sha256 = p.content_sha256";

/**
 * SQL over a decision alias: the answer leaves its line open to the reviewer, for the desktop fix queue: "different",
 * or any triage answer on a line with a plant (eval's amendment 2: every plant goes to the desktop).
 */
export const PENDING_SQL = (d: string) =>
  `(${d}.value = 'different' OR (${d}.value IN ('correct', 'niqqud_mismatch') AND EXISTS (SELECT 1 FROM triage_plants tp WHERE tp.proposal_id = ${d}.proposal_id)))`;

/** A plant as the export needs it (migrations/0012_triage.sql, triage_plants). */
export interface TriagePlant {
  proposalId: number;
  plantType: string;
  plantedSha256: string;
  candidateSha256: string;
}
export const TRIAGE_PLANTS_SQL = "SELECT proposal_id, plant_type, planted_sha256, candidate_sha256 FROM triage_plants WHERE batch_id = ?1";
export const toTriagePlant = (r: { proposal_id: number; plant_type: string; planted_sha256: string; candidate_sha256: string }): TriagePlant => ({
  proposalId: r.proposal_id,
  plantType: r.plant_type,
  plantedSha256: r.planted_sha256,
  candidateSha256: r.candidate_sha256,
});

/** The line's plant, if it was made on the line's current candidate (a plant on a since-changed candidate is void). */
export function plantOf(p: ProposalRecord, plants: Map<number, TriagePlant>): TriagePlant | null {
  const plant = plants.get(p.id);
  return plant && plant.candidateSha256 === sha256Hex(candidateOf(p)) ? plant : null;
}

export const isTriageBatch = (batch: BatchRecord) =>
  batch.taskType === "line_verify" && batch.settings?.mode === "triage" && !isRestrictedDraftVerification(batch);

/**
 * A triage answer as line_verify_decisions has it: correct is exact on an edition line and the draft as typed on a
 * typed line; niqqud_mismatch is pointed_print (on a typed line with the draft's letters, which are unpointed);
 * different is not a reference (null: left out). Any other answer is itself.
 */
export function asReference(p: ProposalRecord, d: DecisionRecord, planted = false): DecisionRecord | null {
  if (!isTriageValue(d.value)) return d;
  // A plant's triage answer judged the planted text, never the candidate: only the desktop answer is a reference.
  if (d.value === "different" || planted) return null;
  const typed = kindOf(p) === "type";
  if (d.value === "correct") return typed ? { ...d, value: "typed", text: candidateOf(p) } : { ...d, value: "exact", text: null };
  return { ...d, value: "pointed_print", text: typed ? candidateOf(p) : null };
}

interface TriageRow {
  item_id: string;
  reviewer: string;
  candidate_provenance: string | null;
  /** Of the text triage showed: the planted text on a plant. */
  candidate_sha256: string | null;
  plant: { planted_sha256: string; type: string } | null;
  queue: "triage" | "desktop_no_candidate" | "desktop_added";
  /** desktop_added: the added line's box, in page pixels. */
  box?: number[];
  triage: { decision: TriageValue; decided_at: string } | null;
  correction: { value: string; text: string | null; correction_start: "candidate" | "blank"; decided_at: string } | null;
}

/**
 * reference_triage.v1: one row per pass-1 line and answering reviewer, plus every superseded answer in history; and
 * reference_triage_history.json, every replaced triage answer (eval's count source).
 */
export function referenceTriageFiles(batch: BatchRecord, resolved: ResolvedProposal[], exportedAt: string, plantList: TriagePlant[] = [], pageRecords?: TriagePages): ExportFile[] {
  const plants = new Map(plantList.map((x) => [x.proposalId, x]));
  const rows: TriageRow[] = [];
  const history: { item_id: string; reviewer: string; value: string; text: string | null; decided_at: string; superseded_at: string }[] = [];
  const replaced: { item_id: string; reviewer: string; triage: { decision: string; decided_at: string }; replaced_at: string }[] = [];
  const lines = resolved.filter((r) => passOf(r.proposal) === 1).sort((a, b) => payloadOf(a.proposal).order - payloadOf(b.proposal).order);
  for (const r of lines) {
    const p = r.proposal;
    const itemId = payloadOf(p).item_id ?? p.externalId;
    const candidate = candidateOf(p);
    const provenance = candidate === "" ? null : payloadOf(p).candidate_provenance;
    const plant = plantOf(p, plants);
    const reviewers = [...new Set(r.current.map((d) => d.reviewerId))].sort();
    for (const reviewer of reviewers) {
      const current = r.current.find((d) => d.reviewerId === reviewer)!;
      // The reviewer's answers on this content, oldest first (a stale answer, on content since changed, is not theirs).
      const mine = [...r.superseded.filter((d) => d.reviewerId === reviewer && d.proposalSha256 === current.proposalSha256), current].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      const lastTriage = [...mine].reverse().find((d) => isTriageValue(d.value));
      rows.push({
        item_id: itemId,
        reviewer,
        candidate_provenance: provenance,
        candidate_sha256: candidate === "" ? null : plant ? plant.plantedSha256 : sha256Hex(candidate),
        plant: plant ? { planted_sha256: plant.plantedSha256, type: plant.plantType } : null,
        queue: candidate === "" ? "desktop_no_candidate" : "triage",
        triage: lastTriage ? { decision: lastTriage.value as TriageValue, decided_at: lastTriage.createdAt } : null,
        correction: isTriageValue(current.value)
          ? null
          : {
              value: plant ? plantCorrection(p, current) : current.value,
              text: current.text,
              correction_start: candidate === "" ? "blank" : "candidate",
              decided_at: current.createdAt,
            },
      });
      for (const d of mine) {
        if (d !== current && isTriageValue(d.value)) replaced.push({ item_id: itemId, reviewer, triage: { decision: d.value, decided_at: d.createdAt }, replaced_at: d.supersededAt! });
      }
    }
    for (const d of r.superseded) {
      history.push({ item_id: itemId, reviewer: d.reviewerId, value: d.value, text: d.text, decided_at: d.createdAt, superseded_at: d.supersededAt! });
    }
  }
  // Page completeness (amendment 1, migrations/0014): one entry per page and checking reviewer (a page nobody checked:
  // completeness null); lines added on the desktop are rows of their own, queue "desktop_added", boxes in page pixels.
  const pageSize = new Map<string, { width: number; height: number } | null>();
  for (const r of lines) pageSize.set(payloadOf(r.proposal).page_id, { width: payloadOf(r.proposal).page.width, height: payloadOf(r.proposal).page.height });
  for (const { pageId, width, height } of pageRecords?.pages ?? []) {
    if (!pageSize.has(pageId)) pageSize.set(pageId, width !== null && height !== null ? { width, height } : null);
  }
  const checks = pageRecords?.checks ?? [];
  type Completeness = { answer: "complete" | "missing_lines"; reviewer: string; decided_at: string; lines_added_at?: string } | null;
  const pages = [...pageSize.keys()].flatMap((pageId): { page_id: string; completeness: Completeness }[] => {
    const mine = checks.filter((c) => c.pageId === pageId).sort((a, b) => a.reviewerId.localeCompare(b.reviewerId));
    if (!mine.length) return [{ page_id: pageId, completeness: null }];
    return mine.map((c) => ({
      page_id: pageId,
      completeness:
        c.answer === "lines_added"
          ? { answer: "missing_lines" as const, reviewer: c.reviewerId, decided_at: c.missingAt ?? c.decidedAt, lines_added_at: c.decidedAt }
          : { answer: c.answer, reviewer: c.reviewerId, decided_at: c.decidedAt },
    }));
  });
  for (const a of pageRecords?.added ?? []) {
    const size = pageSize.get(a.pageId);
    rows.push({
      item_id: `${a.pageId}#added:${a.id}`,
      reviewer: a.reviewerId,
      candidate_provenance: null,
      candidate_sha256: null,
      plant: null,
      queue: "desktop_added",
      triage: null,
      correction: { value: a.value, text: a.text, correction_start: "blank", decided_at: a.decidedAt },
      ...(size ? { box: [Math.round(a.box[0] * size.width), Math.round(a.box[1] * size.height), Math.round(a.box[2] * size.width), Math.round(a.box[3] * size.height)] } : {}),
    });
  }
  const batchId = (batch.source as { batch_id?: string }).batch_id ?? batch.id;
  return [
    { fileName: REFERENCE_TRIAGE_FILE, content: { schema: REFERENCE_TRIAGE_SCHEMA, batch_id: batchId, exported_at: exportedAt, pages, rows, history } },
    { fileName: REFERENCE_TRIAGE_HISTORY_FILE, content: { schema: REFERENCE_TRIAGE_HISTORY_SCHEMA, batch_id: batchId, exported_at: exportedAt, replaced } },
  ];
}

/**
 * A plant's desktop answer (eval's amendment 2): "kept_candidate" when it leaves the true candidate as it is (exact, or
 * typed equal to it), "corrected" when it gives another text; any other answer is itself.
 */
function plantCorrection(p: ProposalRecord, d: DecisionRecord): string {
  if (d.value === "exact" || ((d.value === "typed" || d.value === "edited") && d.text === candidateOf(p))) return "kept_candidate";
  if (d.value === "edited" || d.value === "typed" || (d.value === "pointed_print" && d.text)) return "corrected";
  return d.value;
}
