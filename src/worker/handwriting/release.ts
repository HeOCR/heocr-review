import { json } from "../http";
import { activePage, body, conflict, digestPattern, erasePrefix, invalid, isString, keyFor, mediaPath, mediaResponse,
  newId, notFound, privateCode, sha, slotFor, withdrawn, type Intake } from "./core";

const retentionDays = 90;
const period = retentionDays * 24 * 60 * 60 * 1000;
const releaseKey = (c: Intake, page: string) => keyFor(c, "published/" + page);
const closureKey = (c: Intake) => keyFor(c, "closed.json");

async function closedAt(c: Intake) {
  const object = await c.control.get(closureKey(c));
  if (!object) return null;
  const record = await object.json<{ at: number }>();
  if (!Number.isSafeInteger(record.at) || record.at <= 0) throw conflict();
  return record.at;
}

export async function closeCollection(c: Intake) {
  await c.control.put(closureKey(c), JSON.stringify({ at: c.now }), { onlyIf: { etagDoesNotMatch: "*" } });
  return json({ closedAt: await closedAt(c) });
}

async function sweepPage(c: Intake, page: string) {
  await c.db.batch([
    c.db.prepare(`UPDATE hw_candidates SET invalid=1,manifest='' WHERE sha IN
      (SELECT candidate FROM hw_candidate_pages WHERE page=?)`).bind(page),
    c.db.prepare("UPDATE hw_pages SET withdrawn=1,current_version=NULL WHERE id=?").bind(page),
    c.db.prepare("DELETE FROM hw_tokens WHERE page=?").bind(page),
    c.db.prepare("UPDATE hw_versions SET state='retired', geometry=NULL, split='pending' WHERE page=?").bind(page),
    c.db.prepare(`DELETE FROM hw_lines WHERE geometry IN
      (SELECT g.id FROM hw_geometry g JOIN hw_versions v ON v.id=g.version WHERE v.page=?)`).bind(page),
  ]);
  await erasePrefix(c, mediaPath(c, page));
  if ((await c.media.list({ prefix: mediaPath(c, page), limit: 1 })).objects.length) throw conflict();
}

export async function withdraw(c: Intake) {
  const { receiptCode } = await body(c);
  if (!isString(receiptCode) || !/^hw-[a-f0-9]{32}$/.test(receiptCode)) throw invalid();
  const page = await c.db.prepare("SELECT id FROM hw_pages WHERE receipt=?")
    .bind(await privateCode(c, "receipt lookup", receiptCode)).first<{ id: string }>();
  if (!page) throw notFound();
  if (await c.control.head(releaseKey(c, page.id))) throw conflict();
  // The authoritative tombstone precedes removal. Restoring an older intake snapshot never removes it.
  await c.control.put(keyFor(c, "withdrawals/" + page.id), "withdrawn", { onlyIf: { etagDoesNotMatch: "*" } });
  await sweepPage(c, page.id);
  return json({ withdrawn: true, activeMediaRemaining: 0 });
}

async function published(c: Intake, page: string, version: string) {
  const record = await c.control.get(releaseKey(c, page));
  if (!record) return false;
  const value = await record.json<{ version: string; manifest: string }>();
  if (!digestPattern.test(value.manifest)) throw conflict();
  return value.version === version;
}

type ReaderEvidence = { reviewer: string; wording_version: string; wording_sha: string };
const evidenceKey = (row: ReaderEvidence) => JSON.stringify([row.reviewer, row.wording_version, row.wording_sha]);

export async function retentionExpired(c: Intake) {
  const closed = await closedAt(c);
  return closed !== null && c.now >= closed + period;
}

async function pruneConsent(c: Intake) {
  if (!await retentionExpired(c)) return 0;
  const { results } = await c.db.prepare("SELECT version,page FROM hw_consent").all<{ version: string; page: string }>();
  const deletes = [];
  for (const row of results) {
    if (!await published(c, row.page, row.version)) deletes.push(c.db.prepare("DELETE FROM hw_consent WHERE version=?").bind(row.version));
  }
  for (let i = 0; i < deletes.length; i += 50) await c.db.batch(deletes.slice(i, i + 50));
  // Reviewers' evidence is shared across pages. Keep it only for readers who contributed to a published crop.
  const readers = await c.db.prepare(`SELECT DISTINCT r.reviewer,r.wording_version,r.wording_sha,v.page,v.id AS version
    FROM hw_reads r JOIN hw_lines l ON l.id=r.line JOIN hw_geometry g ON g.id=l.geometry
    JOIN hw_versions v ON v.id=g.version`).all<ReaderEvidence & { page: string; version: string }>();
  const retain = new Set<string>();
  const released = new Map<string, boolean>();
  for (const row of readers.results) {
    const key = row.page + "/" + row.version;
    if (!released.has(key)) released.set(key, await published(c, row.page, row.version));
    if (released.get(key)) retain.add(evidenceKey(row));
  }
  const { results: consent } = await c.db.prepare("SELECT reviewer,wording_version,wording_sha FROM hw_reader_consent").all<ReaderEvidence>();
  for (const row of consent) {
    if (!retain.has(evidenceKey(row))) {
      await c.db.prepare("DELETE FROM hw_reader_consent WHERE reviewer=? AND wording_version=? AND wording_sha=?")
        .bind(row.reviewer, row.wording_version, row.wording_sha).run();
    }
  }
  return deletes.length;
}

export async function reconcile(c: Intake) {
  const { results } = await c.db.prepare("SELECT id FROM hw_pages").all<{ id: string }>();
  let swept = 0;
  for (const row of results) {
    if (await withdrawn(c, row.id)) {
      await sweepPage(c, row.id);
      swept++;
    }
  }
  return json({ swept, expiredWriterConsent: await pruneConsent(c) });
}

export async function consentLedger(c: Intake) {
  await pruneConsent(c);
  const { results } = await c.db.prepare(`SELECT version,page,language,wording_version,wording_sha,agreed_at
    FROM hw_consent ORDER BY agreed_at`).all<{ page: string }>();
  const agreements = [];
  for (const row of results) if (!await withdrawn(c, row.page)) agreements.push(row);
  const reviewers = await c.db.prepare("SELECT reviewer,language,wording_version,wording_sha,agreed_at FROM hw_reader_consent").all();
  return json({ agreements, readerAgreements: reviewers.results });
}

export async function evalCheck(c: Intake) {
  const rows = await c.db.prepare(`SELECT p.id AS page,p.writer,p.source,p.slot,v.id AS version,v.parent,v.sha,v.state,v.split,v.geometry
    FROM hw_pages p JOIN hw_versions v ON p.id=v.page WHERE p.withdrawn=0 ORDER BY p.id,v.id`).all<{ page: string; version: string; geometry: string | null }>();
  const result = [];
  for (const row of rows.results) {
    if (!await withdrawn(c, row.page)) {
      const lineage = await c.db.prepare("SELECT id,parent,page_sha FROM hw_geometry WHERE version=? ORDER BY id")
        .bind(row.version).all<{ id: string }>();
      const geometry = [];
      for (const record of lineage.results) {
        const crops = await c.db.prepare("SELECT position,sha,polygon FROM hw_lines WHERE geometry=? ORDER BY position").bind(record.id).all();
        geometry.push({ ...record, crops: crops.results });
      }
      result.push({ ...row, geometryHistory: geometry });
    }
  }
  return json({ submissions: result });
}

type Selection = { id: string; version: string; geometry: string; page_sha: string; slot: string };
async function releasePages(c: Intake) {
  const rows = await c.db.prepare(`SELECT p.id,v.id AS version,v.geometry,g.page_sha,p.slot
    FROM hw_pages p JOIN hw_versions v ON p.current_version=v.id JOIN hw_geometry g ON g.id=v.geometry
    JOIN hw_consent a ON a.version=v.id WHERE p.withdrawn=0 AND v.state='cleared' AND v.split='clear'
    AND (SELECT COUNT(*) FROM hw_lines l JOIN hw_resolution r ON r.line=l.id WHERE l.geometry=g.id AND r.reference IS NOT NULL)=10
    ORDER BY p.id`).all<Selection>();
  const pages: Selection[] = [];
  for (const row of rows.results) if (!await withdrawn(c, row.id)) pages.push(row);
  return pages;
}

export async function buildCandidate(c: Intake) {
  if (await closedAt(c) === null) throw conflict();
  await pruneConsent(c);
  const pages = await releasePages(c);
  if (!pages.length) throw conflict();
  const exported = [];
  for (const [i, p] of pages.entries()) {
    const { slot } = await slotFor(c, p.slot);
    const rows = await c.db.prepare(`SELECT l.position,l.sha,r.reference FROM hw_lines l JOIN hw_resolution r ON r.line=l.id
      WHERE l.geometry=? ORDER BY l.position`).bind(p.geometry).all();
    if (!await c.media.head(mediaPath(c, p.id, "derived/" + p.geometry + "/page"))) throw conflict();
    exported.push({ page: "page-" + (i + 1), sha256: p.page_sha, capture: slot.capture, pen: slot.pen, paper: slot.paper,
      image: "page-" + (i + 1) + "/page.png", lines: rows.results.map(row => ({
        position: row.position, sha256: row.sha, reference: row.reference, image: "page-" + (i + 1) + "/line-" + row.position + ".png",
      })) });
  }
  const manifest = { generation: newId(), population: "prompted real handwriting", rightsAtPublication: "CC0-1.0", writers: pages.length, pages: exported };
  const serialized = JSON.stringify(manifest);
  const hash = await sha(serialized);
  const writes = [c.db.prepare("INSERT INTO hw_candidates(sha,manifest) VALUES(?,?) ON CONFLICT DO NOTHING").bind(hash, serialized)];
  for (const p of pages) {
    writes.push(c.db.prepare("INSERT INTO hw_candidate_pages(candidate,page,geometry) VALUES(?,?,?) ON CONFLICT DO NOTHING").bind(hash, p.id, p.geometry));
  }
  await c.db.batch(writes);
  return candidate(c, hash);
}

async function validCandidate(c: Intake, hash: string) {
  if (!digestPattern.test(hash)) throw notFound();
  await pruneConsent(c);
  const candidate = await c.db.prepare("SELECT manifest FROM hw_candidates WHERE sha=? AND invalid=0")
    .bind(hash).first<{ manifest: string }>();
  if (!candidate || await sha(candidate.manifest) !== hash) throw notFound();
  const { results } = await c.db.prepare("SELECT page,geometry FROM hw_candidate_pages WHERE candidate=? ORDER BY page")
    .bind(hash).all<{ page: string; geometry: string }>();
  const eligible = new Map((await releasePages(c)).map(p => [p.id, p.geometry]));
  if (!results.length || results.some(p => eligible.get(p.page) !== p.geometry)) throw notFound();
  const manifest: unknown = JSON.parse(candidate.manifest);
  return { manifest, results };
}

export async function candidate(c: Intake, hash: string) {
  const { manifest } = await validCandidate(c, hash);
  return json({ sha256: hash, manifest });
}

export async function candidateAsset(c: Intake, hash: string, page: number, line: number) {
  const { results } = await validCandidate(c, hash);
  const p = results[page - 1];
  if (!p || line < 0 || line > 10) throw notFound();
  const asset = line === 0
    ? await c.db.prepare("SELECT 'page' AS id,page_sha AS sha FROM hw_geometry WHERE id=?").bind(p.geometry).first<{ id: string; sha: string }>()
    : await c.db.prepare("SELECT id,sha FROM hw_lines WHERE geometry=? AND position=?").bind(p.geometry, line).first<{ id: string; sha: string }>();
  if (!asset) throw notFound();
  await activePage(c, p.page);
  return mediaResponse(c, p.page, "derived/" + p.geometry + "/" + asset.id, "image/png", asset.sha);
}
