import { createHash } from "node:crypto";
import { canonicalJson, type ImportBundle, type ImportProposal } from "../../src/tasks/import";
import type { ProposalMedia, StoredImage } from "../../src/tasks/types";
import { lit } from "./sql";
import { commaSpacingRevision, COMMA_AUDIT } from "./draft-comma-spacing";

export function contentSha256(contentKey: unknown): string {
  return createHash("sha256").update(canonicalJson(contentKey), "utf8").digest("hex");
}

export function importProposalContent(task: string, proposal: ImportProposal, planted = false) {
  const originalSha = contentSha256(proposal.contentKey);
  const correction = planted ? null : commaSpacingRevision(task, proposal.payload, originalSha);
  return { originalSha, correction };
}

/**
 * Upsert a batch, its items and proposals. Decisions are never touched: a proposal whose content changed gets a
 * new content hash, so earlier decisions on it become stale (kept, never exported). Proposals that the new file
 * no longer has are deactivated, not deleted.
 */
/** Above this many proposals the import deactivates the batch first instead of listing every id it keeps. */
export const LARGE_BATCH = 2000;

interface ImportOptions {
  minReviewers: number;
  importedAt: string;
  after?: string[];
  addOnly?: boolean;
  itemImages?: ReadonlyMap<string, StoredImage>;
  planted?: ReadonlySet<string>;
}

export function buildImportStatements(
  bundle: ImportBundle,
  media: Map<string, ProposalMedia>,
  opts: ImportOptions,
): string[] {
  const { batch } = bundle;
  const b = lit(batch.id);
  // addOnly (P-hist gold, scripts/import-gold.ts): upsert these items and proposals into an existing batch, and touch
  // nothing else: no batch row, and no other proposal deactivated.
  const out: string[] = opts.addOnly ? [] : [
    `INSERT INTO batches (id, task_type, title, source_json, min_reviewers, status, imported_at) VALUES (${b}, ${lit(batch.taskType)}, ${lit(batch.title)}, ${lit(JSON.stringify(batch.source))}, ${opts.minReviewers}, 'open', ${lit(opts.importedAt)})
  ON CONFLICT (id) DO UPDATE SET title = excluded.title, source_json = excluded.source_json, min_reviewers = excluded.min_reviewers, imported_at = excluded.imported_at;`,
  ];
  for (const item of bundle.items) {
    const image = opts.itemImages?.get(item.externalId);
    // The batch's import timestamp identifies the current page manifest while retaining old items for decision history.
    const payload = !opts.addOnly && batch.taskType === "line_verify"
      ? { ...item.payload, line_verify_imported_at: opts.importedAt, ...(image ? { page_image: image } : {}) }
      : item.payload;
    out.push(
      `INSERT INTO items (batch_id, external_id, title, payload_json) VALUES (${b}, ${lit(item.externalId)}, ${lit(item.title)}, ${lit(JSON.stringify(payload))})
  ON CONFLICT (batch_id, external_id) DO UPDATE SET title = excluded.title, payload_json = excluded.payload_json;`,
    );
  }
  for (const p of bundle.proposals) {
    const itemId = `(SELECT id FROM items WHERE batch_id = ${b} AND external_id = ${lit(p.itemExternalId)})`;
    const { originalSha, correction } = importProposalContent(batch.taskType, p, opts.planted?.has(p.externalId));
    const payload = lit(JSON.stringify(correction?.payload ?? p.payload));
    const content = lit(correction?.contentSha256 ?? originalSha);
    // A re-import can encounter a prior answer or saved edit on the raw proposal. Keep that revision.
    const keep = `EXISTS (SELECT 1 FROM decisions WHERE proposal_id=proposals.id)
      OR EXISTS (SELECT 1 FROM drafts WHERE proposal_id=proposals.id)`;
    const pinned = `EXISTS (SELECT 1 FROM triage_plants WHERE proposal_id=proposals.id)`;
    const sameSource = `(proposals.content_sha256=${lit(originalSha)} OR json_extract(proposals.payload_json,'$.${COMMA_AUDIT}.content_sha256')=${lit(originalSha)})`;
    const update = (column: string, raw: string) => !correction ? `excluded.${column}` :
      `CASE WHEN ${pinned} OR ((${keep}) AND ${sameSource}) THEN proposals.${column}
        WHEN ${keep} THEN ${raw} ELSE excluded.${column} END`;
    out.push(
      `INSERT INTO proposals (batch_id, item_id, external_id, category, confidence, rank, payload_json, media_json, content_sha256, active, gate_kind, gate_ref) VALUES (${b}, ${itemId}, ${lit(p.externalId)}, ${lit(p.category)}, ${lit(p.confidence)}, ${p.rank}, ${payload}, ${lit(JSON.stringify(media.get(p.externalId) ?? {}))}, ${content}, 1, ${p.gate ? lit(p.gate.kind) : "NULL"}, ${p.gate?.ref ? lit(p.gate.ref) : "NULL"})
  ON CONFLICT (batch_id, external_id) DO UPDATE SET item_id = excluded.item_id, category = excluded.category, confidence = excluded.confidence, rank = excluded.rank, payload_json = ${update("payload_json", lit(JSON.stringify(p.payload)))}, media_json = excluded.media_json, content_sha256 = ${update("content_sha256", lit(originalSha))}, active = 1, gate_kind = excluded.gate_kind, gate_ref = excluded.gate_ref;`,
    );
  }
  // Proposals the bundle no longer has are deactivated. A list of every id would pass D1's statement size limit for a
  // large batch (line_consensus has 18,000 lines), so there the batch is deactivated first and each upsert above
  // (active = 1) brings its proposal back, in the same file.
  if (opts.addOnly) {
    // nothing else changes
  } else if (bundle.proposals.length > LARGE_BATCH) {
    out.splice(1 + bundle.items.length, 0, `UPDATE proposals SET active = 0 WHERE batch_id = ${b};`);
  } else {
    const keep = bundle.proposals.map((p) => lit(p.externalId)).join(", ");
    out.push(`UPDATE proposals SET active = 0 WHERE batch_id = ${b}${keep ? ` AND external_id NOT IN (${keep})` : ""};`);
  }
  out.push(...(opts.after ?? []));
  return out;
}

export function buildImportSql(bundle: ImportBundle, media: Map<string, ProposalMedia>, opts: ImportOptions): string {
  return buildImportStatements(bundle, media, opts).join("\n") + "\n";
}
