import { ALLOWED_REFERENCE_PROPOSAL } from "../tasks/restricted_reference";
import { canReadReference, privateReferenceImage } from "./restricted_reference";
import { PAGE_PASTE_TRAIN } from "../shared/page_paste_train";
import { isTrainingPaste, TRAIN_EXPORT_FILE } from "../tasks/page_paste_train/export";
import { nextTrainingPage, saveTrainingPage, trainingAdmin, trainingAdminProgress, trainingAsset, trainingPage, trainingProgress } from "./page_paste_train";
import { SYNTH_REALISM, type Side } from "../shared/synth_realism";
import { nextRealism, realismAdmin, realismAsset, realismChoice, realismFeedback, realismProgress } from "./synth_realism";
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
import { TRIAGE_QUEUES, isOpenTo, loadSubset, nextFor, pendingBlindReference, progressFor, proposalView, subsetsOf, triageCounts, triageFilter, type TriageQueue } from "./queue";
import { isTriageBatch, isTriageValue, triageable } from "../tasks/line_verify/triage";
import { PAGE_ANSWERS, addLine, boxProblem, completenessImage, currentCheck, nextPage, normalizeAdded, pageItem, recordInitialPageCheck, recordPageCheck, removeLine } from "./pages";
import type { LineRouting } from "../tasks/line_verify/resolution";
import { dropPointedBook, pointedDropsExtra } from "./pointed_books";
import { goldDecided, goldKnown, goldOf, isVolunteerV11, phistGoldExtras, recordGoldDecision, setPull } from "./phist_gold";
import { isVolunteerV1, openFor, recordVolunteerDecision, routingOf, volunteerExtras } from "./verify_resolution";
import {
  afterLineDecision,
  assertConsensusEnabled,
  consensusProgress,
  exportExtras,
  isConsensus,
  lineOpenTo,
  nextLine,
  setExclusion,
  volunteerReport,
} from "./consensus";
import { LIMITS, clientKey, enforce, enforceProfileHour, enforceWriteDay } from "./ratelimit";

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
  enforce(LIMITS.signInMinute, await clientKey(ctx.env, ctx.request), ctx.now);
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
  await enforceProfileHour(ctx.env.DB, reviewer.id, ctx.now);
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
  await enforceProfileHour(ctx.env.DB, reviewer.id, ctx.now);
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
  enforce(LIMITS.readMinute, reviewer.id, ctx.now);
  const list = await listBatches(ctx.env.DB, true);
  const out: BatchSummary[] = [];
  for (const b of list) {
    if (!canReadReference(ctx.env, ctx.url, reviewer.id, b)) continue;
    if (b.taskType === PAGE_PASTE_TRAIN) {
      if (isAdmin(ctx.env, reviewer.id) && isTrainingPaste(b)) {
        const { total, completed, own } = await trainingProgress(ctx.env.DB, b.id, reviewer.id);
        out.push({
          id: b.id, taskType: PAGE_PASTE_TRAIN, taskLabel: { he: "תמלול דפים לאימון", en: "Training page transcription" },
          title: b.title, subsets: [],
          progress: { total, covered: completed, minReviewers: 1, decidedByMe: own, skippedByMe: 0, remainingForMe: total - completed },
        });
      }
      continue;
    }
    if (b.taskType === SYNTH_REALISM) {
      if (realismEnabled(ctx.env) && isAdmin(ctx.env, reviewer.id)) {
        const { total, completed } = await realismProgress(ctx.env.DB, b.id, reviewer.id);
        out.push({
          id: b.id, taskType: SYNTH_REALISM, taskLabel: { he: "סקירת מראה סינתטי", en: "Synthetic realism review" },
          title: b.title, subsets: [],
          progress: { total, covered: completed, minReviewers: 1, decidedByMe: completed, skippedByMe: 0, remainingForMe: total - completed },
        });
      }
      continue;
    }
    const type = taskType(b.taskType);
    if (!type) continue;
    if (isConsensus(b) && ctx.env.CONSENSUS_ENABLED !== "1") continue;
    out.push({
      id: b.id,
      taskType: b.taskType,
      taskLabel: type.label,
      title: b.title,
      progress: isConsensus(b) ? await consensusProgress(ctx.env.DB, b, reviewer.id, true) : await progressFor(ctx.env.DB, b, reviewer.id, ctx.now, null, isAdmin(ctx.env, reviewer.id)),
      subsets: await subsetsOf(ctx.env.DB, b.id),
      ...(isTriageBatch(b) ? { triage: (await triageCounts(ctx.env.DB, b, reviewer.id, ctx.now))! } : {}),
    });
  }
  return json({ batches: out });
}

async function openBatch(ctx: Ctx, id: string, reviewerId: string) {
  const batch = await getBatch(ctx.env.DB, id);
  if (!batch || batch.status !== "open" || !taskType(batch.taskType) ||
    !canReadReference(ctx.env, ctx.url, reviewerId, batch)) throw new HttpError(404, "not_found");
  if (isConsensus(batch)) assertConsensusEnabled(ctx.env);
  return batch;
}

export async function next(ctx: Ctx, batchId: string): Promise<Response> {
  const reviewer = await requireReviewer(ctx);
  enforce(LIMITS.readMinute, reviewer.id, ctx.now);
  const batch = await openBatch(ctx, batchId, reviewer.id);
  if (isConsensus(batch)) return json(await nextLine(ctx.env.DB, batch, reviewer.id, isAdmin(ctx.env, reviewer.id), ctx.now));
  // ?subset=<id>: serve only that subset's pages (a filter; the decisions are ordinary ones on the same proposals).
  const params = new URL(ctx.request.url).searchParams;
  const subsetId = params.get("subset");
  let filter = null;
  // A triage batch serves two queues (migrations/0012_triage.sql): ?queue=triage (the default) or ?queue=fix.
  if (isTriageBatch(batch)) {
    const queue = params.get("queue") ?? "triage";
    if (!(TRIAGE_QUEUES as readonly string[]).includes(queue)) throw new HttpError(404, "not_found");
    // A page comes before the next line: its completeness check (triage), or its missing lines (desktop; 0014).
    const page = await nextPage(ctx.env.DB, batch, reviewer.id, queue as TriageQueue);
    if (page) {
      const counts = (await triageCounts(ctx.env.DB, batch, reviewer.id, ctx.now))!;
      const progress = await progressFor(ctx.env.DB, batch, reviewer.id, ctx.now, null, isAdmin(ctx.env, reviewer.id));
      return json({ proposal: null, progress, prefetch: [], page, triage: { queue: queue as TriageQueue, ...counts } });
    }
    filter = await triageFilter(ctx.env.DB, batch.id, reviewer.id, queue as TriageQueue);
    const out = await nextFor(ctx.env.DB, batch, reviewer.id, ctx.now, filter, isAdmin(ctx.env, reviewer.id), queue === "triage");
    const counts = (await triageCounts(ctx.env.DB, batch, reviewer.id, ctx.now))!;
    return json({ ...out, triage: { queue: queue as TriageQueue, ...counts } });
  }
  if (subsetId !== null) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(subsetId)) throw new HttpError(404, "not_found");
    filter = await loadSubset(ctx.env.DB, batch.id, subsetId);
    if (!filter) throw new HttpError(404, "not_found");
  }
  return json(await nextFor(ctx.env.DB, batch, reviewer.id, ctx.now, filter, isAdmin(ctx.env, reviewer.id)));
}

async function activeProposal(ctx: Ctx, id: number, reviewerId: string) {
  const proposal = Number.isSafeInteger(id) ? await getProposal(ctx.env.DB, id) : null;
  if (!proposal || !proposal.active) throw new HttpError(404, "not_found");
  const batch = await openBatch(ctx, proposal.batchId, reviewerId);
  // A volunteer line: only one this reviewer was served (or decided); the maintainer's: only one that went to them.
  if (isConsensus(batch)) {
    if (!(await lineOpenTo(ctx.env.DB, proposal, reviewerId, isAdmin(ctx.env, reviewerId)))) throw new HttpError(409, "not_open", "this line is not open to you");
    return { proposal, batch };
  }
  // A gated page (a reserve, a blind second pass) is not shown or decided by link before it opens to this reviewer,
  // unless they already decided it (going back to change a decision).
  if (!(await isOpenTo(ctx.env.DB, proposal, reviewerId, ctx.now))) {
    if (batch.restrictedReference) throw new HttpError(409, "not_open");
    const mine = await ctx.env.DB.prepare("SELECT 1 AS ok FROM decisions WHERE proposal_id = ?1 AND reviewer_id = ?2 LIMIT 1")
      .bind(proposal.id, reviewerId)
      .first<{ ok: number }>();
    if (!mine) throw new HttpError(409, "not_open", "this page is not open to you yet");
  }
  // A first pass is closed to a reviewer while its blind second pass is open to them and they have not decided it:
  // they must not see (or change) their first answers during the blind pass.
  const blind = await ctx.env.DB.prepare(
    `SELECT p.id, p.batch_id FROM proposals p
    WHERE p.batch_id = ?1 AND p.gate_kind = 'after_confirm' AND p.gate_ref = ?2 AND p.active = 1 AND ${ALLOWED_REFERENCE_PROPOSAL}`,
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
  enforce(LIMITS.readMinute, reviewer.id, ctx.now);
  const { proposal, batch } = await activeProposal(ctx, id, reviewer.id);
  // ?queue=triage: the line as triage shows it (a plant's text, no attention runs).
  const triage = new URL(ctx.request.url).searchParams.get("queue") === "triage";
  return json({ proposal: await proposalView(ctx.env.DB, batch, proposal, reviewer.id, triage) });
}

export async function restrictedProposalImage(ctx: Ctx, id: number, kind: "crop" | "page"): Promise<Response> {
  const reviewer = await requireReviewer(ctx);
  enforce(LIMITS.readMinute, reviewer.id, ctx.now);
  const { proposal, batch } = await activeProposal(ctx, id, reviewer.id);
  if (!batch.restrictedReference) throw new HttpError(404, "not_found");
  return privateReferenceImage(ctx.env, batch.id, proposal.media[kind]);
}

export async function restrictedCompletenessImage(ctx: Ctx, batchId: string, itemId: number): Promise<Response> {
  const reviewer = await requireReviewer(ctx);
  enforce(LIMITS.readMinute, reviewer.id, ctx.now);
  const batch = await openBatch(ctx, batchId, reviewer.id);
  if (!batch.restrictedReference || !isTriageBatch(batch)) throw new HttpError(404, "not_found");
  const image = await completenessImage(ctx.env.DB, batch.id, reviewer.id, itemId);
  return privateReferenceImage(ctx.env, batch.id, image);
}

export async function decide(ctx: Ctx, id: number): Promise<Response> {
  assertSameOrigin(ctx.request);
  const reviewer = await requireReviewer(ctx);
  if (reviewer.terms_version !== TERMS_VERSION) throw new HttpError(403, "terms_required");
  enforce(LIMITS.writeMinute, reviewer.id, ctx.now);
  // The maintainer's own triage runs to thousands of lines a day: the daily cap is for volunteers (the per-minute one stays).
  if (!isAdmin(ctx.env, reviewer.id)) await enforceWriteDay(ctx.env.DB, reviewer.id, ctx.now);
  const body = await readJson(ctx.request, MAX_PAGE_BODY_BYTES);
  const { proposal, batch } = await activeProposal(ctx, id, reviewer.id);
  if (typeof body.value !== "string") throw new HttpError(400, "invalid_decision", "value is required");
  // Triage answers (migrations/0012_triage.sql): only in a triage batch, only on a line with a candidate, never text.
  const normalized = batch.taskType === "line_verify" && isTriageValue(body.value)
    ? isTriageBatch(batch) && triageable(proposal) && (body.text === undefined || body.text === null)
      ? { ok: true as const, value: body.value, text: null }
      : { ok: false as const, error: "a triage answer is for a line with a candidate in a triage batch, without text" }
    : taskType(batch.taskType)!.normalizeDecision(proposal, body.value, body.text);
  if (!normalized.ok) throw new HttpError(400, "invalid_decision", normalized.error);
  const db = ctx.env.DB;
  const existing = await db
    .prepare("SELECT id, value, text, proposal_sha256 FROM decisions WHERE proposal_id = ?1 AND reviewer_id = ?2 AND superseded_at IS NULL")
    .bind(proposal.id, reviewer.id)
    .first<{ id: string; value: string; text: string | null; proposal_sha256: string }>();
  if (batch.restrictedReference && isTriageBatch(batch) && triageable(proposal) &&
    existing?.proposal_sha256 !== proposal.contentSha256 && !isTriageValue(normalized.value)) {
    throw new HttpError(409, "not_open", "answer triage before correcting this line");
  }
  // Volunteer lines: a decision is final (only a reviewer's first decision on a line could count). So is a blind
  // second pass: typed before the reviewer could see the candidate, it must not change once they can.
  if (existing && (isConsensus(batch) || taskType(batch.taskType)!.finalDecision?.(proposal))) throw new HttpError(409, "decided", "this line is decided");
  // A volunteer_v1 line (line_verify volunteer resolution): decisions are final, and only its routing step's
  // reviewers may decide it (the admin alone at the maintainer step; anyone else at the fourth).
  const admin = isAdmin(ctx.env, reviewer.id);
  let volunteerBefore: LineRouting | null = null;
  // A P-hist gold line (volunteer_v1_1): final, once per reviewer across the batches, graded, never routed.
  const gold = isVolunteerV11(batch) ? goldOf(proposal) : null;
  if (gold) {
    if (existing || (await goldDecided(db, reviewer.id, gold.gold_id))) throw new HttpError(409, "decided", "this line is decided");
  } else if (isVolunteerV1(batch)) {
    if (existing) throw new HttpError(409, "decided", "this line is decided");
    volunteerBefore = await routingOf(db, proposal);
    if (!openFor(volunteerBefore, admin)) throw new HttpError(409, "not_open", "this line is not open to you");
  }
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
  if (volunteerBefore) await recordVolunteerDecision(db, batch, proposal, decisionId, reviewer.id, admin, volunteerBefore, iso(ctx.now));
  if (gold) await recordGoldDecision(db, proposal, decisionId, reviewer.id, normalized, iso(ctx.now));
  // A pointed print: the rest of its book leaves the batch (migrations/0011_pointed_books.sql). Gold is never a signal.
  if (batch.taskType === "line_verify" && normalized.value === "pointed_print" && !gold) {
    await dropPointedBook(db, batch, proposal, decisionId, reviewer.id, admin, iso(ctx.now));
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
    progress: await progressFor(db, batch, reviewer.id, ctx.now, null, isAdmin(ctx.env, reviewer.id)),
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
  enforce(LIMITS.draftMinute, reviewer.id, ctx.now);
  enforce(LIMITS.draftDay, reviewer.id, ctx.now);
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
  enforce(LIMITS.draftMinute, reviewer.id, ctx.now);
  const { proposal } = await activeProposal(ctx, id, reviewer.id);
  await ctx.env.DB.prepare("DELETE FROM drafts WHERE reviewer_id = ?1 AND proposal_id = ?2").bind(reviewer.id, proposal.id).run();
  return json({ ok: true });
}

export async function skip(ctx: Ctx, id: number): Promise<Response> {
  assertSameOrigin(ctx.request);
  const reviewer = await requireReviewer(ctx);
  enforce(LIMITS.writeMinute, reviewer.id, ctx.now);
  const { proposal, batch } = await activeProposal(ctx, id, reviewer.id);
  await ctx.env.DB.prepare("INSERT OR IGNORE INTO skips (reviewer_id, proposal_id, created_at) VALUES (?1, ?2, ?3)")
    .bind(reviewer.id, proposal.id, iso(ctx.now))
    .run();
  if (isConsensus(batch)) return json({ ok: true, progress: await consensusProgress(ctx.env.DB, batch, reviewer.id, true) });
  return json({ ok: true, progress: await progressFor(ctx.env.DB, batch, reviewer.id, ctx.now, null, isAdmin(ctx.env, reviewer.id)) });
}

export async function clearSkips(ctx: Ctx, batchId: string): Promise<Response> {
  assertSameOrigin(ctx.request);
  const reviewer = await requireReviewer(ctx);
  enforce(LIMITS.writeMinute, reviewer.id, ctx.now);
  const batch = await openBatch(ctx, batchId, reviewer.id);
  await ctx.env.DB.prepare("DELETE FROM skips WHERE reviewer_id = ?1 AND proposal_id IN (SELECT id FROM proposals WHERE batch_id = ?2)")
    .bind(reviewer.id, batch.id)
    .run();
  return json({ ok: true, progress: await progressFor(ctx.env.DB, batch, reviewer.id, ctx.now, null, isAdmin(ctx.env, reviewer.id)) });
}

async function requireAdmin(ctx: Ctx): Promise<ReviewerRow> {
  const reviewer = await requireReviewer(ctx);
  if (!isAdmin(ctx.env, reviewer.id)) throw new HttpError(403, "admin_only");
  return reviewer;
}

/** Deployment and local mode both use the explicit flag. Every realism endpoint still requires an admin. */
function realismEnabled(env: Env): boolean {
  return env.SYNTH_REALISM_ENABLED === "1";
}

async function realismAccess(ctx: Ctx, id: string, write: boolean) {
  if (!realismEnabled(ctx.env)) throw new HttpError(404, "not_found");
  const reviewer = await requireAdmin(ctx);
  if (reviewer.terms_version !== TERMS_VERSION) throw new HttpError(403, "terms_required");
  if (write) assertSameOrigin(ctx.request);
  enforce(write ? LIMITS.realismMinute : LIMITS.readMinute, reviewer.id, ctx.now);
  const batch = await getBatch(ctx.env.DB, id);
  if (batch?.taskType !== SYNTH_REALISM || batch.status !== "open") throw new HttpError(404, "not_found");
  return reviewer.id;
}

export async function synthNext(ctx: Ctx, batch: string): Promise<Response> {
  const reviewer = await realismAccess(ctx, batch, true);
  return json(await nextRealism(ctx.env.DB, batch, reviewer, ctx.now));
}

export async function synthChoice(ctx: Ctx, batch: string, trial: string): Promise<Response> {
  const reviewer = await realismAccess(ctx, batch, true);
  return json(await realismChoice(ctx.env.DB, batch, reviewer, trial, await readJson(ctx.request), ctx.now));
}

export async function synthFeedback(ctx: Ctx, batch: string, trial: string): Promise<Response> {
  const reviewer = await realismAccess(ctx, batch, true);
  return json(await realismFeedback(ctx.env.DB, batch, reviewer, trial, await readJson(ctx.request), ctx.now));
}

export async function synthAsset(ctx: Ctx, batch: string, trial: string, side: Side, kind: "page" | "line"): Promise<Response> {
  const reviewer = await realismAccess(ctx, batch, false);
  return realismAsset(ctx.env.DB, batch, reviewer, trial, side, kind);
}

async function trainingAccess(ctx: Ctx, batchId: string, write: boolean) {
  const reviewer = await requireAdmin(ctx);
  if (reviewer.terms_version !== TERMS_VERSION) throw new HttpError(403, "terms_required");
  if (write) assertSameOrigin(ctx.request);
  enforce(write ? LIMITS.writeMinute : LIMITS.readMinute, reviewer.id, ctx.now);
  const batch = await getBatch(ctx.env.DB, batchId);
  if (!batch || batch.status !== "open" || !isTrainingPaste(batch)) throw new HttpError(404, "not_found");
  return reviewer;
}

export async function trainingNext(ctx: Ctx, batch: string): Promise<Response> {
  const reviewer = await trainingAccess(ctx, batch, false);
  const cursor = ctx.url.searchParams.get("after");
  const after = cursor === null ? null : Number(cursor);
  if (cursor !== null && (!/^\d{1,15}$/.test(cursor) || !after)) throw new HttpError(404, "not_found");
  return json(await nextTrainingPage(ctx.env.DB, batch, reviewer.id, after));
}

export async function trainingRead(ctx: Ctx, batch: string, page: number): Promise<Response> {
  const reviewer = await trainingAccess(ctx, batch, false);
  return json(await trainingPage(ctx.env.DB, batch, reviewer.id, page));
}

export async function trainingSave(ctx: Ctx, batch: string, page: number): Promise<Response> {
  const reviewer = await trainingAccess(ctx, batch, true);
  const { text, revision } = await readJson(ctx.request, MAX_PAGE_BODY_BYTES);
  return json(await saveTrainingPage(ctx.env.DB, batch, page, reviewer, text, revision, iso(ctx.now)));
}

export async function trainingImage(ctx: Ctx, batch: string, page: number): Promise<Response> {
  await trainingAccess(ctx, batch, false);
  return trainingAsset(ctx.env.DB, batch, page);
}

export async function adminProgress(ctx: Ctx): Promise<Response> {
  const reviewer = await requireAdmin(ctx);
  const out = [];
  for (const batch of await listBatches(ctx.env.DB, false)) {
    if (!canReadReference(ctx.env, ctx.url, reviewer.id, batch)) continue;
    if (batch.taskType === PAGE_PASTE_TRAIN) {
      if (isTrainingPaste(batch)) {
        const { counts, reviewers } = await trainingAdminProgress(ctx.env.DB, batch.id);
        out.push({ id: batch.id, taskType: batch.taskType, title: batch.title, status: batch.status, minReviewers: 1, counts, reviewers });
      }
      continue;
    }
    if (batch.taskType === SYNTH_REALISM) {
      if (realismEnabled(ctx.env)) {
        const { counts, reviewers } = await realismAdmin(ctx.env.DB, batch, ctx.now);
        out.push({ id: batch.id, taskType: batch.taskType, title: batch.title, status: batch.status, minReviewers: 1, counts, reviewers });
      }
      continue;
    }
    if (isConsensus(batch) && ctx.env.CONSENSUS_ENABLED !== "1") continue;
    const rows = await exportRows(ctx.env.DB, batch.id);
    const extras = isConsensus(batch) ? await exportExtras(ctx.env.DB, batch.id) : isVolunteerV1(batch) ? { ...(await volunteerExtras(ctx.env.DB, batch.id)), ...(isVolunteerV11(batch) ? await phistGoldExtras(ctx.env.DB, batch.id) : {}) } : {};
    const drops = batch.taskType === "line_verify" ? await pointedDropsExtra(ctx.env.DB, batch.id) : {};
    const result = buildExport({ batch, ...rows, ...extras, ...drops, exportedAt: iso(ctx.now) });
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
  const reviewer = await requireAdmin(ctx);
  const batch = await getBatch(ctx.env.DB, batchId);
  if (!batch || !canReadReference(ctx.env, ctx.url, reviewer.id, batch)) throw new HttpError(404, "not_found");
  if (batch.restrictedReference && await pendingBlindReference(ctx.env.DB, batch.id, reviewer.id, ctx.now)) {
    throw new HttpError(409, "not_open", "finish the blind second pass before exporting");
  }
  if (batch.taskType === PAGE_PASTE_TRAIN) {
    if (!isTrainingPaste(batch)) throw new HttpError(404, "not_found");
    const { counts, file } = await trainingAdmin(ctx.env.DB, batch, ctx.now);
    return json({ counts, problems: [], files: { [TRAIN_EXPORT_FILE]: file } });
  }
  if (batch.taskType === SYNTH_REALISM) {
    if (!realismEnabled(ctx.env)) throw new HttpError(404, "not_found");
    return (await realismAdmin(ctx.env.DB, batch, ctx.now)).export();
  }
  if (isConsensus(batch)) assertConsensusEnabled(ctx.env);
  const rows = await exportRows(ctx.env.DB, batch.id);
  const extras = isConsensus(batch) ? await exportExtras(ctx.env.DB, batch.id) : isVolunteerV1(batch) ? { ...(await volunteerExtras(ctx.env.DB, batch.id)), ...(isVolunteerV11(batch) ? await phistGoldExtras(ctx.env.DB, batch.id) : {}) } : {};
  const drops = batch.taskType === "line_verify" ? await pointedDropsExtra(ctx.env.DB, batch.id) : {};
  const result = buildExport({ batch, ...rows, ...extras, ...drops, exportedAt: iso(ctx.now) });
  return json({
    counts: result.counts,
    problems: result.problems,
    files: {
      [result.decisionsFile.fileName]: result.decisionsFile.content,
      [result.ledgerFile.fileName]: result.ledgerFile.content,
      ...Object.fromEntries(result.extraFiles.map((f) => [f.fileName, f.content])),
    },
  });
}

async function consensusBatch(ctx: Ctx, batchId: string, reviewerId: string) {
  assertConsensusEnabled(ctx.env);
  const batch = await getBatch(ctx.env.DB, batchId);
  if (!batch || !isConsensus(batch) || !canReadReference(ctx.env, ctx.url, reviewerId, batch)) throw new HttpError(404, "not_found");
  return batch;
}

/** Admin: a volunteer batch's line states, and each volunteer's gold record and standing (never shown to volunteers). */
export async function adminVolunteers(ctx: Ctx, batchId: string): Promise<Response> {
  const admin = await requireAdmin(ctx);
  const batch = await consensusBatch(ctx, batchId, admin.id);
  return json(await volunteerReport(ctx.env.DB, batch));
}

/** Admin: exclude a volunteer from agreement in a batch, or include them again ({excluded: boolean}). */
export async function adminExclusion(ctx: Ctx, batchId: string, reviewerId: string): Promise<Response> {
  assertSameOrigin(ctx.request);
  const admin = await requireAdmin(ctx);
  enforce(LIMITS.writeMinute, admin.id, ctx.now);
  const batch = await consensusBatch(ctx, batchId, admin.id);
  const body = await readJson(ctx.request);
  if (typeof body.excluded !== "boolean") throw new HttpError(400, "invalid_request", "excluded must be true or false");
  if (!(await getReviewer(ctx.env.DB, reviewerId))) throw new HttpError(404, "not_found");
  await setExclusion(ctx.env.DB, batch, reviewerId, body.excluded, ctx.now);
  return json(await volunteerReport(ctx.env.DB, batch));
}

/**
 * Admin: pull a P-hist gold line ({pulled: true, reason}) or put it back ({pulled: false}). Forward-only
 * (docs/specs/line_verify_phist_gold_v1_1.md, "Pulling a gold line").
 */
export async function adminPhistGoldPull(ctx: Ctx, goldId: string): Promise<Response> {
  assertSameOrigin(ctx.request);
  const admin = await requireAdmin(ctx);
  enforce(LIMITS.writeMinute, admin.id, ctx.now);
  const body = await readJson(ctx.request);
  if (typeof body.pulled !== "boolean") throw new HttpError(400, "invalid_request", "pulled must be true or false");
  if (!(body.reason === undefined || body.reason === null || (typeof body.reason === "string" && body.reason.length <= 500))) {
    throw new HttpError(400, "invalid_request", "reason must be a short text");
  }
  if (!(await goldKnown(ctx.env.DB, goldId))) throw new HttpError(404, "not_found");
  await setPull(ctx.env.DB, goldId, body.pulled, typeof body.reason === "string" ? body.reason : null, admin.id, iso(ctx.now));
  return json({ goldId, pulled: body.pulled });
}

// ---------- page completeness (migrations/0014_page_completeness.sql) ----------

/** A triage batch's page, for a signed-in reviewer who accepted the current terms (a write). */
async function triagePage(ctx: Ctx, batchId: string, itemId: number) {
  assertSameOrigin(ctx.request);
  const reviewer = await requireReviewer(ctx);
  if (reviewer.terms_version !== TERMS_VERSION) throw new HttpError(403, "terms_required");
  enforce(LIMITS.writeMinute, reviewer.id, ctx.now);
  const batch = await openBatch(ctx, batchId, reviewer.id);
  if (!isTriageBatch(batch)) throw new HttpError(404, "not_found");
  if (!(await pageItem(ctx.env.DB, batch.id, itemId))) throw new HttpError(404, "not_found");
  return { reviewer, batch };
}

/** POST {answer: "complete" | "missing_lines"}: is every printed line of the page boxed? */
export async function checkPage(ctx: Ctx, batchId: string, itemId: number): Promise<Response> {
  const { reviewer, batch } = await triagePage(ctx, batchId, itemId);
  const body = await readJson(ctx.request);
  if (!(PAGE_ANSWERS as readonly unknown[]).includes(body.answer)) throw new HttpError(400, "invalid_answer", `answer must be one of ${PAGE_ANSWERS.join(", ")}`);
  if (!(await recordInitialPageCheck(ctx.env.DB, batch.id, itemId, reviewer.id, body.answer as "complete" | "missing_lines", iso(ctx.now)))) {
    throw new HttpError(409, "not_open", "this page is not ready for a completeness check");
  }
  return json({ ok: true });
}

/** POST {box, value: "typed" | "unreadable", text}: a missing line, boxed and typed on the desktop. */
export async function addPageLine(ctx: Ctx, batchId: string, itemId: number): Promise<Response> {
  const { reviewer, batch } = await triagePage(ctx, batchId, itemId);
  if ((await currentCheck(ctx.env.DB, itemId, reviewer.id)) !== "missing_lines") throw new HttpError(409, "not_open", "add lines to a page marked as missing lines");
  const body = await readJson(ctx.request);
  const problem = boxProblem(body.box);
  if (problem) throw new HttpError(400, "invalid_box", problem);
  const n = normalizeAdded(body.value, body.text);
  if (!n.ok) throw new HttpError(400, "invalid_decision", n.error);
  const id = await addLine(ctx.env.DB, batch.id, itemId, reviewer.id, body.box as number[], n.value, n.text, iso(ctx.now));
  if (!id) throw new HttpError(409, "not_open");
  return json({ id, value: n.value, text: n.text });
}

export async function removePageLine(ctx: Ctx, batchId: string, lineId: string): Promise<Response> {
  assertSameOrigin(ctx.request);
  const reviewer = await requireReviewer(ctx);
  enforce(LIMITS.writeMinute, reviewer.id, ctx.now);
  const batch = await openBatch(ctx, batchId, reviewer.id);
  if (!(await removeLine(ctx.env.DB, batch.id, lineId, reviewer.id, iso(ctx.now)))) throw new HttpError(404, "not_found");
  return json({ ok: true });
}

/** POST: the page's missing lines are all added. */
export async function finishPage(ctx: Ctx, batchId: string, itemId: number): Promise<Response> {
  const { reviewer, batch } = await triagePage(ctx, batchId, itemId);
  if ((await currentCheck(ctx.env.DB, itemId, reviewer.id)) !== "missing_lines") throw new HttpError(409, "not_open", "this page is not waiting for missing lines");
  if (!(await recordPageCheck(ctx.env.DB, batch.id, itemId, reviewer.id, iso(ctx.now)))) {
    throw new HttpError(409, "not_open");
  }
  return json({ ok: true });
}
