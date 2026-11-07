/**
 * Task type `line_verify`: a human looks at one printed line on a real scan and a candidate transcription of it
 * (written by a different human: a Wikisource quality-3 proofreader, or Project Ben-Yehuda text aligned to an NLI
 * scan) and marks it exact, edits it, or marks it unreadable or misaligned. The export is
 * line_verify_decisions.v1, which hocrgen ingests; its attestation policy, not this app, decides what a verified
 * line becomes.
 *
 * Generic model mapping: a bundle page is an item, a line is a proposal (category = stratum, confidence =
 * candidate_provenance), the queue rank is the bundle's rank (ties by item_id).
 */
import { attentionRuns } from "../../shared/attention";
import type { DecisionOption, Label, LineVerifyView } from "../../shared/api";
import type { Box } from "../../shared/media";
import { imageUrl } from "../../shared/media";
import { sha256Hex } from "../../shared/sha256";
import type { BatchRecord, ExportFile, NormalizedDecision, ProposalRecord, ResolvedProposal, StoredImage, TaskType } from "../types";
import { DECISIONS_SCHEMA, decisionId, decisionsFileProblems, lineTextProblems, type LvDecision, type LvPage, type PixelBox } from "./schema";

export const TASK_TYPE_ID = "line_verify";

/** What the importer stores per line (proposals.payload_json). */
export interface LineVerifyPayload {
  page_id: string;
  line_index: number;
  box: PixelBox;
  context_box: PixelBox;
  candidate_text: string;
  candidate_provenance: string;
  alignment_score: number;
  attention_spans: [number, number][];
  difficulty: number;
  stratum: string;
  /** The bundle's own rank (the stored rank is its dense, tie-broken order). */
  bundle_rank: number;
  /** Position in items.json, so the export keeps hocrgen's order. */
  order: number;
  /** The page's metadata, copied onto each line so a line can be shown with its attribution. */
  page: Pick<LvPage, "source" | "book_id" | "book_title" | "page_label" | "text_license" | "attribution" | "release_split" | "width" | "height" | "sha256">;
}

/** What the importer stores per batch (batches.source_json). */
export interface LineVerifySource {
  schema_version: string;
  batch_id: string;
  description: string;
  created_at: string;
  generator: { tool: string; ref?: string };
}

export const SOURCE_LABELS: Record<string, Label> = {
  wikisource_he_proofread: { he: "ויקיטקסט", en: "Hebrew Wikisource" },
  benyehuda_nli_aligned: { he: "פרויקט בן־יהודה, סריקת הספרייה הלאומית", en: "Project Ben-Yehuda text, NLI scan" },
};

export const PROVENANCE_LABELS: Record<string, Label> = {
  wikisource_quality3_single_proofreader: { he: "הוגה בידי מגיה אחד בוויקיטקסט", en: "Proofread once on Wikisource" },
  pby_human_typed_aligned: { he: "הוקלד בידי אדם (בן־יהודה), מותאם לסריקה", en: "Human-typed (Ben-Yehuda), aligned to the scan" },
};

const OPTIONS: DecisionOption[] = [
  { value: "exact", label: { he: "מדויק", en: "Exact" }, withText: false },
  { value: "edited", label: { he: "עריכה", en: "Edit" }, withText: true },
  { value: "unreadable", label: { he: "לא קריא", en: "Unreadable" }, withText: false },
  { value: "misaligned", label: { he: "לא תואם", en: "Misaligned" }, withText: false },
];

function payloadOf(p: ProposalRecord): LineVerifyPayload {
  return p.payload as unknown as LineVerifyPayload;
}

function sourceOf(batch: BatchRecord): LineVerifySource {
  return batch.source as unknown as LineVerifySource;
}

function imageView(img: StoredImage | undefined) {
  return img ? { url: imageUrl(img.ref), width: img.width, height: img.height, box: img.box as Box | null, outlined: img.outlined === true } : null;
}

const label = (labels: Record<string, Label>, id: string): Label => labels[id] ?? { he: id, en: id };

/**
 * A reviewer's edit as stored: NFC, without leading or trailing whitespace (a line reference has none). An edit
 * equal to the candidate is recorded as exact.
 */
export function normalizeLineDecision(candidate: string, value: string, text: unknown): NormalizedDecision {
  if (value === "exact" || value === "unreadable" || value === "misaligned") {
    if (text !== undefined && text !== null) return { ok: false, error: "only an edited decision carries text" };
    return { ok: true, value, text: null };
  }
  if (value !== "edited") return { ok: false, error: "decision must be exact, edited, unreadable or misaligned" };
  if (typeof text !== "string") return { ok: false, error: "an edited decision needs the corrected line" };
  const edited = text.normalize("NFC").trim();
  const problems = lineTextProblems(edited);
  if (problems.length) return { ok: false, error: `the corrected line ${problems.join("; ")}` };
  if (edited === candidate) return { ok: true, value: "exact", text: null };
  return { ok: true, value: "edited", text: edited };
}

export const lineVerify: TaskType = {
  id: TASK_TYPE_ID,
  label: { he: "אימות שורות מול הסריקה", en: "Line verification" },
  options: OPTIONS,
  // The page is shown only on request; prefetching it for every line would cost a phone ~10x the bytes.
  prefetch: ["crop"],

  toView(p: ProposalRecord): LineVerifyView {
    const x = payloadOf(p);
    return {
      kind: "line_verify",
      candidate: x.candidate_text,
      runs: attentionRuns(x.candidate_text, x.attention_spans),
      lineIndex: x.line_index,
      provenance: { id: x.candidate_provenance, label: label(PROVENANCE_LABELS, x.candidate_provenance) },
      source: { id: x.page.source, label: label(SOURCE_LABELS, x.page.source) },
      bookTitle: x.page.book_title,
      pageLabel: x.page.page_label,
      attribution: x.page.attribution,
      textLicense: x.page.text_license,
      crop: imageView(p.media.crop),
      page: imageView(p.media.page),
    };
  },

  normalizeDecision(p: ProposalRecord, value: string, text: unknown): NormalizedDecision {
    return normalizeLineDecision(payloadOf(p).candidate_text, value, text);
  },

  exportDecisions(batch: BatchRecord, resolved: ResolvedProposal[]): ExportFile {
    const decisions: LvDecision[] = resolved
      .slice()
      .sort((a, b) => payloadOf(a.proposal).order - payloadOf(b.proposal).order)
      .flatMap((r) => {
        const candidateSha = sha256Hex(payloadOf(r.proposal).candidate_text);
        return r.current
          .slice()
          .sort((a, b) => a.reviewerId.localeCompare(b.reviewerId))
          .map((d): LvDecision => ({
            // The contract's key order; text only for edited.
            decision_id: decisionId(r.proposal.externalId, d.reviewerId),
            item_id: r.proposal.externalId,
            reviewer: d.reviewerId,
            decision: d.value as LvDecision["decision"],
            ...(d.value === "edited" ? { text: d.text ?? "" } : {}),
            candidate_sha256: candidateSha,
            decided_at: d.decidedOn,
            checked_by: "human",
          }));
      });
    return {
      fileName: "line_verify_decisions.json",
      content: { schema_version: DECISIONS_SCHEMA, batch_id: sourceOf(batch).batch_id, decisions },
    };
  },

  validateExport(batch: BatchRecord, proposals: ProposalRecord[], content: unknown): string[] {
    const items = proposals
      .filter((p) => p.active)
      .map((p) => ({ item_id: p.externalId, candidate_text: payloadOf(p).candidate_text, candidate_sha256: sha256Hex(payloadOf(p).candidate_text) }));
    return decisionsFileProblems(content, sourceOf(batch).batch_id, items);
  },
};
