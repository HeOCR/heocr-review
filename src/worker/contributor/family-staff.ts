import type { HandwritingOffer } from "../../shared/contributor";
import type { Ctx } from "../api";
import { randomId } from "../crypto";
import { HttpError } from "../http";
import { gone, hash, parseContributorManifest, pinnedJSON, submissionBucket, type Manifest, type Task, type Writer } from "./config";
import { kidsSheetOrder } from "./handwriting";

// Allocation amendment 6 (restricted-eval #2035): adults invited with one cohort code, TRAIN or DEV only.
export const FAMILY_STAFF_SET = "FS";
export const FAMILY_STAFF_ORDER_PREFIX = "20261128:hw3-family-staff-order:";
const SLOT_PREFIX = "20261128:hw3-family-staff:";
const letters = { train: "T", dev: "D" } as const;
type FamilySplit = keyof typeof letters;
const familySplits = Object.keys(letters) as FamilySplit[];
const digest = /^[a-f0-9]{64}$/;
const maxWriters = 50;
type Sheet = Extract<Task, { kind: "handwriting" }>;
type Plan = {
  schema: "heocr.handwriting_family_staff.v1";
  approval: Manifest["approval"] & { allocationAmendmentSha256: string };
  policy: Manifest["policy"];
  invite: { sha256: string; maxUses: number; expiresAt: string };
  /** The shared calibration line: its text, which appears exactly once in each pack. */
  calibration: string;
  packs: Record<FamilySplit, Sheet[]>;
};

export async function familyStaffPlan(ctx: Ctx) {
  const env = ctx.env;
  const pin = env.CONTRIBUTOR_FAMILY_STAFF_CONFIG_SHA256;
  if (!pin) return null;
  // The plan holds the DEV pack's text, so it lives in the private DEV bucket.
  if (!digest.test(pin) || !env.CONTRIBUTOR_DEV_MEDIA || env.CONTRIBUTOR_CONFIG_SHA256 ||
      familySplits.some(split => !submissionBucket(env, split))) throw gone();
  const plan = await pinnedJSON(env.CONTRIBUTOR_DEV_MEDIA, "handwriting-family-staff", pin, 128 * 1024) as Plan | null;
  const invite = plan?.invite;
  if (plan?.schema !== "heocr.handwriting_family_staff.v1" ||
      !digest.test(plan.approval?.allocationAmendmentSha256 ?? "") || !invite || !digest.test(invite.sha256 ?? "") ||
      !Number.isInteger(invite.maxUses) || invite.maxUses < 1 || invite.maxUses > maxWriters ||
      !Number.isFinite(Date.parse(invite.expiresAt)) || typeof plan.calibration !== "string" || !plan.packs ||
      Object.keys(plan.packs).length !== familySplits.length) throw gone();
  const lines = new Set<string>();
  const writers = familySplits.map((split, i) => {
    const tasks = plan.packs[split];
    if (!Array.isArray(tasks) || tasks.length < 8 || tasks.length > 10 || tasks.some((task, j) =>
          task?.kind !== "handwriting" || task.id !== task.page ||
          task.page !== `HW-FS-${letters[split]}${String(j + 1).padStart(2, "0")}`)) throw gone();
    // Each pack holds the calibration line once; no other line may repeat within or across packs.
    let calibration = 0;
    for (const sentence of tasks.flatMap(task => Array.isArray(task.sentences) ? task.sentences : [])) {
      if (sentence === plan.calibration) { calibration++; continue; }
      const line = String(sentence).normalize("NFC").trim().replace(/\s+/gu, " ");
      if (lines.has(line)) throw gone();
      lines.add(line);
    }
    if (calibration !== 1) throw gone();
    return { id: "cw-" + String(i).repeat(32), writerAccount: "rv_" + String(i).repeat(8),
      guardianAccount: null, ageBand: "18_plus" as const, split, tasks };
  });
  const sheetPins = writers.flatMap(writer => writer.tasks.map(task => task.sheetSha256));
  if (new Set(sheetPins).size !== sheetPins.length) throw gone();
  const manifest = await parseContributorManifest({ schema: "heocr.contributor.v1", approval: plan.approval,
    policy: plan.policy, writers });
  return { plan, pin, manifest: { ...manifest, writers: [] as Writer[] } };
}
export type FamilyStaffPlan = NonNullable<Awaited<ReturnType<typeof familyStaffPlan>>>;

/** Slot 1 DEV, 2 TRAIN, 3 DEV; from slot 4, TRAIN when u < 0.7 for u = sha256(prefix + n)'s first 64 bits / 2^64. */
export async function familyStaffSplit(slot: number): Promise<FamilySplit> {
  if (slot <= 3) return slot === 2 ? "train" : "dev";
  const u = BigInt("0x" + (await hash(SLOT_PREFIX + slot)).slice(0, 16));
  return u * 10n < 7n * (1n << 64n) ? "train" : "dev";
}

// ?1 plan pin, ?2 invite pin, ?3 invite use cap, ?4 account. One enrolment per account across every cohort.
const guards = `(SELECT COUNT(*) FROM contributor_family_staff_roster WHERE config_sha256=?1 AND invite_sha256=?2) < ?3
    AND NOT EXISTS (SELECT 1 FROM contributor_handwriting_revoked_invites WHERE config_sha256=?1 AND invite_sha256=?2)
    AND EXISTS (SELECT 1 FROM reviewers WHERE id=?4 AND handwriting_opted_out=0)
    AND NOT EXISTS (SELECT 1 FROM contributor_enrolments WHERE writer_account=?4 OR guardian_account=?4)`;
const nextSlot = "(SELECT COALESCE(MAX(slot),0)+1 FROM contributor_family_staff_roster WHERE config_sha256=?1)";
const unavailable = () => new HttpError(409, "handwriting_slot_unavailable");

/** The invitation is for this cohort. The caller has already enforced the attempt limit. */
async function slotFor(ctx: Ctx, family: FamilyStaffPlan, actor: string, ageBand: unknown) {
  const { invite } = family.plan;
  if (Date.parse(invite.expiresAt) <= ctx.now) throw gone();
  if (ageBand !== "18_plus") throw unavailable();
  const args = [family.pin, invite.sha256, invite.maxUses, actor] as const;
  const row = await ctx.env.DB.prepare(`SELECT ${nextSlot} AS slot, (${guards}) AS open`)
    .bind(...args).first<{ slot: number; open: number }>();
  if (row?.open !== 1) throw unavailable();
  return { args, slot: row.slot, split: await familyStaffSplit(row.slot) };
}

export async function familyStaffOffer(ctx: Ctx, family: FamilyStaffPlan, actor: string, ageBand: unknown): Promise<HandwritingOffer> {
  return { split: (await slotFor(ctx, family, actor, ageBand)).split, sets: [FAMILY_STAFF_SET] };
}

export async function familyStaffSignup(ctx: Ctx, family: FamilyStaffPlan, actor: string, body: Record<string, unknown>) {
  const db = ctx.env.DB;
  const existing = await db.prepare(`SELECT e.writer_id AS writer FROM contributor_enrolments e
    JOIN contributor_family_staff_roster r ON r.writer_id=e.writer_id
    WHERE writer_account=? AND config_sha256=?`).bind(actor, family.pin).first<{ writer: string }>();
  if (existing) return existing.writer;
  const { args, slot, split } = await slotFor(ctx, family, actor, body.ageBand);
  if (body.split !== split || body.set !== FAMILY_STAFF_SET) throw unavailable();
  const writer = randomId("cw-", 16);
  const [assigned] = await db.batch([
    db.prepare(`INSERT INTO contributor_family_staff_roster(config_sha256,invite_sha256,writer_id,slot,split)
      SELECT ?1,?2,?5,?6,?7 WHERE ${guards} AND ?6=${nextSlot}
      ON CONFLICT DO NOTHING`).bind(...args, writer, slot, split),
    db.prepare(`INSERT INTO contributor_enrolments(writer_id,writer_account,age_band,split,receipt)
      SELECT writer_id,?,'18_plus',split,? FROM contributor_family_staff_roster WHERE writer_id=?`)
      .bind(actor, randomId("cw-withdraw-", 16), writer),
  ]);
  if (assigned?.meta.changes !== 1) throw unavailable();
  return writer;
}

/** The signed-in account's family-staff writers, each with its split's pack in the writer's seeded sheet order. */
export async function familyStaffWriters(ctx: Ctx, family: FamilyStaffPlan, actor: string): Promise<Writer[]> {
  const rows = await ctx.env.DB.prepare(`SELECT e.writer_id AS id, e.writer_account AS writerAccount, r.split
    FROM contributor_family_staff_roster r JOIN contributor_enrolments e USING(writer_id)
    WHERE r.config_sha256=? AND writer_account=? ORDER BY r.slot`)
    .bind(family.pin, actor).all<{ id: string; writerAccount: string; split: FamilySplit }>();
  return Promise.all(rows.results.map(async row => ({ ...row, guardianAccount: null, ageBand: "18_plus" as const,
    tasks: await kidsSheetOrder(row.id, family.plan.packs[row.split], FAMILY_STAFF_ORDER_PREFIX) })));
}

