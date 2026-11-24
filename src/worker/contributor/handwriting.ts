import { handwritingAgeBands, handwritingSets, type ContributorSplit, type HandwritingSet } from "../../shared/contributor";
import type { Ctx } from "../api";
import { base64url, base64urlDecode, hmacSha256, hmacVerify, randomId, requireSecret } from "../crypto";
import { HttpError, json, readJson } from "../http";
import { enforce } from "../ratelimit";
import { gone, hash, invalid, parseContributorManifest, pinnedJSON, submissionBucket, type Manifest, type Task, type Writer } from "./config";

const digest = /^[a-f0-9]{64}$/;
const account = /^rv_[a-f0-9]{8}$/;
const splits = ["train", "dev", "eval_open"] as const;
const pairing = /^(cw-[a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/;
const invite = /^[a-f0-9]{32}$/;
const attemptLimit = { bucket: "handwriting-enrol", max: 8, windowS: 60 };
const noStore = { "cache-control": "private, no-store", "cdn-cache-control": "no-store" };
type Sheets = Record<HandwritingSet, Extract<Task, { kind: "handwriting" }>[]>;
type Plan = {
  schema: "heocr.handwriting_signup.v1";
  approval: Manifest["approval"];
  policy: Manifest["policy"];
  capacity: { split: ContributorSplit; max: number }[];
  invites: string[];
  sheets: Sheets;
};
type RosterRow = {
  ordinal: number; writer: string; ageBand: typeof handwritingAgeBands[number]; set: HandwritingSet; split: ContributorSplit;
};

export async function handwritingPlan(ctx: Ctx) {
  const env = ctx.env;
  const pin = env.CONTRIBUTOR_HANDWRITING_CONFIG_SHA256;
  if (!pin) return null;
  const reviewer = env.CONTRIBUTOR_ROSTER_REVIEWER_ID;
  if (!digest.test(pin) || !reviewer || !account.test(reviewer) ||
      !env.TRAIN_CAPTURE_MEDIA || env.CONTRIBUTOR_CONFIG_SHA256) throw gone();
  const plan = await pinnedJSON(env.TRAIN_CAPTURE_MEDIA, "handwriting-signup", pin, 128 * 1024) as Plan | null;
  if (plan?.schema !== "heocr.handwriting_signup.v1" || !Array.isArray(plan.capacity) ||
      plan.capacity.length < 1 || plan.capacity.length > splits.length ||
      plan.capacity.some(entry => !entry || !splits.includes(entry.split) ||
        !Number.isInteger(entry.max) || entry.max < 1 || entry.max > handwritingSets.length ||
        !submissionBucket(env, entry.split)) ||
      new Set(plan.capacity.map(entry => entry.split)).size !== plan.capacity.length ||
      !Array.isArray(plan.invites) || !plan.invites.length || plan.invites.length > handwritingSets.length ||
      !plan.invites.every(value => typeof value === "string" && digest.test(value)) ||
      new Set(plan.invites).size !== plan.invites.length ||
      plan.invites.length !== plan.capacity.reduce((total, entry) => total + entry.max, 0) ||
      !plan.sheets || Object.keys(plan.sheets).length !== handwritingSets.length) throw gone();
  // Reuse the approved terms and handwriting-sheet validation for every page in the set.
  const writers = handwritingSets.map((set, i) => {
    const tasks = plan.sheets[set];
    if (!Array.isArray(tasks) || tasks.length < 3 || tasks.length > 4 ||
        tasks.some((task, j) => task?.kind !== "handwriting" || task.page !== `HW-V3-${set}0${j + 1}`)) throw gone();
    return { id: "cw-" + String(i).repeat(32), writerAccount: "rv_" + String(i).repeat(8),
      guardianAccount: null, ageBand: "18_plus", split: "train", tasks };
  });
  const sheetPins = writers.flatMap(writer => writer.tasks.map(task => task.sheetSha256));
  if (new Set(sheetPins).size !== sheetPins.length) throw gone();
  const manifest = await parseContributorManifest({schema:"heocr.contributor.v1",approval:plan.approval,policy:plan.policy,writers});
  return { plan, pin, reviewer, manifest: { ...manifest, writers: [] as Writer[] } };
}

export type HandwritingPlan = NonNullable<Awaited<ReturnType<typeof handwritingPlan>>>;

export async function handwritingSignup(ctx: Ctx, signup: HandwritingPlan, actor: string) {
  enforce(attemptLimit, actor, ctx.now);
  const { inviteCode, ageBand, set } = await readJson(ctx.request);
  if (typeof inviteCode !== "string" || !invite.test(inviteCode) || !handwritingAgeBands.some(band => band === ageBand) ||
      !handwritingSets.includes(set as HandwritingSet)) throw invalid();
  if (actor === signup.reviewer) throw gone();
  const pin = await hash(inviteCode);
  if (!signup.plan.invites.includes(pin)) throw gone();
  const db = ctx.env.DB;
  const writer = randomId("cw-", 16);
  const existing = await db.prepare(`SELECT e.writer_id AS writer FROM contributor_enrolments e
    JOIN contributor_handwriting_roster r ON r.writer_id=e.writer_id
    WHERE writer_account=? AND config_sha256=?`).bind(actor,signup.pin).first<{writer:string}>();
  if (existing) return existing.writer;
  const [assigned] = await db.batch([
    db.prepare(`INSERT INTO contributor_handwriting_roster(config_sha256,invite_sha256,writer_id,set_id,age_band,split)
      SELECT ?1,?2,?3,?4,?5,capacity.split
      FROM json_each(?7) AS choice
      JOIN (SELECT json_extract(value,'$.split') AS split, COUNT(r.ordinal) AS used
        FROM json_each(?7) LEFT JOIN contributor_handwriting_roster r ON r.split=json_extract(value,'$.split')
        GROUP BY json_extract(value,'$.split')) AS capacity ON capacity.split=json_extract(choice.value,'$.split')
      WHERE capacity.used < json_extract(choice.value,'$.max') AND NOT EXISTS
        (SELECT 1 FROM contributor_enrolments WHERE writer_account=?6 OR guardian_account=?6)
      ORDER BY capacity.used, choice.key LIMIT 1
      ON CONFLICT DO NOTHING`).bind(signup.pin,pin,writer,set,ageBand,actor,JSON.stringify(signup.plan.capacity)),
    db.prepare(`INSERT INTO contributor_enrolments(writer_id,writer_account,age_band,split,receipt)
      SELECT writer_id,?,age_band,split,? FROM contributor_handwriting_roster WHERE writer_id=?`)
      .bind(actor,randomId("cw-withdraw-",16),writer),
  ]);
  if (assigned?.meta.changes !== 1) throw new HttpError(409,"handwriting_slot_unavailable");
  return writer;
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
        pairingMessage(signup.pin,writer),base64urlDecode(signature)) || actor === signup.reviewer) throw gone();
  const policy = signup.manifest.policy;
  if (version !== policy.version || sha256 !== policy.guardian[lang].sha256) throw new HttpError(409,"consent_changed");
  const result = await ctx.env.DB.prepare(`UPDATE contributor_enrolments
    SET guardian_account=?1,guardian_version=?2,guardian_sha256=?3,guardian_at=?4
    WHERE writer_id=?5 AND age_band<>'18_plus' AND guardian_account IS NULL AND withdrawn_at IS NULL
      AND EXISTS(SELECT 1 FROM contributor_handwriting_roster WHERE writer_id=?5 AND config_sha256=?6)
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
  return rows.results.map(({set,...writer}) => ({...writer,tasks:signup.plan.sheets[set]}));
}

export const rosterGate = `EXISTS (
  SELECT 1 FROM contributor_handwriting_roster r JOIN contributor_handwriting_pins p
    ON p.config_sha256 = r.config_sha256 AND p.through_ordinal >= r.ordinal
  WHERE r.writer_id=? AND r.config_sha256=?)`;

export async function rosterPinned(ctx: Ctx, writer: string, pin: string) {
  return !!await ctx.env.DB.prepare("SELECT 1 WHERE "+rosterGate).bind(writer,pin).first();
}

const snapshot = (pin: string, rows: RosterRow[]) =>
  JSON.stringify({schema:"heocr.handwriting_roster.v1",configSha256:pin,rows:rows.map(({ordinal,writer,ageBand,set,split}) =>
    ({ordinal,writer,ageBand,set,split}))}) + "\n";

export async function handwritingRoster(ctx: Ctx, signup: HandwritingPlan, actor: string) {
  if (actor !== signup.reviewer) throw gone();
  const db = ctx.env.DB;
  const rows = (await db.prepare(`SELECT ordinal,writer_id AS writer,age_band AS ageBand,set_id AS "set",split
    FROM contributor_handwriting_roster WHERE config_sha256=? ORDER BY ordinal`).bind(signup.pin).all<RosterRow>()).results;
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
