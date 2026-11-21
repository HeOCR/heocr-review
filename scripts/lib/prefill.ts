/**
 * Plan a draft swap (heocr-eval's test pre-fill protocol, amendment 1): put the drafts of a ratified
 * line_verify_items.v1.3 bundle into a live batch's typed lines that nobody has answered yet.
 *
 * Pure: it reads the bundle and the live rows and returns the updates; scripts/prefill-swap.ts applies them. The bundle
 * must be the live batch exactly, apart from the drafts: with every draft taken out, each of its proposals must hash
 * to the live proposal's content_sha256, and the two must hold the same proposals. Only pass-1 "type" lines with no
 * decision row at all get a draft; the blind second pass never does. Each draft is checked again with the app's own
 * typed-line rule, and one that fails is not written.
 */
import { lineVerifyImporter } from "../../src/tasks/line_verify/importer";
import { ITEMS_SCHEMA_V13, LLM_PROVENANCE, draftProblems, itemsFileProblems, type LvItemsFile } from "../../src/tasks/line_verify/schema";
import { contentSha256 } from "./importsql";
import { COMMA_AUDIT, PUNCTUATION_AUDIT, importSpacingRevision, originalDraftContent, type PunctuationMark } from "./draft-comma-spacing";

export interface LiveProposal {
  id: number;
  external_id: string;
  payload_json: string;
  content_sha256: string;
  /** Decision rows on the proposal, current or superseded. */
  decisions: number;
}

export interface SwapUpdate {
  id: number;
  item_id: string;
  payload_json: string;
  content_sha256: string;
  /** For the undo file. */
  old_payload_json: string;
  old_content_sha256: string;
}

export interface SwapPlan {
  updates: SwapUpdate[];
  skipped_decided: string[];
  /** The live line already holds this very draft. */
  already: number;
  rejected: { item_id: string; problems: string[] }[];
  no_draft: number;
  provenances: string[];
}

export function planPrefillSwap(raw: unknown, batchId: string, live: LiveProposal[], punctuation: readonly PunctuationMark[] = []): SwapPlan {
  const file = raw as LvItemsFile;
  if (!(file && typeof file === "object" && Array.isArray(file.items))) throw new Error("the bundle is not an items file");
  if (file.schema_version !== ITEMS_SCHEMA_V13) throw new Error(`schema_version must be ${ITEMS_SCHEMA_V13}, not ${String(file.schema_version)}`);
  if (file.batch_id !== batchId) throw new Error(`the bundle is batch ${file.batch_id}, not ${batchId}`);
  // Everything but the drafts must be valid; each draft is judged on its own below, and a bad one is only skipped.
  const bare = {
    ...file,
    items: file.items.map((it) => (it.kind === "type" ? { ...it, candidate_text: null, candidate_provenance: null } : it)),
  };
  const problems = itemsFileProblems(bare);
  if (problems.length) throw new Error(`the bundle is not a valid items file:\n${problems.slice(0, 10).join("\n")}`);

  // The bundle without its drafts must be the live batch, proposal for proposal.
  const drafted = lineVerifyImporter.bundle(file).proposals;
  const plain = new Map(lineVerifyImporter.bundle(bare).proposals.map((p) => [p.externalId, p]));
  const liveBy = new Map(live.map((r) => [r.external_id, r]));
  const missing = [...plain.keys()].filter((k) => !liveBy.has(k));
  const extra = live.filter((r) => !plain.has(r.external_id)).map((r) => r.external_id);
  if (missing.length || extra.length) {
    throw new Error(`the bundle and the live batch hold different lines: ${missing.length} only in the bundle (${missing.slice(0, 3).join(", ")}), ${extra.length} only live (${extra.slice(0, 3).join(", ")})`);
  }
  // A live line may already hold a draft from an earlier swap: compare it with that draft in place.
  const liveDraft = (r: LiveProposal) => {
    const x = JSON.parse(r.payload_json) as Record<string, unknown> & { kind?: string; candidate_text?: string; candidate_provenance?: string };
    const original = originalDraftContent(x, r.content_sha256);
    const candidate = (original.fields.candidate_text as string | undefined) ?? x.candidate_text;
    return { candidate: x.kind === "type" && candidate && x.candidate_provenance?.startsWith("llm:") ? candidate : null,
      hash: original.content_sha256 };
  };
  const differ = [...plain.values()]
    .filter((p) => {
      const r = liveBy.get(p.externalId)!;
      const { candidate, hash } = liveDraft(r);
      const key = candidate === null ? p.contentKey : { ...(p.contentKey as Record<string, unknown>), candidate_text: candidate };
      return contentSha256(key) !== hash;
    })
    .map((p) => p.externalId);
  if (differ.length) throw new Error(`${differ.length} line(s) differ from the live batch beyond the drafts: ${differ.slice(0, 5).join(", ")}`);

  const plan: SwapPlan = { updates: [], skipped_decided: [], already: 0, rejected: [], no_draft: 0, provenances: [] };
  const provenances = new Set<string>();
  for (const p of drafted) {
    const payload = p.payload as { kind?: string; pass?: number; candidate_text: string; candidate_provenance: string; item_id: string };
    if (payload.kind !== "type" || payload.pass !== 1) continue;
    if (payload.candidate_text === "") {
      plan.no_draft++;
      continue;
    }
    const row = liveBy.get(p.externalId)!;
    const bad = draftProblems(payload.candidate_text);
    if (!LLM_PROVENANCE.test(payload.candidate_provenance)) bad.push("candidate_provenance is not llm:<model>:<prompt sha256>");
    if (bad.length) {
      plan.rejected.push({ item_id: payload.item_id, problems: bad });
      continue;
    }
    const old = JSON.parse(row.payload_json) as Record<string, unknown>;
    const original = originalDraftContent(old, row.content_sha256);
    const sourceSha = contentSha256(p.contentKey);
    if (old[PUNCTUATION_AUDIT] && original.content_sha256 === sourceSha) {
      plan.already++;
      continue;
    }
    const raw = { ...old, ...original.fields, candidate_text: payload.candidate_text, candidate_provenance: payload.candidate_provenance } as Record<string, unknown>;
    delete raw[COMMA_AUDIT];
    delete raw[PUNCTUATION_AUDIT];
    const corrected = importSpacingRevision("line_verify", raw, sourceSha, punctuation);
    const newSha = corrected?.contentSha256 ?? sourceSha;
    if (row.content_sha256 === newSha) {
      plan.already++;
      continue;
    }
    if (row.decisions > 0) {
      plan.skipped_decided.push(payload.item_id);
      continue;
    }
    provenances.add(payload.candidate_provenance);
    plan.updates.push({
      id: row.id,
      item_id: payload.item_id,
      payload_json: JSON.stringify(corrected?.payload ?? raw),
      content_sha256: newSha,
      old_payload_json: row.payload_json,
      old_content_sha256: row.content_sha256,
    });
  }
  plan.provenances = [...provenances].sort();
  return plan;
}
