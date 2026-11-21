import { json } from "../http";
import { activePage, body, conflict, invalid, isString, language, mediaResponse, notFound, prefix, privateCode, slotFor, withdrawn,
  wording, type Intake } from "./core";

import { retentionExpired } from "./release";

const readerId = /^rv_[a-f0-9]{8}$/;
const issues = ["none", "literal", "ambiguous", "unreadable", "geometry", "privacy"];
const exclusion = ["unreadable", "ambiguous", "privacy", "incomplete"];
type Line = { id: string; geometry: string; position: number; page: string; writer_account: string; slot: string; prompt_hash: string; version: string; n: number };
type Read = { pass: number; reviewer: string; raw: string; issue: string };

export function normalizeHandwriting(text: string) {
  return text.normalize("NFC").replace(/[^\S\r\n]+/gu, " ").trim();
}
function literal(value: unknown, allowEmpty: boolean) {
  if (!isString(value) || value.length > 2000 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value) || (!allowEmpty && !value.trim())) throw invalid();
  return value;
}

export async function readerAgreement(c: Intake, id: string, post: boolean) {
  if (!readerId.test(id) || await retentionExpired(c)) throw notFound();
  const form = post ? await body(c) : null;
  const lang = language(form?.language ?? new URL(c.request.url).searchParams.get("lang") ?? "he");
  const consent = await wording(c, "readerConsent", lang);
  if (!form) return json({ consent, retentionNotice: c.config.retentionNotice[lang] });
  if (form.agree !== true || form.version !== consent.version || form.sha256 !== consent.sha256) throw conflict();
  await c.db.prepare(`INSERT INTO hw_reader_consent(reviewer,wording_version,language,wording_sha,agreed_at)
    VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(id, consent.version, lang, consent.sha256, c.now).run();
  return json({ accepted: true });
}

async function reader(c: Intake, id: string) {
  if (await retentionExpired(c)) throw notFound();
  const found = await c.db.prepare("SELECT language,wording_version,wording_sha FROM hw_reader_consent WHERE reviewer=?")
    .bind(id).all<{ language: string; wording_version: string; wording_sha: string }>();
  for (const row of found.results) {
    const current = await wording(c, "readerConsent", language(row.language));
    if (row.wording_version === current.version && row.wording_sha === current.sha256) {
      return { account: await privateCode(c, "account", id), agreement: current,
        reader: c.config.access.reader?.includes(id) === true,
        adjudicator: c.config.access.adjudicator?.includes(id) === true };
    }
  }
  throw notFound();
}

const n = "(SELECT COUNT(*) FROM hw_reads r WHERE r.line=l.id)";
const unresolved = "NOT EXISTS(SELECT 1 FROM hw_resolution r WHERE r.line=l.id)";
const hasWork = `((?=1 AND ${n}<2) OR (?=1 AND ${n}=2))`;

async function findLine(c: Intake, id: string, lineId?: string, allowOwn = false) {
  const access = await reader(c, id);
  const own = "EXISTS(SELECT 1 FROM hw_reads WHERE line=l.id AND reviewer=?)";
  const resume = !lineId && access.adjudicator;
  const pending = `${unresolved} AND EXISTS(SELECT 1 FROM hw_reads WHERE line=l.id AND reviewer=? AND pass=3)`;
  const extra = allowOwn ? ` OR ${own}` : resume ? ` OR (${pending})` : "";
  const sql = `SELECT l.*,${n} AS n FROM hw_active_lines l WHERE l.writer_account<>?
    AND ((${unresolved} AND NOT ${own} AND ${hasWork})${extra})
    ${lineId ? "AND l.id=?" : ""} ORDER BY n DESC,l.version,l.position`;
  const args: (string | number)[] = [access.account, id, Number(access.reader), Number(access.adjudicator)];
  if (allowOwn || resume) args.push(id);
  if (lineId) args.push(lineId);
  const { results } = await c.db.prepare(sql).bind(...args).all<Line>();
  for (const row of results) if (!await withdrawn(c, row.page)) return row;
  return null;
}

export async function reviewView(c: Intake, id: string, lineId?: string) {
  const line = await findLine(c, id, lineId, !!lineId);
  if (!line) {
    if (lineId) throw notFound();
    return json({ task: null });
  }
  const own = await c.db.prepare("SELECT raw,issue FROM hw_reads WHERE line=? AND reviewer=?").bind(line.id, id)
    .first<{ raw: string; issue: string }>();
  if (await withdrawn(c, line.page)) throw notFound();
  return json({ task: { id: line.id, image: prefix + "/review/" + line.id + "/image", input: "", own } });
}

export async function crop(c: Intake, id: string, lineId: string) {
  const line = await findLine(c, id, lineId, true);
  if (!line) throw notFound();
  return mediaResponse(c, line.page, "derived/" + line.geometry + "/" + line.id, "image/png");
}

export async function typeLine(c: Intake, id: string, lineId: string) {
  const line = await findLine(c, id, lineId);
  if (!line) throw notFound();
  const form = await body(c);
  if (!isString(form.issue) || !issues.includes(form.issue)) throw invalid();
  const text = literal(form.text, ["unreadable", "geometry", "privacy"].includes(form.issue));
  // The limit and role check is part of the insert, so two readers racing for the last slot cannot both win.
  const access = await reader(c, id);
  const { packet } = await slotFor(c, line.slot);
  if (packet.sha256 !== line.prompt_hash) throw conflict();
  // Check only provisional agreements. Even when both readers missed the same literal difference,
  // the prompt can route an independent third read but can never supply the reference.
  const expected = normalizeHandwriting(packet.text.trimEnd().split("\n")[line.position - 1]!);
  const [inserted] = await c.db.batch([
    c.db.prepare(`INSERT INTO hw_reads(line,reviewer,pass,raw,normalized,issue,wording_version,wording_sha)
      SELECT l.id,?,${n}+1,?,?,?,?,? FROM hw_active_lines l WHERE l.id=? AND l.writer_account<>? AND ${unresolved} AND ${hasWork}
      ON CONFLICT DO NOTHING`).bind(id, text, normalizeHandwriting(text), form.issue, access.agreement.version, access.agreement.sha256,
        line.id, access.account, Number(access.reader), Number(access.adjudicator)),
    c.db.prepare(`INSERT INTO hw_resolution(line,reference)
      SELECT l.id,MIN(r.normalized) FROM hw_active_lines l JOIN hw_reads r ON r.line=l.id
      WHERE l.id=? GROUP BY l.id HAVING COUNT(*)=2 AND COUNT(DISTINCT r.normalized)=1
        AND SUM(r.issue<>'none')=0 AND MIN(r.normalized)=?
      ON CONFLICT DO NOTHING`).bind(line.id, expected),
    c.db.prepare(`UPDATE hw_versions SET state='quarantined',split='pending' WHERE id=? AND geometry=?
       AND EXISTS(SELECT 1 FROM hw_reads WHERE line=? AND reviewer=? AND issue IN ('privacy','geometry'))`)
      .bind(line.version, line.geometry, line.id, id),
    c.db.prepare(`UPDATE hw_candidates SET invalid=1 WHERE sha IN (SELECT candidate FROM hw_candidate_pages WHERE page=?)
      AND EXISTS(SELECT 1 FROM hw_reads WHERE line=? AND reviewer=? AND issue IN ('privacy','geometry'))`).bind(line.page, line.id, id),
  ]);
  if (!inserted?.meta.changes || await withdrawn(c, line.page)) throw conflict();
  return json({ recorded: true }, 201);
}

export async function adjudicate(c: Intake, id: string, lineId: string, post: boolean) {
  const line = await findLine(c, id, lineId, true);
  if (!line || !c.config.access.adjudicator.includes(id)) throw notFound();
  const { results } = await c.db.prepare("SELECT pass,reviewer,raw,issue FROM hw_reads WHERE line=? ORDER BY pass")
    .bind(line.id).all<Read>();
  if (results.length !== 3 || results[2]?.reviewer !== id) throw notFound();
  if (!post) {
    const resolution = await c.db.prepare("SELECT reference,reason FROM hw_resolution WHERE line=?").bind(line.id).first();
    const page = await activePage(c, line.page);
    const reads = results.map(({ raw, issue }) => ({ text: raw, issue }));
    if (!resolution) return json({ reads });
    const { packet } = await slotFor(c, line.slot);
    if (page.prompt_hash !== packet.sha256) throw conflict();
    return json({ reads, resolution, prompt: packet.text });
  }
  const form = await body(c);
  if (form.reason !== undefined && (!isString(form.reason) || !exclusion.includes(form.reason) || form.reference != null)) throw invalid();
  const reference = form.reason === undefined ? normalizeHandwriting(literal(form.reference, false)) : null;
  const [write] = await c.db.batch([
    c.db.prepare(`INSERT INTO hw_resolution(line,reference,reason)
      SELECT id,?,? FROM hw_active_lines WHERE id=? AND EXISTS(SELECT 1 FROM hw_reads WHERE line=? AND pass=3 AND reviewer=?)
      ON CONFLICT DO NOTHING`).bind(reference, form.reason ?? null, line.id, line.id, id),
    c.db.prepare(`UPDATE hw_versions SET state='quarantined',split='pending' WHERE id=? AND geometry=?
      AND EXISTS(SELECT 1 FROM hw_resolution WHERE line=? AND reason='privacy')`).bind(line.version, line.geometry, line.id),
    c.db.prepare(`UPDATE hw_candidates SET invalid=1 WHERE sha IN (SELECT candidate FROM hw_candidate_pages WHERE page=?)
      AND EXISTS(SELECT 1 FROM hw_resolution WHERE line=? AND reason='privacy')`).bind(line.page, line.id),
  ]);
  if (!write?.meta.changes || await withdrawn(c, line.page)) throw conflict();
  return json({ recorded: true }, 201);
}
