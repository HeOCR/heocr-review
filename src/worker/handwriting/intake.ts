import { json, readBytes } from "../http";
import { activePage, activeVersion, body, conflict, digestPattern, erasePrefix, inputId, invalid, isString, keyFor, language,
  mediaPath, mediaResponse, newId, notFound, privateCode, putMedia, sha, slotFor, withdrawalEmail, withdrawn, wording,
  type Intake, type Version } from "./core";
import { imageFrame, MAX_ORIGINAL } from "./image";
import { linePolygons, polygonBounds } from "../../shared/handwriting-geometry";

const tokenAge = 7 * 24 * 60 * 60 * 1000;
type Token = { page: string; replaces: string | null; expires: number; original_sha: string | null; version: string | null };

async function collectionOpen(c: Intake) {
  if (await c.control.head(keyFor(c, "closed.json"))) throw notFound();
}

export async function issue(c: Intake, pageId?: string) {
  await collectionOpen(c);
  const token = newId() + newId();
  const hash = await privateCode(c, "token", token);
  const expires = c.now + tokenAge;
  if (pageId) {
    const page = await activePage(c, pageId);
    if (!page.current_version) throw conflict();
    // Retakes stay on the original participant and assignment lineage.
    const r = await c.db.prepare(`INSERT INTO hw_tokens(hash,page,replaces,expires)
      SELECT ?,id,current_version,? FROM hw_pages WHERE id=? AND withdrawn=0 AND current_version=?
      AND NOT EXISTS(SELECT 1 FROM hw_tokens WHERE page=? AND replaces=? AND expires>?)`)
      .bind(hash, expires, pageId, page.current_version, pageId, page.current_version, c.now).run();
    if (!r.meta.changes) throw conflict();
  } else {
    const form = await body(c);
    const slug = inputId(form.slot);
    const writer = await privateCode(c, "writer", inputId(form.writerKey));
    const source = await privateCode(c, "source", inputId(form.sourceKey));
    const account = inputId(form.writerReviewerId);
    if (!/^rv_[0-9a-f]{8}$/.test(account)) throw invalid();
    const writerAccount = await privateCode(c, "account", account);
    const { packet } = await slotFor(c, slug);
    pageId = newId();
    const code = await receiptCode(c, pageId);
    const r = await c.db.batch([
      c.db.prepare(`INSERT INTO hw_pages(id,slot,writer,writer_account,source,receipt,prompt_hash)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
        .bind(pageId, slug, writer, writerAccount, source, await privateCode(c, "receipt lookup", code), packet.sha256),
      c.db.prepare("INSERT INTO hw_tokens(hash,page,expires) SELECT ?,id,? FROM hw_pages WHERE id=?")
        .bind(hash, expires, pageId),
    ]);
    if (!r[0]?.meta.changes) throw conflict();
  }
  return json({ pageId, token, expires }, 201);
}

async function invitation(c: Intake) {
  const raw = c.request.headers.get("authorization")?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if (!raw) throw notFound();
  const hash = await privateCode(c, "token", raw);
  const token = await c.db.prepare("SELECT * FROM hw_tokens WHERE hash=? AND expires>?").bind(hash, c.now).first<Token>();
  if (!token) throw notFound();
  const page = await activePage(c, token.page);
  return { hash, token, page };
}

async function receiptCode(c: Intake, id: string) {
  return "hw-" + (await privateCode(c, "receipt issuance", id)).slice(0, 32);
}

export async function inviteInfo(c: Intake) {
  await collectionOpen(c);
  const { token, page } = await invitation(c);
  if (page.current_version !== token.replaces && page.current_version !== token.version) throw notFound();
  const { slot, packet } = await slotFor(c, page.slot);
  if (packet.sha256 !== page.prompt_hash) throw conflict();
  const lang = language(new URL(c.request.url).searchParams.get("lang") ?? "he");
  return json({ assignment: slot, prompt: packet.text, promptSha256: packet.sha256,
    consent: await wording(c, "writerConsent", lang), retentionNotice: c.config.retentionNotice[lang] });
}

export async function upload(c: Intake) {
  await collectionOpen(c);
  const { hash, token, page } = await invitation(c);
  const { packet } = await slotFor(c, page.slot);
  const lang = language(c.request.headers.get("x-intake-language"));
  const agreement = await wording(c, "writerConsent", lang);
  if (c.request.headers.get("x-intake-agree") !== "yes" ||
      c.request.headers.get("x-intake-wording-version") !== agreement.version ||
      c.request.headers.get("x-intake-wording-sha256") !== agreement.sha256 ||
      c.request.headers.get("x-intake-prompt-sha256") !== page.prompt_hash || packet.sha256 !== page.prompt_hash) throw conflict();
  const bytes = await readBytes(c.request, MAX_ORIGINAL, "invalid_intake_input");
  const frame = imageFrame(bytes);
  if (!frame || c.request.headers.get("content-type") !== frame.mime) throw invalid();
  const digest = await sha(bytes);
  // A retry of the same invitation/file returns the same receipt. It cannot revive a retired revision.
  if (token.original_sha && token.original_sha !== digest) throw conflict();
  const duplicate = await c.db.prepare("SELECT id FROM hw_versions WHERE page=? AND sha=?").bind(page.id, digest).first<{ id: string }>();
  const sameActive = duplicate?.id === page.current_version;
  if (duplicate && !sameActive && duplicate.id !== token.version) throw conflict();
  if (!token.original_sha && page.current_version !== token.replaces) throw conflict();
  const id = token.version ?? (sameActive ? page.current_version! : newId());
  await c.db.batch([
    c.db.prepare(`UPDATE hw_tokens SET original_sha=?,version=? WHERE hash=? AND original_sha IS NULL
      AND EXISTS(SELECT 1 FROM hw_pages WHERE id=? AND withdrawn=0 AND current_version IS ?)`)
      .bind(digest, id, hash, page.id, token.replaces),
    c.db.prepare(`INSERT INTO hw_consent(version,page,language,wording_version,wording_sha,agreed_at)
      SELECT version,page,?,?,?,? FROM hw_tokens WHERE hash=? AND version=? AND original_sha=?
      AND EXISTS(SELECT 1 FROM hw_pages WHERE id=? AND withdrawn=0) ON CONFLICT(version) DO NOTHING`)
      .bind(lang, agreement.version, agreement.sha256, c.now, hash, id, digest, page.id),
    c.db.prepare(`INSERT INTO hw_versions(id,page,parent,sha,mime,width,height,state)
      SELECT t.version,t.page,t.replaces,?,?,?,?, 'pending' FROM hw_tokens t JOIN hw_consent a ON a.version=t.version
      WHERE t.hash=? AND t.version=? AND t.original_sha=? ON CONFLICT DO NOTHING`)
      .bind(digest, frame.mime, frame.width, frame.height, hash, id, digest),
  ]);
  const pinned = await c.db.prepare(`SELECT t.version,t.original_sha,a.wording_sha,a.wording_version,a.language
      FROM hw_tokens t JOIN hw_consent a ON a.version=t.version JOIN hw_versions v ON v.id=t.version WHERE t.hash=?`)
    .bind(hash).first<{ version: string; original_sha: string; wording_sha: string; wording_version: string; language: string }>();
  if (!pinned || pinned.original_sha !== digest || pinned.wording_sha !== agreement.sha256 || pinned.language !== lang) throw conflict();
  const saved = await activePage(c, page.id);
  const version = pinned.version;
  if (saved.current_version !== version) {
    if (saved.current_version !== token.replaces) throw conflict();
    await putMedia(c, page.id, "original/" + version, bytes);
    const [update] = await c.db.batch([
      c.db.prepare("UPDATE hw_pages SET current_version=? WHERE id=? AND withdrawn=0 AND current_version IS ?")
        .bind(version, page.id, token.replaces),
      c.db.prepare(`UPDATE hw_versions SET state='retired' WHERE id=? AND EXISTS
        (SELECT 1 FROM hw_pages WHERE id=? AND current_version=? AND withdrawn=0)`).bind(token.replaces, page.id, version),
      invalidatePage(c, page.id, version, token.replaces),
    ]);
    if (!update?.meta.changes && (await activePage(c, page.id)).current_version !== version) {
      await c.media.delete(mediaPath(c, page.id, "original/" + version));
      throw conflict();
    }
  }
  if (token.replaces && token.replaces !== version) {
    const old = await c.db.prepare("SELECT geometry FROM hw_versions WHERE id=? AND state='retired'").bind(token.replaces).first<{ geometry: string | null }>();
    if (old) {
      await c.media.delete(mediaPath(c, page.id, "original/" + token.replaces));
      if (old.geometry) await erasePrefix(c, mediaPath(c, page.id, "derived/" + old.geometry + "/"));
    }
  }
  await activePage(c, page.id);
  return json({ receiptCode: await receiptCode(c, page.id), withdrawalEmail, consent: agreement, retentionNotice: c.config.retentionNotice[lang] }, 201);
}

function invalidatePage(c: Intake, page: string, current: string, parent: string | null) {
  return c.db.prepare(`UPDATE hw_candidates SET invalid=1 WHERE sha IN (SELECT candidate FROM hw_candidate_pages WHERE page=?)
    AND EXISTS(SELECT 1 FROM hw_pages WHERE id=? AND current_version=? AND withdrawn=0) AND ? IS NOT NULL`)
    .bind(page, page, current, parent);
}

export async function intakeList(c: Intake) {
  const { results } = await c.db.prepare(`SELECT p.id AS pageId,p.slot,v.id AS version,v.sha,v.state,v.width,v.height
    FROM hw_pages p JOIN hw_versions v ON v.id=p.current_version WHERE p.withdrawn=0 ORDER BY p.id`).all<{ pageId: string }>();
  const out = [];
  for (const row of results) if (!await withdrawn(c, row.pageId)) out.push(row);
  return json({ submissions: out });
}

export async function original(c: Intake, pageId: string, versionId: string) {
  const v = await activeVersion(c, await activePage(c, pageId), versionId);
  return mediaResponse(c, pageId, "original/" + v.id, v.mime);
}

export async function screen(c: Intake, actor: string, pageId: string, versionId: string) {
  const p = await activePage(c, pageId);
  const v = await activeVersion(c, p, versionId);
  const form = await body(c);
  const pass = form.privacy === "clear" && form.rights === "clear" && form.quality === "clear";
  if (!pass && form.quarantine !== true) throw invalid();
  await c.db.batch([
    c.db.prepare(`UPDATE hw_versions SET state=?,screened_by=?,screened_at=?,split=CASE WHEN ?='quarantined' THEN 'pending' ELSE split END
      WHERE id=? AND EXISTS(SELECT 1 FROM hw_pages WHERE id=? AND current_version=? AND withdrawn=0)`)
      .bind(pass ? "cleared" : "quarantined", actor, c.now, pass ? "cleared" : "quarantined", v.id, p.id, v.id),
    invalidatePage(c, p.id, v.id, v.id),
  ]);
  return json({ state: pass ? "cleared" : "quarantined" });
}

function decodePng(value: unknown, width: number, height: number) {
  if (!isString(value) || value.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw invalid();
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(value), ch => ch.charCodeAt(0)); } catch { throw invalid(); }
  const frame = imageFrame(bytes, true);
  if (!frame || frame.width !== width || frame.height !== height) throw invalid();
  return bytes;
}

export async function geometry(c: Intake, pageId: string, versionId: string) {
  const page = await activePage(c, pageId);
  const v = await activeVersion(c, page, versionId);
  if (v.state !== "cleared") throw notFound();
  const form = await body(c, 32 * 1024 * 1024);
  if (form.originalSha !== v.sha || (form.replaces ?? null) !== v.geometry) throw conflict();
  const polygons = linePolygons(form.polygons, v.width, v.height);
  if (!polygons || !Array.isArray(form.crops) || form.crops.length !== 10) throw invalid();
  const scans = polygons.map((p, i) => {
    const bounds = polygonBounds(p);
    return decodePng((form.crops as unknown[])[i], bounds.width, bounds.height);
  });
  const whole = decodePng(form.preparedPage, v.width, v.height);
  const g = newId();
  const parent = "derived/" + g + "/";
  const keys = scans.map(() => newId());
  const sameFrame = "EXISTS(SELECT 1 FROM hw_versions v JOIN hw_pages p ON p.id=v.page WHERE v.id=? AND v.geometry IS ? AND v.state='cleared' AND p.withdrawn=0 AND p.current_version=v.id)";
  try {
    await putMedia(c, page.id, parent + "page", whole);
    for (const [i, bytes] of scans.entries()) await putMedia(c, page.id, parent + keys[i], bytes);
    const statements = [c.db.prepare(`INSERT INTO hw_geometry(id,version,parent,page_sha) SELECT ?,?,?,? WHERE ${sameFrame}`)
      .bind(g, v.id, v.geometry, await sha(whole), v.id, v.geometry)];
    for (const [i, p] of polygons.entries()) {
      statements.push(c.db.prepare(`INSERT INTO hw_lines(id,geometry,position,polygon,sha) SELECT ?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM hw_geometry WHERE id=?)`).bind(keys[i], g, i+1, JSON.stringify(p), await sha(scans[i]!), g));
    }
    statements.push(c.db.prepare(`UPDATE hw_versions SET geometry=?,split='pending' WHERE id=? AND EXISTS(SELECT 1 FROM hw_geometry WHERE id=?)`)
      .bind(g, v.id, g), invalidatePage(c, page.id, v.id, v.id));
    const out = await c.db.batch(statements);
    if (!out[0]?.meta.changes || await withdrawn(c, page.id)) throw conflict();
  } catch (error) {
    // A lost D1 response may follow a committed batch. Keep the raster when the commit is uncertain.
    if (!await c.db.prepare("SELECT id FROM hw_geometry WHERE id=?").bind(g).first()) {
      await erasePrefix(c, mediaPath(c, page.id, parent));
    }
    throw error;
  }
  if (v.geometry) await erasePrefix(c, mediaPath(c, page.id, "derived/" + v.geometry + "/"));
  return json({ geometryId: g, lines: 10 }, 201);
}

export async function split(c: Intake, pageId: string, versionId: string) {
  const p = await activePage(c, pageId);
  const v: Version = await activeVersion(c, p, versionId);
  const form = await body(c);
  if (!v.geometry || form.geometryId !== v.geometry || !isString(form.imageSha) || !digestPattern.test(form.imageSha) ||
    form.imageSha !== v.sha || !["clear", "pending", "overlap"].includes(String(form.status))) throw conflict();
  if (form.status === "clear" && await c.db.prepare("SELECT 1 FROM hw_versions WHERE page<>? AND sha=? LIMIT 1")
    .bind(p.id, v.sha).first()) throw conflict();
  const [write] = await c.db.batch([
    c.db.prepare(`UPDATE hw_versions SET split=? WHERE id=? AND geometry=? AND state='cleared'
      AND EXISTS(SELECT 1 FROM hw_pages WHERE id=? AND current_version=? AND withdrawn=0)
      AND NOT EXISTS(SELECT 1 FROM hw_lines l JOIN hw_reads r ON r.line=l.id
        WHERE l.geometry=? AND r.issue IN ('privacy','geometry'))
      AND NOT EXISTS(SELECT 1 FROM hw_lines l JOIN hw_resolution r ON r.line=l.id
        WHERE l.geometry=? AND r.reason='privacy')`).bind(form.status, v.id, v.geometry, p.id, v.id, v.geometry, v.geometry),
    invalidatePage(c, p.id, v.id, v.id),
  ]);
  if (!write?.meta.changes || await withdrawn(c, p.id)) throw conflict();
  return json({ status: form.status });
}
