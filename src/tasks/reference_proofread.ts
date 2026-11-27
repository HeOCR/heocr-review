import { sha256Hex } from "../shared/sha256";
import type { Box } from "../shared/media";
import { lineTextProblems } from "./line_verify/schema";
import type { BatchRecord, DecisionRecord, NormalizedDecision, ProposalRecord, StoredImage } from "./types";

export const PROOFREAD_PREFIX = "private-ref-proofread-";
export const PROOFREAD_KIND = "held_out_line_proofread";
export const PROOFREAD_FILE = "reference_proofread.json";
export const PROOFREAD_SCHEMA = "reference_proofread.v2";
export const MASKED_LINE = "[?]";

export const isReferenceProofread = (batch: BatchRecord) =>
  batch.id.startsWith(PROOFREAD_PREFIX) && batch.restrictedReference === true &&
  batch.taskType === "line_verify" && batch.source.restricted_review === PROOFREAD_KIND &&
  batch.source.proofread_schema === PROOFREAD_SCHEMA &&
  batch.source.split === "test" && batch.source.trainable === false && !batch.source.contributor_scope;

export interface ProofreadRegion {
  leaf: string;
  region: number;
  sha256: string;
  image: StoredImage;
  bands: { ordinal: number; box: Box }[];
}

export interface ProofreadAddition {
  id: string;
  region: ProofreadRegion;
  box: Box;
  text: string;
  createdAt: string;
}

/** Derive a stable insertion slot from vertical geometry in the registered region. */
export function proofreadSlot(region: ProofreadRegion, box: Box): number {
  const center = (box[1] + box[3]) / 2;
  let after = region.bands[0]!.ordinal - 1;
  for (const { ordinal, box: band } of region.bands) {
    if ((band[1] + band[3]) / 2 > center) break;
    after = ordinal;
  }
  return after;
}

export function normalizeProofread(value: string, text: unknown, before: string): NormalizedDecision {
  if (text === undefined || text === null) {
    if (value === "not_in_image") return { ok: true, value, text: null };
    if (value === "exact" && before !== MASKED_LINE) return { ok: true, value, text: null };
  }
  if ((value !== "edited" && value !== "unclear") || typeof text !== "string") {
    return { ok: false, error: "Confirm a readable line, correct it, or choose a mask action." };
  }
  if (/[\r\n\u2028\u2029]/u.test(text)) return { ok: false, error: "Enter one line." };
  const line = text.trim().normalize("NFC");
  if (lineTextProblems(line).length || (value === "edited" && line === MASKED_LINE)) {
    return { ok: false, error: value === "unclear" ? "Enter a short note on one line." : "Enter the visible line or mark it unclear." };
  }
  if (value === "edited" && line === before) return { ok: true, value: "exact", text: null };
  return { ok: true, value, text: line };
}

export function proofreadExport(batch: BatchRecord, proposals: ProposalRecord[], decisions: DecisionRecord[], reviewerId: string,
  additions: ProofreadAddition[]) {
  const counts = { total: proposals.length, answered: 0, confirm: 0, correct: 0, unclear: 0, not_in_image: 0,
    masked: 0, add: additions.length, pending: proposals.length };
  const byId = new Map(decisions.filter(d => d.supersededAt === null && d.reviewerId === reviewerId).map(d => [d.proposalId, d]));
  const lines = [...proposals].sort((a, b) => Number(a.payload.order) - Number(b.payload.order)).flatMap(p => {
    const d = byId.get(p.id);
    if (!d || d.proposalSha256 !== p.contentSha256) return [];
    const before = String(p.payload.candidate_text);
    const action = d.value === "exact" ? "confirm" : d.value === "edited" ? "correct" : d.value;
    if (action !== "confirm" && action !== "correct" && action !== "unclear" && action !== "not_in_image") return [];
    const masked = action === "unclear" || action === "not_in_image";
    const after = masked ? MASKED_LINE : action === "confirm" ? before : d.text!;
    counts[action]++;
    counts.masked += Number(masked);
    counts.answered++;
    counts.pending--;
    return [{
      id: p.externalId, position: p.payload.order, leaf: p.payload.leaf, region: p.payload.region,
      ordinal: p.payload.line_index, crop_sha256: p.payload.crop_sha256,
      action, masked, before, before_sha256: sha256Hex(before), after, after_sha256: sha256Hex(after),
      note: action === "unclear" ? d.text : null, decision_id: d.id, decided_at: d.createdAt,
    }];
  });
  const added = additions.map(a => ({
    id: a.id, action: "add", masked: false, leaf: a.region.leaf, region: a.region.region,
    region_sha256: a.region.sha256, box: a.box, after_ordinal: proofreadSlot(a.region, a.box),
    before: null, before_sha256: null, after: a.text, after_sha256: sha256Hex(a.text), decided_at: a.createdAt,
  })).sort((a, b) => a.leaf.localeCompare(b.leaf) || a.region - b.region || a.after_ordinal - b.after_ordinal ||
    (a.box[1] + a.box[3]) - (b.box[1] + b.box[3]) || b.box[2] - a.box[2] || a.id.localeCompare(b.id));
  return { counts, file: {
    schema: PROOFREAD_SCHEMA, batch_id: batch.id, title: batch.title, split: "test", trainable: false,
    reference_sha256: batch.source.reference_sha256, manifest_sha256: batch.source.manifest_sha256,
    counts, lines, added,
  } };
}
