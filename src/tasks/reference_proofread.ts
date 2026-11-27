import { sha256Hex } from "../shared/sha256";
import { lineTextProblems } from "./line_verify/schema";
import type { BatchRecord, DecisionRecord, NormalizedDecision, ProposalRecord } from "./types";

export const PROOFREAD_PREFIX = "private-ref-proofread-";
export const PROOFREAD_KIND = "held_out_line_proofread";
export const PROOFREAD_FILE = "reference_proofread.json";

export const isReferenceProofread = (batch: BatchRecord) =>
  batch.id.startsWith(PROOFREAD_PREFIX) && batch.restrictedReference === true &&
  batch.taskType === "line_verify" && batch.source.restricted_review === PROOFREAD_KIND &&
  batch.source.split === "test" && batch.source.trainable === false && !batch.source.contributor_scope;

export function normalizeProofread(value: string, text: unknown, before: string): NormalizedDecision {
  if (value === "exact" && (text === undefined || text === null)) return { ok: true, value, text: null };
  if ((value !== "edited" && value !== "unclear") || typeof text !== "string") {
    return { ok: false, error: "Choose Exact, Edit, or Unclear with a note." };
  }
  const line = text.trim().normalize("NFC");
  if (lineTextProblems(line).length) {
    return { ok: false, error: value === "unclear" ? "Enter a short note on one line." : "Enter a valid single line." };
  }
  if (value === "edited" && line === before) return { ok: true, value: "exact", text: null };
  return { ok: true, value, text: line };
}

export function proofreadExport(batch: BatchRecord, proposals: ProposalRecord[], decisions: DecisionRecord[], reviewerId: string) {
  const counts = { total: proposals.length, answered: 0, exact: 0, edited: 0, unclear: 0, pending: proposals.length };
  const byId = new Map(decisions.filter(d => d.supersededAt === null && d.reviewerId === reviewerId).map(d => [d.proposalId, d]));
  const lines = [...proposals].sort((a, b) => Number(a.payload.order) - Number(b.payload.order)).flatMap(p => {
    const d = byId.get(p.id);
    if (!d || d.proposalSha256 !== p.contentSha256) return [];
    const before = String(p.payload.candidate_text);
    if (d.value !== "exact" && d.value !== "edited" && d.value !== "unclear") return [];
    const after = d.value === "exact" ? before : d.value === "edited" ? d.text : null;
    counts[d.value]++;
    counts.answered++;
    counts.pending--;
    return [{
      id: p.externalId, position: p.payload.order, leaf: p.payload.leaf, region: p.payload.region,
      ordinal: p.payload.line_index, crop_sha256: p.payload.crop_sha256,
      action: d.value, before, before_sha256: sha256Hex(before),
      after, after_sha256: after === null ? null : sha256Hex(after),
      note: d.value === "unclear" ? d.text : null, decision_id: d.id, decided_at: d.createdAt,
    }];
  });
  return { counts, file: {
    schema: "reference_proofread.v1", batch_id: batch.id, title: batch.title, split: "test", trainable: false,
    reference_sha256: batch.source.reference_sha256, manifest_sha256: batch.source.manifest_sha256,
    counts, lines,
  } };
}
