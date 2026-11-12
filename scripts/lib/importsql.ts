import { createHash } from "node:crypto";
import { canonicalJson, type ImportBundle } from "../../src/tasks/import";
import type { ProposalMedia } from "../../src/tasks/types";
import { lit } from "./sql";

export function contentSha256(contentKey: unknown): string {
  return createHash("sha256").update(canonicalJson(contentKey), "utf8").digest("hex");
}

/**
 * Upsert a batch, its items and proposals. Decisions are never touched: a proposal whose content changed gets a
 * new content hash, so earlier decisions on it become stale (kept, never exported). Proposals that the new file
 * no longer has are deactivated, not deleted.
 */
export function buildImportStatements(
  bundle: ImportBundle,
  media: Map<string, ProposalMedia>,
  opts: { minReviewers: number; importedAt: string },
): string[] {
  const { batch } = bundle;
  const b = lit(batch.id);
  const out: string[] = [
    `INSERT INTO batches (id, task_type, title, source_json, min_reviewers, status, imported_at) VALUES (${b}, ${lit(batch.taskType)}, ${lit(batch.title)}, ${lit(JSON.stringify(batch.source))}, ${opts.minReviewers}, 'open', ${lit(opts.importedAt)})
  ON CONFLICT (id) DO UPDATE SET title = excluded.title, source_json = excluded.source_json, min_reviewers = excluded.min_reviewers, imported_at = excluded.imported_at;`,
  ];
  for (const item of bundle.items) {
    out.push(
      `INSERT INTO items (batch_id, external_id, title, payload_json) VALUES (${b}, ${lit(item.externalId)}, ${lit(item.title)}, ${lit(JSON.stringify(item.payload))})
  ON CONFLICT (batch_id, external_id) DO UPDATE SET title = excluded.title, payload_json = excluded.payload_json;`,
    );
  }
  for (const p of bundle.proposals) {
    const itemId = `(SELECT id FROM items WHERE batch_id = ${b} AND external_id = ${lit(p.itemExternalId)})`;
    out.push(
      `INSERT INTO proposals (batch_id, item_id, external_id, category, confidence, rank, payload_json, media_json, content_sha256, active, gate_kind, gate_ref) VALUES (${b}, ${itemId}, ${lit(p.externalId)}, ${lit(p.category)}, ${lit(p.confidence)}, ${p.rank}, ${lit(JSON.stringify(p.payload))}, ${lit(JSON.stringify(media.get(p.externalId) ?? {}))}, ${lit(contentSha256(p.contentKey))}, 1, ${p.gate ? lit(p.gate.kind) : "NULL"}, ${p.gate?.ref ? lit(p.gate.ref) : "NULL"})
  ON CONFLICT (batch_id, external_id) DO UPDATE SET item_id = excluded.item_id, category = excluded.category, confidence = excluded.confidence, rank = excluded.rank, payload_json = excluded.payload_json, media_json = excluded.media_json, content_sha256 = excluded.content_sha256, active = 1, gate_kind = excluded.gate_kind, gate_ref = excluded.gate_ref;`,
    );
  }
  const keep = bundle.proposals.map((p) => lit(p.externalId)).join(", ");
  out.push(`UPDATE proposals SET active = 0 WHERE batch_id = ${b}${keep ? ` AND external_id NOT IN (${keep})` : ""};`);
  return out;
}

export function buildImportSql(bundle: ImportBundle, media: Map<string, ProposalMedia>, opts: { minReviewers: number; importedAt: string }): string {
  return buildImportStatements(bundle, media, opts).join("\n") + "\n";
}
