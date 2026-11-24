import { handwritingAgeBands, handwritingSets, type ContributorSplit, type HandwritingOffer, type HandwritingSet } from "../../shared/contributor";
import type { Ctx } from "../api";
import { base64url, base64urlDecode, hmacSha256, hmacVerify, randomId, requireSecret } from "../crypto";
import { HttpError, json, readJson } from "../http";
import { enforce } from "../ratelimit";
import { gone, hash, invalid, parseContributorManifest, pinnedJSON, submissionBucket, type Manifest, type Task, type Writer } from "./config";

const digest = /^[a-f0-9]{64}$/;
const splits = ["train", "dev", "eval_open"] as const;
const pairing = /^(cw-[a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/;
const invite = /^[a-f0-9]{32}$/;
const maxWriters = 50;
const calibrationLine = 30;
const attemptLimit = { bucket: "handwriting-enrol", max: 8, windowS: 60 };
const noStore = { "cache-control": "private, no-store", "cdn-cache-control": "no-store" };
type Sheets = Record<HandwritingSet, Extract<Task, { kind: "handwriting" }>[]>;
type Plan = {
  schema: "heocr.handwriting_signup.v1";
  approval: Manifest["approval"] & { allocationAmendmentSha256: string };
  policy: Manifest["policy"];
  writerLimit: number;
  capacity: { split: ContributorSplit; max: number }[];
  setsBySplit: Partial<Record<ContributorSplit, HandwritingSet[]>>;
  lineRoles: { "30": "calibration" };
  invites: string[];
  cohort?: { sha256: string; maxUses: number; expiresAt: string };
  sheets: Sheets;
};
type RosterRow = {
  ordinal: number; writer: string; ageBand: typeof handwritingAgeBands[number]; set: HandwritingSet; split: ContributorSplit;
};

function validExpiry(value: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().replace(/\.000Z$/, "Z") === value.replace(/\.000Z$/, "Z");
}

function splitForSets(plan: Plan) {
  const bySet = new Map<HandwritingSet, ContributorSplit>();
  if (!plan.setsBySplit || Object.keys(plan.setsBySplit).length !== plan.capacity.length) throw gone();
  for (const {split} of plan.capacity) {
    const sets = plan.setsBySplit[split];
    if (!Array.isArray(sets) || !sets.length) throw gone();
    for (const set of sets) {
      if (!handwritingSets.includes(set) || bySet.has(set)) throw gone();
      bySet.set(set,split);
    }
  }
  if (bySet.size !== handwritingSets.length) throw gone();
  return bySet;
}

export async function handwritingPlan(ctx: Ctx) {
  const env = ctx.env;
  const pin = env.CONTRIBUTOR_HANDWRITING_CONFIG_SHA256;
  if (!pin) return null;
  if (!digest.test(pin) || !env.TRAIN_CAPTURE_MEDIA || env.CONTRIBUTOR_CONFIG_SHA256) throw gone();
  const plan = await pinnedJSON(env.TRAIN_CAPTURE_MEDIA, "handwriting-signup", pin, 128 * 1024) as Plan | null;
  if (plan?.schema !== "heocr.handwriting_signup.v1" ||
      typeof plan.approval?.allocationAmendmentSha256 !== "string" || !digest.test(plan.approval.allocationAmendmentSha256) ||
      plan.lineRoles?.[calibrationLine] !== "calibration" || Object.keys(plan.lineRoles).length !== 1 ||
      !Number.isInteger(plan.writerLimit) ||
      plan.writerLimit < 1 || plan.writerLimit > maxWriters || !Array.isArray(plan.capacity) ||
      plan.capacity.length < 1 || plan.capacity.length > splits.length ||
      plan.capacity.some(entry => !entry || !splits.includes(entry.split) ||
        !Number.isInteger(entry.max) || entry.max < 1 || entry.max > maxWriters ||
        !submissionBucket(env, entry.split)) ||
      new Set(plan.capacity.map(entry => entry.split)).size !== plan.capacity.length ||
      plan.capacity.reduce((total, entry) => total + entry.max, 0) < plan.writerLimit ||
      !Array.isArray(plan.invites) || plan.invites.length > maxWriters ||
      !plan.invites.every(value => typeof value === "string" && digest.test(value)) ||
      new Set(plan.invites).size !== plan.invites.length ||
      (plan.cohort === undefined ? !plan.invites.length : !plan.cohort ||
        typeof plan.cohort.sha256 !== "string" || !digest.test(plan.cohort.sha256) ||
        plan.invites.includes(plan.cohort.sha256) || !Number.isInteger(plan.cohort.maxUses) ||
        plan.cohort.maxUses < 1 || plan.cohort.maxUses > maxWriters || !validExpiry(plan.cohort.expiresAt)) ||
      !plan.sheets || Object.keys(plan.sheets).length !== handwritingSets.length) throw gone();
  const splitBySet = splitForSets(plan);
  // Reuse the approved terms and handwriting-sheet validation for every page in the set.
  const writers = handwritingSets.map((set, i) => {
    const tasks = plan.sheets[set];
    if (!Array.isArray(tasks) || tasks.length !== 4 ||
        tasks.some((task, j) => task?.kind !== "handwriting" || task.page !== `HW-V3-${set}0${j + 1}` ||
          task.id !== task.page)) throw gone();
    return { id: "cw-" + String(i).repeat(32), writerAccount: "rv_" + String(i).repeat(8),
      guardianAccount: null, ageBand: "18_plus", split: splitBySet.get(set)!, tasks };
  });
  const sheetPins = writers.flatMap(writer => writer.tasks.map(task => task.sheetSha256));
  if (new Set(sheetPins).size !== sheetPins.length) throw gone();
  const manifest = await parseContributorManifest({schema:"heocr.contributor.v1",approval:plan.approval,policy:plan.policy,writers});
  // Sheet hashes alone cannot detect a sentence shared by two otherwise distinct sheets.
  const lineSplits = new Map<string,ContributorSplit>();
  const calibration = writers[0]!.tasks[0]!.sentences[calibrationLine - 1];
  for (const writer of writers) for (const task of writer.tasks) {
    if (task.sentences[calibrationLine - 1] !== calibration) throw gone();
    for (const sentence of task.sentences.slice(0,calibrationLine - 1)) {
      const line = sentence.normalize("NFC").trim().replace(/\s+/gu," ");
      const split = lineSplits.get(line);
      if (split && split !== writer.split) throw gone();
      lineSplits.set(line,writer.split);
    }
  }
  return { plan, pin, splitBySet, manifest: { ...manifest, writers: [] as Writer[] } };
}

export type HandwritingPlan = NonNullable<Awaited<ReturnType<typeof handwritingPlan>>>;

// The server determines the split before consulting set loads. Use the same
// selection in the offer read and in the write so a stale offer cannot move a writer.
const offerScope = `split_room AS (
    SELECT json_extract(choice.value,'$.split') AS split
    FROM json_each(?2) AS choice
    LEFT JOIN contributor_handwriting_roster r ON r.split=json_extract(choice.value,'$.split') AND r.config_sha256=?1
    GROUP BY choice.key HAVING COUNT(r.split) < json_extract(choice.value,'$.max')
    ORDER BY COUNT(r.split), choice.key LIMIT 1
  ), set_loads AS (
    SELECT split_room.split, choices.value AS set_id, COUNT(r.set_id) AS uses
    FROM split_room JOIN json_each(?3, '$.' || split_room.split) AS choices
    LEFT JOIN contributor_handwriting_roster r ON r.set_id=choices.value AND r.split=split_room.split AND r.config_sha256=?1
    GROUP BY split_room.split, choices.key
  ), offer AS (
    SELECT split,set_id FROM set_loads
    WHERE uses=(SELECT MIN(uses) FROM set_loads)
      AND (SELECT COUNT(*) FROM contributor_handwriting_roster WHERE config_sha256=?1) < ?4
      AND (SELECT COUNT(*) FROM contributor_handwriting_roster WHERE config_sha256=?1 AND invite_sha256=?5) < ?6
      AND NOT EXISTS (SELECT 1 FROM contributor_handwriting_revoked_invites WHERE config_sha256=?1 AND invite_sha256=?5)
      AND EXISTS (SELECT 1 FROM reviewers WHERE id=?7 AND handwriting_opted_out=0)
      AND NOT EXISTS (SELECT 1 FROM contributor_enrolments WHERE writer_account=?7 OR guardian_account=?7)
  )`;

export async function handwritingOptedOut(ctx: Ctx, actor: string) {
  return (await ctx.env.DB.prepare("SELECT handwriting_opted_out FROM reviewers WHERE id=?")
    .bind(actor).first<number>("handwriting_opted_out")) === 1;
}

async function invitation(ctx: Ctx, signup: HandwritingPlan, actor: string) {
  enforce(attemptLimit, actor, ctx.now);
  const body = await readJson(ctx.request);
  const { inviteCode, ageBand } = body;
  if (typeof inviteCode !== "string" || !invite.test(inviteCode) || !handwritingAgeBands.some(band => band === ageBand)) throw invalid();
  const pin = await hash(inviteCode);
  const cohort = signup.plan.cohort?.sha256 === pin ? signup.plan.cohort : null;
  if (cohort ? Date.parse(cohort.expiresAt) <= ctx.now : !signup.plan.invites.includes(pin)) throw gone();
  const args = [signup.pin, JSON.stringify(signup.plan.capacity), JSON.stringify(signup.plan.setsBySplit),
    signup.plan.writerLimit, pin, cohort?.maxUses ?? 1, actor] as const;
  return { body, args, ageBand };
}

const unavailable = () => new HttpError(409,"handwriting_slot_unavailable");

export async function handwritingOffer(ctx: Ctx, signup: HandwritingPlan, actor: string): Promise<HandwritingOffer> {
  const { args } = await invitation(ctx,signup,actor);
  const { results } = await ctx.env.DB.prepare(`WITH ${offerScope} SELECT split,set_id FROM offer ORDER BY set_id`)
    .bind(...args).all<{split:ContributorSplit;set_id:HandwritingSet}>();
  if (!results.length) throw unavailable();
  return { split:results[0]!.split, sets:results.map(row => row.set_id) };
}

export async function handwritingSignup(ctx: Ctx, signup: HandwritingPlan, actor: string) {
  const { body:{split,set}, args, ageBand } = await invitation(ctx,signup,actor);
  if (!splits.includes(split as ContributorSplit) || !handwritingSets.includes(set as HandwritingSet)) throw invalid();
  const db = ctx.env.DB;
  const writer = randomId("cw-", 16);
  const existing = await db.prepare(`SELECT e.writer_id AS writer FROM contributor_enrolments e
    JOIN contributor_handwriting_roster r ON r.writer_id=e.writer_id
    WHERE writer_account=? AND config_sha256=?`).bind(actor,signup.pin).first<{writer:string}>();
  if (existing) return existing.writer;
  const [assigned] = await db.batch([
    db.prepare(`WITH ${offerScope}
      INSERT INTO contributor_handwriting_roster(config_sha256,invite_sha256,writer_id,set_id,age_band,split)
      SELECT ?1,?5,?8,set_id,?9,split FROM offer WHERE split=?10 AND set_id=?11
      ON CONFLICT DO NOTHING`)
      .bind(...args,writer,ageBand,split,set),
    db.prepare(`INSERT INTO contributor_enrolments(writer_id,writer_account,age_band,split,receipt)
      SELECT writer_id,?,age_band,split,? FROM contributor_handwriting_roster WHERE writer_id=?`)
      .bind(actor,randomId("cw-withdraw-",16),writer),
  ]);
  if (assigned?.meta.changes !== 1) throw unavailable();
  return writer;
}

/** Record a revocation without changing the pinned plan or existing writers. */
export async function revokeHandwritingInvite(ctx: Ctx, signup: HandwritingPlan, actor: string) {
  if (!(ctx.env.ADMIN_REVIEWER_IDS??"").split(",").map(id=>id.trim()).includes(actor)) throw gone();
  const { sha256 } = await readJson(ctx.request);
  if (typeof sha256 !== "string" || !digest.test(sha256)) throw invalid();
  if (sha256 !== signup.plan.cohort?.sha256 && !signup.plan.invites.includes(sha256)) throw gone();
  await ctx.env.DB.prepare(`INSERT INTO contributor_handwriting_revoked_invites(config_sha256,invite_sha256,revoked_at)
    VALUES(?,?,?) ON CONFLICT DO NOTHING`).bind(signup.pin,sha256,new Date(ctx.now).toISOString()).run();
  return json({revoked:true},200,noStore);
}

const pairingMessage = (pin: string, writer: string) => `handwriting-guardian/v1/${pin}/${writer}`;
export async function guardianCode(ctx: Ctx, pin: string, writer: string) {
  const signature = await hmacSha256(requireSecret(ctx.env.SESSION_SECRET,"SESSION_SECRET"),pairingMessage(pin,writer));
  return writer + "." + base64url(signature);
}

export async function acceptGuardian(ctx: Ctx, signup: HandwritingPlan, actor: string) {
  enforce(attemptLimit, actor, ctx.now);
  const { code, accept, lang, version, sha256 } = await readJson(ctx.request);
  const match = typeof code === "string" && pairing.exec(code);
  if (!match || accept !== true || (lang !== "he" && lang !== "en")) throw invalid();
  const writer = match[1]!, signature = match[2]!;
  if (base64url(base64urlDecode(signature)) !== signature ||
      !await hmacVerify(requireSecret(ctx.env.SESSION_SECRET,"SESSION_SECRET"),
        pairingMessage(signup.pin,writer),base64urlDecode(signature))) throw gone();
  const policy = signup.manifest.policy;
  if (version !== policy.version || sha256 !== policy.guardian[lang].sha256) throw new HttpError(409,"consent_changed");
  const result = await ctx.env.DB.prepare(`UPDATE contributor_enrolments
    SET guardian_account=?1,guardian_version=?2,guardian_sha256=?3,guardian_at=?4
    WHERE writer_id=?5 AND age_band<>'18_plus' AND guardian_account IS NULL AND withdrawn_at IS NULL
      AND EXISTS(SELECT 1 FROM contributor_handwriting_roster WHERE writer_id=?5 AND config_sha256=?6)
      AND EXISTS (SELECT 1 FROM reviewers WHERE id=?1 AND handwriting_opted_out=0)
      AND NOT EXISTS(SELECT 1 FROM contributor_enrolments WHERE writer_account=?1)`)
    .bind(actor,policy.version+":"+policy.licence,sha256,new Date(ctx.now).toISOString(),writer,signup.pin).run();
  if (result.meta.changes !== 1) throw gone();
  return writer;
}

export async function selfWriters(ctx: Ctx, signup: HandwritingPlan, actor: string) {
  const rows = await ctx.env.DB.prepare(`SELECT e.writer_id AS id, e.writer_account AS writerAccount,
      e.guardian_account AS guardianAccount, r.age_band AS ageBand, r.split, r.set_id AS "set"
    FROM contributor_handwriting_roster r JOIN contributor_enrolments e USING(writer_id)
    WHERE r.config_sha256=? AND (writer_account=? OR guardian_account=?) ORDER BY r.ordinal`)
    .bind(signup.pin,actor,actor).all<Omit<Writer,"tasks">&{set:HandwritingSet}>();
  return rows.results.map(({set,...writer}) => {
    if (signup.splitBySet.get(set) !== writer.split) throw gone();
    return {...writer,tasks:signup.plan.sheets[set]};
  });
}

const snapshot = (pin: string, rows: RosterRow[]) =>
  JSON.stringify({schema:"heocr.handwriting_roster.v1",configSha256:pin,rows:rows.map(({ordinal,writer,ageBand,set,split}) =>
    ({ordinal,writer,ageBand,set,split}))}) + "\n";

export async function handwritingRoster(ctx: Ctx, signup: HandwritingPlan) {
  const db = ctx.env.DB;
  const rows = (await db.prepare(`SELECT ordinal,writer_id AS writer,age_band AS ageBand,set_id AS "set",split
    FROM contributor_handwriting_roster WHERE config_sha256=? ORDER BY ordinal`).bind(signup.pin).all<RosterRow>()).results;
  if (rows.length > signup.plan.writerLimit ||
      rows.some(row => signup.splitBySet.get(row.set) !== row.split || !handwritingAgeBands.includes(row.ageBand)) ||
      signup.plan.capacity.some(({split,max}) => rows.filter(row => row.split === split).length > max)) throw gone();
  const prior = await db.prepare(`SELECT roster_sha256,through_ordinal FROM contributor_handwriting_pins
    WHERE config_sha256=? ORDER BY through_ordinal DESC LIMIT 1`).bind(signup.pin)
    .first<{roster_sha256:string;through_ordinal:number}>();
  if (prior && await hash(snapshot(signup.pin,rows.filter(row => row.ordinal <= prior.through_ordinal))) !== prior.roster_sha256) throw gone();
  const previousSha256 = prior?.roster_sha256 ?? null;
  if (ctx.request.method === "GET") {
    const canonical = snapshot(signup.pin,rows);
    return json({canonical, sha256:await hash(canonical), previousSha256, throughOrdinal:rows.at(-1)?.ordinal ?? 0}, 200, noStore);
  }
  const body = await readJson(ctx.request);
  if (!Number.isSafeInteger(body.throughOrdinal) || !rows.some(row => row.ordinal === body.throughOrdinal) ||
      typeof body.sha256 !== "string" || !digest.test(body.sha256)) throw invalid();
  const through = body.throughOrdinal as number;
  if (body.previousSha256 !== previousSha256 || through <= (prior?.through_ordinal ?? 0) ||
      await hash(snapshot(signup.pin,rows.filter(row => row.ordinal <= through))) !== body.sha256)
    throw new HttpError(409,"handwriting_roster_changed");
  const result = await db.prepare(`INSERT INTO contributor_handwriting_pins
    (roster_sha256,config_sha256,through_ordinal,previous_sha256,pinned_at)
    SELECT ?1,?2,?3,?4,?5 WHERE ?4 IS
      (SELECT roster_sha256 FROM contributor_handwriting_pins WHERE config_sha256=?2 ORDER BY through_ordinal DESC LIMIT 1)
    ON CONFLICT DO NOTHING`).bind(body.sha256,signup.pin,through,previousSha256,new Date(ctx.now).toISOString()).run();
  if (result.meta.changes !== 1) throw new HttpError(409,"handwriting_roster_changed");
  return json({sha256:body.sha256,throughOrdinal:through}, 200, noStore);
}
