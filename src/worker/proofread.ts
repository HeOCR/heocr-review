import type { Box } from "../shared/media";
import type { ProofreadAddition, ProofreadRegion } from "../tasks/reference_proofread";
import { allowedReferencePage } from "../tasks/restricted_reference";
import { randomId } from "./crypto";

export async function readProofreadRegion(db: D1Database, batchId: string, externalId: string) {
  const row = await db.prepare(`SELECT i.id, json_extract(i.payload_json,'$.proofread_region') AS region
    FROM items i WHERE i.batch_id=?1 AND i.external_id=?2 AND ${allowedReferencePage("i.batch_id", "i.id")}`)
    .bind(batchId, externalId).first<{ id: number; region: string | null }>();
  if (!row?.region) return null;
  return { id: row.id, region: JSON.parse(row.region) as ProofreadRegion };
}

export async function proofreadAdditions(db: D1Database, batchId: string, reviewerId: string, itemId: number | null = null): Promise<ProofreadAddition[]> {
  const { results } = await db.prepare(`SELECT a.id,a.text,a.box_json,a.created_at,json_extract(i.payload_json,'$.proofread_region') AS region
    FROM page_added_lines a JOIN items i ON i.batch_id=a.batch_id AND i.id=a.item_id
    WHERE a.batch_id=?1 AND a.reviewer_id=?2 AND a.removed_at IS NULL AND (?3 IS NULL OR a.item_id=?3)
      AND ${allowedReferencePage("i.batch_id", "i.id")} ORDER BY a.created_at,a.id`)
    .bind(batchId, reviewerId, itemId).all<{ id: string; text: string; box_json: string; created_at: string; region: string }>();
  return results.map(row => ({ id: row.id, region: JSON.parse(row.region) as ProofreadRegion,
    box: JSON.parse(row.box_json) as Box, text: row.text, createdAt: row.created_at }));
}

export async function addProofreadLine(db: D1Database, batchId: string, itemId: number, reviewerId: string, box: Box, text: string, at: string) {
  const id = randomId("pl-");
  const encoded = JSON.stringify(box);
  const result = await db.prepare(`INSERT INTO page_added_lines(id,batch_id,item_id,reviewer_id,box_json,text,value,created_at,decided_on)
    SELECT ?1,b.id,i.id,?4,?5,?6,'typed',?7,?8 FROM batches b JOIN items i ON i.batch_id=b.id
    WHERE b.id=?2 AND i.id=?3 AND b.status='open' AND b.restricted_reference=1
      AND ${allowedReferencePage("i.batch_id", "i.id")}
      AND NOT EXISTS (SELECT 1 FROM page_added_lines a WHERE a.batch_id=b.id AND a.item_id=i.id AND a.reviewer_id=?4
        AND a.removed_at IS NULL AND a.box_json=?5)`)
    .bind(id, batchId, itemId, reviewerId, encoded, text, at, at.slice(0, 10)).run();
  if (result.meta.changes === 1) return id;
  // A retried save of the same box and text returns its original ID.
  return db.prepare(`SELECT a.id FROM page_added_lines a JOIN batches b ON b.id=a.batch_id
    WHERE a.batch_id=?1 AND a.item_id=?2 AND a.reviewer_id=?3 AND a.box_json=?4 AND a.text=?5
      AND a.removed_at IS NULL AND b.status='open' AND ${allowedReferencePage("a.batch_id", "a.item_id")}`)
    .bind(batchId, itemId, reviewerId, encoded, text).first<string>("id");
}

export async function removeProofreadLine(db: D1Database, batchId: string, itemId: number, reviewerId: string, id: string, at: string) {
  const result = await db.prepare(`UPDATE page_added_lines SET removed_at=?5
    WHERE id=?4 AND batch_id=?1 AND item_id=?2 AND reviewer_id=?3 AND removed_at IS NULL
      AND EXISTS (SELECT 1 FROM batches WHERE id=?1 AND status='open' AND restricted_reference=1)
      AND ${allowedReferencePage("page_added_lines.batch_id", "page_added_lines.item_id")}`)
    .bind(batchId, itemId, reviewerId, id, at).run();
  return result.meta.changes === 1;
}
