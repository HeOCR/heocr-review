import type { BatchRecord } from "./types";

/** Restricted rosters are separate from import metadata and survive a re-import. */
export const RESTRICTED_BATCH_PREFIX = "private-ref-";
export const DRAFT_VERIFICATION = "draft_verification";
export const isRestrictedDraftVerification = (batch: BatchRecord): boolean =>
  batch.restrictedReference === true && batch.taskType === "line_verify" && batch.source.restricted_review === DRAFT_VERIFICATION;

export const RESTRICTED_ASSET_PREFIXES = [
  "private-ref-",
  "midcentury_triage_v1",
  "newprinted_midcentury_v0",
  "newprinted_midcentury_goldlines_v0",
] as const;

export function restrictedStaticDirectory(name: string): boolean {
  const lower = name.toLowerCase();
  return RESTRICTED_ASSET_PREFIXES.some((prefix) => prefix.endsWith("-") ? lower.startsWith(prefix) : lower === prefix);
}

const [prefix, triageBatchId] = RESTRICTED_ASSET_PREFIXES;
export const needsRestrictedRoster = (batchId: string) =>
  batchId.startsWith(prefix) || batchId === triageBatchId;

export const protectedReferenceBatchSql = (batchId: string) => `(substr(${batchId},1,${prefix.length}) = '${prefix}'
  OR ${batchId} = '${triageBatchId}'
  OR EXISTS (SELECT 1 FROM batches rb WHERE rb.id=${batchId} AND rb.restricted_reference=1))`;

export const allowedReferencePage = (batchId: string, itemId: string) =>
  `(NOT ${protectedReferenceBatchSql(batchId)} OR EXISTS (
    SELECT 1 FROM restricted_reference_pages rp WHERE rp.batch_id=${batchId} AND rp.item_id=${itemId}
  ))`;

export const ALLOWED_REFERENCE_PROPOSAL = `(NOT ${protectedReferenceBatchSql("p.batch_id")} OR EXISTS (
  SELECT 1 FROM restricted_reference_pages rp JOIN items ri ON ri.id=rp.item_id AND ri.batch_id=rp.batch_id
  WHERE rp.batch_id=p.batch_id AND rp.item_id=p.item_id
    AND ((COALESCE(json_extract(p.payload_json,'$.pass'),1)=1 AND rp.first_allowed=1)
      OR (json_extract(p.payload_json,'$.pass')=2 AND rp.blind_allowed=1 AND p.gate_kind='after_confirm'
        AND EXISTS (SELECT 1 FROM proposals anchor WHERE anchor.batch_id=p.batch_id
          AND anchor.item_id=p.item_id AND anchor.external_id=p.gate_ref
          AND COALESCE(json_extract(anchor.payload_json,'$.pass'),1)=1 AND anchor.active=1)))
))`;
