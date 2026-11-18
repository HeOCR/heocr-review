/**
 * Task type `line_verify`: a human looks at one printed line on a real scan and a candidate transcription of it
 * (written by a different human: a Wikisource quality-3 proofreader, or Project Ben-Yehuda text aligned to an NLI
 * scan) and marks it exact, edits it, or marks it unreadable or misaligned. `pointed_print` says the letters match
 * but the print has niqqud the candidate lacks; with the letters corrected (niqqud left out) it carries `text`. The export is
 * line_verify_decisions.v1.1 (v1.2 for a line_verify_items.v1.1 batch, with each decision's pass), which hocrgen
 * ingests; its attestation policy, not this app, decides what a verified line becomes. A v1.1 line can carry the agent
 * pre-check's "look here" (never a text) and a blind second pass (`<item_id>@pass2`, see importer.ts).
 *
 * Generic model mapping: a bundle page is an item, a line is a proposal (category = stratum, confidence =
 * candidate_provenance), the queue rank is the bundle's rank (ties by item_id).
 */
import { attentionRuns } from "../../shared/attention";
import type { DecisionOption, Label, LineVerifyView } from "../../shared/api";
import type { Box } from "../../shared/media";
import { imageUrl } from "../../shared/media";
import { sha256Hex } from "../../shared/sha256";
import type { BatchRecord, DecisionRecord, ExportFile, NormalizedDecision, ProposalRecord, ResolvedProposal, StoredImage, TaskType } from "../types";
import {
  DECISIONS_SCHEMA,
  DECISIONS_SCHEMA_V12,
  ITEMS_SCHEMA_V11,
  decisionId,
  decisionsFileProblems,
  hasNiqqud,
  lineTextProblems,
  type LvDecision,
  type LvPage,
  type PixelBox,
} from "./schema";

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
  /** The bundle's item id (a pass-2 proposal's external id is `<item_id>@pass2`). Absent on lines imported before v1.1. */
  item_id?: string;
  /** 2: the blind second pass. Absent (1) on lines imported before v1.1. */
  pass?: 1 | 2;
  /** The line has a blind second pass. */
  blind?: boolean;
  /** The agent pre-check's "look here" (pass 1 of a flagged v1.1 line only): never a proposed text. */
  precheck?: { reasons: string[] } | null;
  /** The page's metadata, copied onto each line so a line can be shown with its attribution. */
  page: Pick<LvPage, "source" | "book_id" | "book_title" | "page_label" | "text_license" | "attribution" | "release_split" | "width" | "height" | "sha256"> & {
    script?: LvPage["script"] | null;
  };
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
  sefaria_edition: { he: "ספריא, נוסח המהדורה", en: "Sefaria, the edition's text" },
  gutenberg_edition: { he: "פרויקט גוטנברג, נוסח המהדורה", en: "Project Gutenberg, the edition's text" },
  benyehuda_text: { he: "פרויקט בן־יהודה", en: "Project Ben-Yehuda" },
  wikisource_he: { he: "ויקיטקסט", en: "Hebrew Wikisource" },
};

export const PROVENANCE_LABELS: Record<string, Label> = {
  wikisource_quality3_single_proofreader: { he: "הוגה בידי מגיה אחד בוויקיטקסט", en: "Proofread once on Wikisource" },
  pby_human_typed_aligned: { he: "הוקלד בידי אדם (בן־יהודה), מותאם לסריקה", en: "Human-typed (Ben-Yehuda), aligned to the scan" },
  sefaria_exact_edition: { he: "נוסח המהדורה הזאת בספריא", en: "This edition's text on Sefaria" },
  gutenberg_exact_edition: { he: "נוסח המהדורה הזאת בפרויקט גוטנברג", en: "This edition's text on Project Gutenberg" },
  pby_human_typed: { he: "הוקלד בידי אדם (בן־יהודה)", en: "Human-typed (Ben-Yehuda)" },
  wikisource_quality4_validated: { he: "הוגה ואומת בוויקיטקסט", en: "Proofread and validated on Wikisource" },
  wikisource_quality1_unproofread: { he: "לא הוגה (ויקיטקסט)", en: "Not proofread (Wikisource)" },
};

export const PRECHECK_LABELS: Record<string, Label> = {
  edge_mismatch: { he: "קצה השורה", en: "line edge" },
  spelling: { he: "כתיב", en: "spelling" },
  digits: { he: "ספרות", en: "digits" },
};

export const SCRIPT_LABELS: Record<string, Label> = {
  square: { he: "אותיות מרובעות", en: "Square script" },
  rashi: { he: "כתב רש״י", en: "Rashi script" },
};

const OPTIONS: DecisionOption[] = [
  { value: "exact", label: { he: "מדויק", en: "Exact" }, withText: false },
  { value: "edited", label: { he: "עריכה", en: "Edit" }, withText: true },
  { value: "unreadable", label: { he: "לא קריא", en: "Unreadable" }, withText: false },
  { value: "misaligned", label: { he: "לא תואם", en: "Misaligned" }, withText: false },
  // The letters match, the print is pointed and the candidate is not. Edit's "print has niqqud" box sends it with text.
  { value: "pointed_print", label: { he: "בדפוס יש ניקוד", en: "Print has niqqud" }, withText: false },
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

const passOf = (p: ProposalRecord): 1 | 2 => payloadOf(p).pass ?? 1;
/** The bundle's item id of a line (both passes). */
const itemIdOf = (p: ProposalRecord): string => payloadOf(p).item_id ?? p.externalId;
const isV11 = (batch: BatchRecord) => sourceOf(batch).schema_version === ITEMS_SCHEMA_V11;
const allOf = (r: ResolvedProposal): DecisionRecord[] => [...r.current, ...r.stale, ...r.superseded];

/** The decision's own fields, in the contract's key order: text for edited, and for pointed_print with corrected letters. */
function body(d: DecisionRecord): Pick<LvDecision, "decision" | "text"> {
  return {
    decision: d.value as LvDecision["decision"],
    ...(d.value === "edited" ? { text: d.text ?? "" } : d.value === "pointed_print" && d.text ? { text: d.text } : {}),
  };
}

/**
 * A reviewer's edit as stored: NFC, without leading or trailing whitespace (a line reference has none). An edit
 * equal to the candidate is recorded as exact. A `pointed_print` text is the corrected letters only: niqqud is
 * refused, and one equal to the candidate is stored without text.
 */
export function normalizeLineDecision(candidate: string, value: string, text: unknown): NormalizedDecision {
  if (value === "exact" || value === "unreadable" || value === "misaligned") {
    if (text !== undefined && text !== null) return { ok: false, error: "only an edited or pointed_print decision carries text" };
    return { ok: true, value, text: null };
  }
  if (value === "pointed_print") {
    if (text === undefined || text === null) return { ok: true, value, text: null };
    if (typeof text !== "string") return { ok: false, error: "a pointed_print text must be the corrected letters" };
    const letters = text.normalize("NFC").trim();
    const problems = lineTextProblems(letters);
    if (problems.length) return { ok: false, error: `the corrected line ${problems.join("; ")}` };
    if (hasNiqqud(letters)) return { ok: false, error: "type the letters only, without niqqud or marks" };
    return { ok: true, value, text: letters === candidate ? null : letters };
  }
  if (value !== "edited") return { ok: false, error: "decision must be exact, edited, unreadable, misaligned or pointed_print" };
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
      script: x.page.script ? { id: x.page.script, label: label(SCRIPT_LABELS, x.page.script) } : null,
      precheck: x.precheck ? { reasons: x.precheck.reasons.map((r) => ({ id: r, label: label(PRECHECK_LABELS, r) })) } : null,
      crop: imageView(p.media.crop),
      page: imageView(p.media.page),
    };
  },

  normalizeDecision(p: ProposalRecord, value: string, text: unknown): NormalizedDecision {
    return normalizeLineDecision(payloadOf(p).candidate_text, value, text);
  },

  /**
   * v1 batches export line_verify_decisions.v1.1, as before. v1.1 batches export v1.2: every decision says its `pass`,
   * and a pass-1 decision on a blind line made after the reviewer first decided its pass 2 is `revised_after_pass2`,
   * with `pass1_at_pass2`, the pass-1 answer that stood then (the one the passes compare).
   */
  exportDecisions(batch: BatchRecord, resolved: ResolvedProposal[]): ExportFile {
    const v12 = isV11(batch);
    // When each reviewer first decided each line's pass 2.
    const pass2At = new Map<string, string>();
    for (const r of resolved) {
      if (passOf(r.proposal) !== 2) continue;
      for (const d of allOf(r)) {
        const key = `${itemIdOf(r.proposal)}\u0000${d.reviewerId}`;
        const at = pass2At.get(key);
        if (at === undefined || d.createdAt < at) pass2At.set(key, d.createdAt);
      }
    }
    const decisions: LvDecision[] = resolved
      .slice()
      .sort((a, b) => payloadOf(a.proposal).order - payloadOf(b.proposal).order || passOf(a.proposal) - passOf(b.proposal))
      .flatMap((r) => {
        const candidateSha = sha256Hex(payloadOf(r.proposal).candidate_text);
        const pass = passOf(r.proposal);
        const itemId = itemIdOf(r.proposal);
        return r.current
          .slice()
          .sort((a, b) => a.reviewerId.localeCompare(b.reviewerId))
          .map((d): LvDecision => {
            const at = v12 && pass === 1 && payloadOf(r.proposal).blind ? pass2At.get(`${itemId}\u0000${d.reviewerId}`) : undefined;
            const revised = at !== undefined && d.createdAt > at;
            const standing = revised
              ? allOf(r)
                  .filter((o) => o.reviewerId === d.reviewerId && o.createdAt <= at)
                  .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
                  .pop()
              : undefined;
            return {
              decision_id: decisionId(r.proposal.externalId, d.reviewerId),
              item_id: itemId,
              reviewer: d.reviewerId,
              ...body(d),
              candidate_sha256: candidateSha,
              ...(v12 ? { pass } : {}),
              ...(at !== undefined ? { revised_after_pass2: revised } : {}),
              ...(revised ? { pass1_at_pass2: standing ? { ...body(standing), decided_at: standing.decidedOn } : null } : {}),
              decided_at: d.decidedOn,
              checked_by: "human",
            };
          });
      });
    return {
      fileName: "line_verify_decisions.json",
      content: { schema_version: v12 ? DECISIONS_SCHEMA_V12 : DECISIONS_SCHEMA, batch_id: sourceOf(batch).batch_id, decisions },
    };
  },

  validateExport(batch: BatchRecord, proposals: ProposalRecord[], content: unknown): string[] {
    const items = proposals
      .filter((p) => p.active && passOf(p) === 1)
      .map((p) => ({
        item_id: itemIdOf(p),
        candidate_text: payloadOf(p).candidate_text,
        candidate_sha256: sha256Hex(payloadOf(p).candidate_text),
        blind: payloadOf(p).blind === true,
      }));
    return decisionsFileProblems(content, sourceOf(batch).batch_id, items);
  },
};
