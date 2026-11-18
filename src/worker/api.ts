import type { BatchSummary, ConfigResponse, MeResponse } from "../shared/api";
import { cleanDisplayName, displayNameProblem } from "../shared/displayName";
import { TERMS_STATUS, TERMS_VERSION } from "../shared/terms";
import { buildExport } from "../tasks/export";
import { TASK_TYPE_ID as PAGE_REVIEW, payloadOf } from "../tasks/page_review";
import { taskType } from "../tasks/registry";
import { devAuthEnabled, devProvider } from "./auth/dev";
import { googleProvider } from "./auth/google";
import type { IdentityProvider } from "./auth/provider";
import { reviewerIdFor } from "./auth/pseudonym";
import { clearSessionCookie, createSessionCookie, readSession } from "./auth/session";
import { randomId } from "./crypto";
import { exportRows, getBatch, getProposal, getReviewer, listBatches, type ReviewerRow } from "./db";
import type { Env } from "./env";
import { checkDraft } from "./drafts";
import { HttpError, MAX_PAGE_BODY_BYTES, assertSameOrigin, json, readJson } from "./http";
import { isOpenTo, loadSubset, nextFor, progressFor, proposalView, subsetsOf } from "./queue";
import {
  afterLineDecision,
  assertConsensusEnabled,
  consensusProgress,
  exportExtras,
  gateOpen,
  isConsensus,
  isTranscribe,
  lineOpenTo,
  nextLine,
  setExclusion,
  volunteerReport,
} from "./consensus";
import { LIMITS, clientKey, enforce, pruneRateLimits } from "./ratelimit";

const PROVIDERS: Record<string, IdentityProvider> = { google: googleProvider, dev: devProvider };

export interface Ctx {
  env: Env;
  request: Request;
  url: URL;
  exec: ExecutionContext;
  now: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => iso(ms).slice(0, 10);

export function isAdmin(env: Env, reviewerId: string): boolean {
  return (env.ADMIN_REVIEWER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(reviewerId);
}

async function requireReviewer(ctx: Ctx): Promise<ReviewerRow> {
  const id = await readSession(ctx.env, ctx.request, ctx.now);
  if (!id) throw new HttpError(401, "sign_in_required");
  const reviewer = await getReviewer(ctx.env.DB, id);
  if (!reviewer) throw new HttpError(401, "sign_in_required");
  if (reviewer.blocked) throw new HttpError(403, "blocked");
  return reviewer;
}

function me(env: Env, r: ReviewerRow): MeResponse {
  return {
    reviewerId: r.id,
    termsVersion: r.terms_version,
    termsCurrent: r.terms_version === TERMS_VERSION,
    displayName: r.display_name,
    isAdmin: isAdmin(env, r.id),
  };
}

export async function config(ctx: Ctx): Promise<Response> {
  const body: ConfigResponse = {
    environment: ctx.env.ENVIRONMENT,
    googleClientId: ctx.env.GOOGLE_CLIENT_ID || null,
    devAuth: devAuthEnabled(ctx.env, ctx.request),
    termsVersion: TERMS_VERSION,
    termsStatus: TERMS_STATUS,
  };
  return json(body);
}

export async function signIn(ctx: Ctx, providerId: string): Promise<Response> {
  assertSameOrigin(ctx.request);
  const provider = Object.prototype.hasOwnProperty.call(PROVIDERS, providerId) ? PROVIDERS[providerId] : undefined;
  if (!provider || !provider.enabled(ctx.env, ctx.request)) throw new HttpError(404, "not_found");
  await enforce(ctx.env.DB, LIMITS.signInMinute, await clientKey(ctx.env, ctx.request), ctx.now);
  const body = await readJson(ctx.request);
  const { subject } = await provider.authenticate(body, ctx.env, ctx.request);
  const id = await reviewerIdFor(ctx.env, provider.id, subject);
  const now = iso(ctx.now);
  await ctx.env.DB.prepare(
    `INSERT INTO reviewers (id, created_at, last_seen_at) VALUES (?1, ?2, ?2)
     ON CONFLICT (id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
  )
    .bind(id, now)
    .run();
  const reviewer = (await getReviewer(ctx.env.DB, id))!;
  if (reviewer.blocked) throw new HttpError(403, "blocked");
  if (Math.random() < 0.05) ctx.exec.waitUntil(pruneRateLimits(ctx.env.DB, ctx.now));
  return json(me(ctx.env, reviewer), 200, { "set-cookie": await createSessionCookie(ctx.env, id, ctx.now) });
}

export async function signOut(ctx: Ctx): Promise<Response> {
  assertSameOrigin(ctx.request);
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

export async function getMe(ctx: Ctx): Promise<Response> {
  return json(me(ctx.env, await requireReviewer(ctx)));
}

/** Accept the contribution terms (and optionally opt in to a credit name). */
export async function acceptTerms(ctx: Ctx): Promise<Response> {
  assertSameOrigin(ctx.request);
  const reviewer = await requireReviewer(ctx);
  await enforce(ctx.env.DB, LIMITS.profileHour, reviewer.id, ctx.now);
  const body = await readJson(ctx.request);
  if (body.termsVersion !== TERMS_VERSION) throw new HttpError(409, "terms_changed", "reload to see the current terms");
  if (body.accept !== true) throw new HttpError(400, "consent_required");
  const name = body.displayName;
  if (name !== null && name !== undefined) {
    const problem = displayNameProblem(name);
    if (problem) throw new HttpError(400, "invalid_display_name", problem);
  }
  const now = iso(ctx.now);
  const statements = [
    ctx.env.DB.prepare("UPDATE reviewers SET terms_version = ?2, terms_accepted_at = ?3 WHERE id = ?1").bind(reviewer.id, TERMS_VERSION, now),
    ctx.env.DB.prepare(
      "INSERT INTO consent_events (reviewer_id, kind, terms_version, value, created_at) VALUES (?1, 'contribution_terms', ?2, NULL, ?3)",
    ).bind(reviewer.id, TERMS_VERSION, now),
  ];
  if (typeof name === "string") statements.push(...displayNameStatements(ctx.env.DB, reviewer.id, cleanDisplayName(name), now));
  await ctx.env.DB.batch(statements);
  return json(me(ctx.env, (await getReviewer(ctx.env.DB, reviewer.id))!));
}

function displayNameStatements(db: D1Database, reviewerId: string, name: string | null, now: string) {
  return [
    db
      .prepare("UPDATE reviewers SET display_name = ?2, display_name_consented_at = ?3 WHERE id = ?1")
      .bind(reviewerId, name, name === null ? null : now),
    db
      .prepare("INSERT INTO consent_events (reviewer_id, kind, terms_version, value, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(reviewerId, name === null ? "display_name_withdrawn" : "display_name_credit", TERMS_VERSION, name, now),
  ];
}

/** Opt in to (or withdraw) a credit display name. */
export async function setDisplayName(ctx: Ctx): Promise<Response> {
  assertSameOrigin(ctx.request);
  const reviewer = await requireReviewer(ctx);
  await enforce(ctx.env.DB, LIMITS.profileHour, reviewer.id, ctx.now);
  const body = await readJson(ctx.request);
  let name: string | null = null;
  if (body.displayName !== null) {
    const problem = displayNameProblem(body.displayName);
    if (problem) throw new HttpError(400, "invalid_display_name", problem);
    if (body.consent !== true) throw new HttpError(400, "consent_required");
    name = cleanDisplayName(body.displayName as string);
  }
  await ctx.env.DB.batch(displayNameStatements(ctx.env.DB, reviewer.id, name, iso(ctx.now)));
  return json(me(ctx.env, (await getReviewer(ctx.env.DB, reviewer.id))!));
}

export async function batches(ctx: Ctx): Promise<Response> {
  const reviewer = await requireReviewer(ctx);
  await enforce(ctx.env.DB, LIMITS.readMinute, reviewer.id, ctx.now);
  const list = await listBatches(ctx.env.DB, true);
  const out: BatchSummary[] = [];
  for (const b of list) {
    const type = taskType(b.taskType);
    if (!type) continue;
    if (isConsensus(b) && ctx.env.CONSENSUS_ENABLED !== "1") continue;
    // Transcription is listed only to the maintainer and to volunteers its gate lets in.
    if (isTranscribe(b) && !isAdmin(ctx.env, reviewer.id) && !(await gateOpen(ctx.env.DB, b, reviewer.id))) continue;
    out.push({
      id: b.id,
      taskType: b.taskType,
      taskLabel: type.label,
      title: b.title,
      progress: isConsensus(b) ? await consensusProgress(ctx.env.DB, b, reviewer.id, true) : await progressFor(ctx.env.DB, b, reviewer.id, ctx.now),
      subsets: await subsetsOf(ctx.env.DB, b.id),
    });
  }
  return json({ batches: out });
}

async function openBatch(ctx: Ctx, id: string) {
  const batch = await getBatch(ctx.env.DB, id);
  if (!batch || batch.status !== "open" || !taskType(batch.taskType)) throw new HttpError(404, "not_found");
  if (isConsensus(batch)) assertConsensusEnabled(ctx.env);
  return batch;
}

export async function next(ctx: Ctx, batchId: string): Promise<Response> {
  const reviewer = await requireReviewer(ctx);
  await enforce(ctx.env.DB, LIMITS.readMinute, reviewer.id, ctx.now);
  const batch = await openBatch(ctx, batchId);
  if (isConsensus(batch)) {
    // ?languages=jrb,lad: languages besides Hebrew the volunteer says they read, for this session only (never stored).
    const raw = new URL(ctx.request.url).searchParams.get("languages") ?? "";
    const languages = raw === "" ? [] : raw.split(",");
    if (languages.length > 8 || !languages.every((l) => /^[a-z]{2,3}$/.test(l))) throw new HttpError(400, "invalid_languages", "languages must be language codes");
    return json(await nextLine(ctx.env.DB, batch, reviewer.id, isAdmin(ctx.env, reviewer.id), ctx.now, languages));
  }
  // ?subset=<id>: serve only that subset's pages (a filter; the decisions are ordinary ones on the same proposals).
  const subsetId = new URL(ctx.request.url).searchParams.get("subset");
  let filter = null;
  if (subsetId !== null) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(subsetId)) throw new HttpError(404, "not_found");
    filter = await loadSubset(ctx.env.DB, batch.id, subsetId);
    if (!filter) throw new HttpError(404, "not_found");
  }
  return json(await nextFor(ctx.env.DB, batch, reviewer.id, ctx.now, filter));
}

async function activeProposal(ctx: Ctx, id: number, reviewerId: string) {
  const proposal = Number.isSafeInteger(id) ? await getProposal(ctx.env.DB, id) : null;
  if (!proposal || !proposal.active) throw new HttpError(404, "not_found");
  const batch = await openBatch(ctx, proposal.batchId);
  // A volunteer line: only one this reviewer was served (or decided); the maintainer's: only one that went to them.
  if (isConsensus(batch)) {
    if (!(await lineOpenTo(ctx.env.DB, proposal, reviewerId, isAdmin(ctx.env, reviewerId)))) throw new HttpError(409, "not_open", "this line is not open to you");
    return { proposal, batch };
  }
  // A gated page (a reserve, a blind second pass) is not shown or decided by link before it opens to this reviewer,
  // unless they already decided it (going back to change a decision).
  if (!(await isOpenTo(ctx.env.DB, proposal, reviewerId, ctx.now))) {
    const mine = await ctx.env.DB.prepare("SELECT 1 AS ok FROM decisions WHERE proposal_id = ?1 AND reviewer_id = ?2 LIMIT 1")
      .bind(proposal.id, reviewerId)
      .first<{ ok: number }>();
    if (!mine) throw new HttpError(409, "not_open", "this page is not open to you yet");
  }
  // A first pass is closed to a reviewer while its blind second pass is open to them and they have not decided it:
  // they must not see (or change) their first answers during the blind pass.
  const blind = await ctx.env.DB.prepare(
    `SELECT id, batch_id FROM proposals WHERE batch_id = ?1 AND gate_kind = 'after_confirm' AND gate_ref = ?2 AND active = 1`,
  )
    .bind(proposal.batchId, proposal.externalId)
    .first<{ id: number; batch_id: string }>();
  if (blind && (await isOpenTo(ctx.env.DB, { id: blind.id, batchId: blind.batch_id }, reviewerId, ctx.now))) {
    const done = await ctx.env.DB.prepare("SELECT 1 AS ok FROM decisions WHERE proposal_id = ?1 AND reviewer_id = ?2 AND superseded_at IS NULL")
      .bind(blind.id, reviewerId)
      .first<{ ok: number }>();
    if (!done) throw new HttpError(409, "not_open", "this page's blind second pass is open to you: decide it first");
  }
  return { proposal, batch };
}

export async function showProposal(ctx: Ctx, id: number): Promise<Response> {
  const reviewer = await requireReviewer(ctx);
  await enforce(ctx.env.DB, LIMITS.readMinute, reviewer.id, ctx.now);
  const { proposal, batch } = await activeProposal(ctx, id, reviewer.id);
  return json({ proposal: await proposalView(ctx.env.DB, batch, proposal, reviewer.id) });
}

export async function decide(ctx: Ctx, id: number): Promise<Response> {
  assertSameOrigin(ctx.request);
  const reviewer = await requireReviewer(ctx);
  if (reviewer.terms_version !== TERMS_VERSION) throw new HttpError(403, "terms_required");
  await enforce(ctx.env.DB, LIMITS.writeMinute, reviewer.id, ctx.now);
  await enforce(ctx.env.DB, LIMITS.writeDay, reviewer.id, ctx.now);
  const body = await readJson(ctx.request, MAX_PAGE_BODY_BYTES);
  const { proposal, batch } = await activeProposal(ctx, id, reviewer.id);
  if (typeof body.value !== "string") throw new HttpError(400, "invalid_decision", "value is required");
  const normalized = taskType(batch.taskType)!.normalizeDecision(proposal, body.value, body.text);
  if (!normalized.ok) throw new HttpError(400, "invalid_decision", normalized.error);
  const db = ctx.env.DB;
  const existing = await db
    .prepare("SELECT id, value, text, proposal_sha256 FROM decisions WHERE proposal_id = ?1 AND reviewer_id = ?2 AND superseded_at IS NULL")
    .bind(proposal.id, reviewer.id)
    .first<{ id: string; value: string; text: string | null; proposal_sha256: string }>();
  // Volunteer lines: a decision is final (only a reviewer's first decision on a line could count).
  if (existing && isConsensus(batch)) throw new HttpError(409, "decided", "this line is decided");
  let decisionId: string;
  if (
    existing &&
    existing.value === normalized.value &&
    existing.text === normalized.text &&
    existing.proposal_sha256 === proposal.contentSha256
  ) {
    decisionId = existing.id; // the same decision again: nothing new to record
  } else {
    decisionId = randomId("hr-");
    const now = iso(ctx.now);
    await db.batch([
      db
        .prepare("UPDATE decisions SET superseded_at = ?3 WHERE proposal_id = ?1 AND reviewer_id = ?2 AND superseded_at IS NULL")
        .bind(proposal.id, reviewer.id, now),
      db
        .prepare(
          `INSERT INTO decisions (id, proposal_id, reviewer_id, value, text, proposal_sha256, terms_version, created_at, decided_on)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(decisionId, proposal.id, reviewer.id, normalized.value, normalized.text, proposal.contentSha256, TERMS_VERSION, now, day(ctx.now)),
      db.prepare("DELETE FROM skips WHERE reviewer_id = ?1 AND proposal_id = ?2").bind(reviewer.id, proposal.id),
    ]);
  }
  // The page is decided: its draft is done with (page_review).
  await db.prepare("DELETE FROM drafts WHERE reviewer_id = ?1 AND proposal_id = ?2").bind(reviewer.id, proposal.id).run();
  if (isConsensus(batch)) {
    await afterLineDecision(db, batch, proposal, decisionId, reviewer.id, isAdmin(ctx.env, reviewer.id), ctx.now);
    return json({ decisionId, value: normalized.value, text: normalized.text, progress: await consensusProgress(db, batch, reviewer.id, true) });
  }
  return json({
    decisionId,
    value: normalized.value,
    text: normalized.text,
    progress: await progressFor(db, batch, reviewer.id, ctx.now),
  });
}

/**
 * Save the reviewer's unsaved corrections of a page (page_review), pinned to the pre-fill they were made on. Refused
 * for another pre-fill (409 stale_draft) and once the reviewer has decided the page (409 decided).
 */
export async function saveDraft(ctx: Ctx, id: number): Promise<Response> {
  assertSameOrigin(ctx.request);
  const reviewer = await requireReviewer(ctx);
  if (reviewer.terms_version !== TERMS_VERSION) throw new HttpError(403, "terms_required");
  await enforce(ctx.env.DB, LIMITS.draftMinute, reviewer.id, ctx.now);
  await enforce(ctx.env.DB, LIMITS.draftDay, reviewer.id, ctx.now);
  const body = await readJson(ctx.request, MAX_PAGE_BODY_BYTES);
  const { proposal, batch } = await activeProposal(ctx, id, reviewer.id);
  if (batch.taskType !== PAGE_REVIEW) throw new HttpError(400, "invalid_draft", "drafts are for page review");
  const x = payloadOf(proposal);
  if (body.prefillSha256 !== x.prefill_sha256) throw new HttpError(409, "stale_draft", "this page's pre-fill changed: reload the page");
  const db = ctx.env.DB;
  const decided = await db
    .prepare("SELECT 1 AS ok FROM decisions WHERE proposal_id = ?1 AND reviewer_id = ?2 AND superseded_at IS NULL")
    .bind(proposal.id, reviewer.id)
    .first<{ ok: number }>();
  if (decided) throw new HttpError(409, "decided", "this page is decided");
  const checked = checkDraft(body, new Set(x.lines.map((l) => l.i)));
  if (!checked.ok) throw new HttpError(400, "invalid_draft", checked.error);
  const savedAt = iso(ctx.now);
  await db
    .prepare(
      `INSERT INTO drafts (reviewer_id, proposal_id, prefill_sha256, body, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (reviewer_id, proposal_id) DO UPDATE SET prefill_sha256 = excluded.prefill_sha256, body = excluded.body, updated_at = excluded.updated_at`,
    )
    .bind(reviewer.id, proposal.id, x.prefill_sha256, JSON.stringify(checked.body), savedAt)
    .run();
  return json({ ok: true, savedAt });
}

/** Discard the reviewer's draft of a page (back to the pre-fill). */
export async function clearDraft(ctx: Ctx, id: number): Promise<Response> {
  assertSameOrigin(ctx.request);
  const reviewer = await requireReviewer(ctx);
  await enforce(ctx.env.DB, LIMITS.draftMinute, reviewer.id, ctx.now);
  const { proposal } = await activeProposal(ctx, id, reviewer.id);
  await ctx.env.DB.prepare("DELETE FROM drafts WHERE reviewer_id = ?1 AND proposal_id = ?2").bind(reviewer.id, proposal.id).run();
  return json({ ok: true });
}

export async function skip(ctx: Ctx, id: number): Promise<Response> {
  assertSameOrigin(ctx.request);
  const reviewer = await requireReviewer(ctx);
  await enforce(ctx.env.DB, LIMITS.writeMinute, reviewer.id, ctx.now);
  const { proposal, batch } = await activeProposal(ctx, id, reviewer.id);
  await ctx.env.DB.prepare("INSERT OR IGNORE INTO skips (reviewer_id, proposal_id, created_at) VALUES (?1, ?2, ?3)")
    .bind(reviewer.id, proposal.id, iso(ctx.now))
    .run();
  if (isConsensus(batch)) return json({ ok: true, progress: await consensusProgress(ctx.env.DB, batch, reviewer.id, true) });
  return json({ ok: true, progress: await progressFor(ctx.env.DB, batch, reviewer.id, ctx.now) });
}

export async function clearSkips(ctx: Ctx, batchId: string): Promise<Response> {
  assertSameOrigin(ctx.request);
  const reviewer = await requireReviewer(ctx);
  await enforce(ctx.env.DB, LIMITS.writeMinute, reviewer.id, ctx.now);
  const batch = await openBatch(ctx, batchId);
  await ctx.env.DB.prepare("DELETE FROM skips WHERE reviewer_id = ?1 AND proposal_id IN (SELECT id FROM proposals WHERE batch_id = ?2)")
    .bind(reviewer.id, batch.id)
    .run();
  return json({ ok: true, progress: await progressFor(ctx.env.DB, batch, reviewer.id, ctx.now) });
}

async function requireAdmin(ctx: Ctx): Promise<ReviewerRow> {
  const reviewer = await requireReviewer(ctx);
  if (!isAdmin(ctx.env, reviewer.id)) throw new HttpError(403, "admin_only");
  return reviewer;
}

export async function adminProgress(ctx: Ctx): Promise<Response> {
  await requireAdmin(ctx);
  const out = [];
  for (const batch of await listBatches(ctx.env.DB, false)) {
    if (isConsensus(batch) && ctx.env.CONSENSUS_ENABLED !== "1") continue;
    const rows = await exportRows(ctx.env.DB, batch.id);
    const extras = isConsensus(batch) ? await exportExtras(ctx.env.DB, batch) : {};
    const result = buildExport({ batch, ...rows, ...extras, exportedAt: iso(ctx.now) });
    const perReviewer = new Map<string, number>();
    for (const d of rows.decisions) if (d.supersededAt === null) perReviewer.set(d.reviewerId, (perReviewer.get(d.reviewerId) ?? 0) + 1);
    out.push({
      id: batch.id,
      taskType: batch.taskType,
      title: batch.title,
      status: batch.status,
      minReviewers: batch.minReviewers,
      counts: result.counts,
      reviewers: [...perReviewer].map(([id, decisions]) => ({ id, decisions })).sort((a, b) => b.decisions - a.decisions),
    });
  }
  return json({ batches: out });
}

export async function adminExport(ctx: Ctx, batchId: string): Promise<Response> {
  await requireAdmin(ctx);
  const batch = await getBatch(ctx.env.DB, batchId);
  if (!batch) throw new HttpError(404, "not_found");
  if (isConsensus(batch)) assertConsensusEnabled(ctx.env);
  const rows = await exportRows(ctx.env.DB, batch.id);
  const extras = isConsensus(batch) ? await exportExtras(ctx.env.DB, batch) : {};
  const result = buildExport({ batch, ...rows, ...extras, exportedAt: iso(ctx.now) });
  return json({
    counts: result.counts,
    problems: result.problems,
    files: { [result.decisionsFile.fileName]: result.decisionsFile.content, [result.ledgerFile.fileName]: result.ledgerFile.content },
  });
}

async function consensusBatch(ctx: Ctx, batchId: string) {
  assertConsensusEnabled(ctx.env);
  const batch = await getBatch(ctx.env.DB, batchId);
  if (!batch || !isConsensus(batch)) throw new HttpError(404, "not_found");
  return batch;
}

/** Admin: a volunteer batch's line states, and each volunteer's gold record and standing (never shown to volunteers). */
export async function adminVolunteers(ctx: Ctx, batchId: string): Promise<Response> {
  await requireAdmin(ctx);
  const batch = await consensusBatch(ctx, batchId);
  return json(await volunteerReport(ctx.env.DB, batch));
}

/** Admin: exclude a volunteer from agreement in a batch, or include them again ({excluded: boolean}). */
export async function adminExclusion(ctx: Ctx, batchId: string, reviewerId: string): Promise<Response> {
  assertSameOrigin(ctx.request);
  const admin = await requireAdmin(ctx);
  await enforce(ctx.env.DB, LIMITS.writeMinute, admin.id, ctx.now);
  const batch = await consensusBatch(ctx, batchId);
  const body = await readJson(ctx.request);
  if (typeof body.excluded !== "boolean") throw new HttpError(400, "invalid_request", "excluded must be true or false");
  if (!(await getReviewer(ctx.env.DB, reviewerId))) throw new HttpError(404, "not_found");
  await setExclusion(ctx.env.DB, batch, reviewerId, body.excluded, ctx.now);
  return json(await volunteerReport(ctx.env.DB, batch));
}
