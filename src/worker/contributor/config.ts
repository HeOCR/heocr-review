import { captureModes, type AgeBand, type CaptureMode, type ConsentCopy, type ContributorSplit, type Language, type Licence } from "../../shared/contributor";
import { hex } from "../crypto";
import type { Env } from "../env";
import { HttpError } from "../http";

export const contributorRoot = "contributor-v1/";
const digest = /^[a-f0-9]{64}$/;
const opaque = /^[A-Za-z0-9_-]{1,64}$/;
const account = /^rv_[a-f0-9]{8}$/;
const writerKey = /^cw-[a-f0-9]{32}$/;
type Copy = Record<Language, ConsentCopy>;

type CommonTask = { id: string; page: string };
export type Task = CommonTask & (
  { kind: "print"; mode: CaptureMode; sheetSha256: string } |
  { kind: "form"; pack: "TRN-FM01"; variant: "worksheet"; sheetSha256: string; persona: number } |
  { kind: "line"; proposalId: number; proposalSha256: string; cropSha256: string } |
  { kind: "handwriting"; sentences: string[]; promptSha256: string; rights: string }
);
export type Writer = {
  id: string; writerAccount: string; guardianAccount: string;
  ageBand: AgeBand; split: ContributorSplit; tasks: Task[];
};
export type Manifest = {
  schema: "heocr.contributor.v1";
  approval: { evalSplitSha256: string; leadGo: string };
  policy: { version: string; licence: Licence; guardian: Copy; assent: Copy };
  writers: Writer[];
};
export const gone = () => new HttpError(404, "not_found");
export const invalid = () => new HttpError(400, "invalid_contributor_input");

export function canonicalContributorOrigin(env: Env, url: URL) {
  return url.origin === "https://review.heocr.org" ||
    env.ENVIRONMENT === "development" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}
export async function hash(bytes: Uint8Array<ArrayBuffer> | string) {
  return hex(await crypto.subtle.digest("SHA-256", typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes));
}

export function submissionBucket(env: Env, split: ContributorSplit) {
  return split === "train" ? env.TRAIN_CAPTURE_MEDIA :
    split === "dev" ? env.CONTRIBUTOR_DEV_MEDIA : env.CONTRIBUTOR_EVAL_MEDIA;
}
function isCopy(copy: Copy | undefined): copy is Copy {
  return (["he", "en"] as const).every(lang => {
    const v = copy?.[lang];
    return typeof v?.text === "string" && v.text.trim().length > 0 && v.text.length <= 12000 && digest.test(v.sha256);
  });
}
function validTask(task: Task, split: ContributorSplit) {
  if (!task || typeof task.id !== "string" || !opaque.test(task.id) || typeof task.page !== "string" || !opaque.test(task.page)) return false;
  if (task.kind === "handwriting") {
    return Array.isArray(task.sentences) && task.sentences.length >= 1 && task.sentences.length <= 10 &&
      task.sentences.every(s => typeof s === "string" && s.trim().length > 0 && s.length <= 220 && !/[\p{Cc}\p{Cf}]/u.test(s)) &&
      digest.test(task.promptSha256) && typeof task.rights === "string" && task.rights.startsWith("PD: ") && task.rights.length <= 240;
  }
  if (split !== "train") return false;
  if (task.kind === "print") return captureModes.includes(task.mode) && digest.test(task.sheetSha256);
  if (task.kind === "form") return task.pack === "TRN-FM01" && task.variant === "worksheet" &&
    digest.test(task.sheetSha256) && Number.isInteger(task.persona) && task.persona >= 1 && task.persona <= 99;
  return task.kind === "line" && Number.isSafeInteger(task.proposalId) && task.proposalId > 0 &&
    digest.test(task.proposalSha256) && digest.test(task.cropSha256);
}
export async function parseContributorManifest(data: unknown): Promise<Manifest> {
  const m = data as Manifest | null;
  const policy = m?.policy;
  if (m?.schema !== "heocr.contributor.v1" || !digest.test(m.approval?.evalSplitSha256 ?? "") ||
    !opaque.test(m.approval?.leadGo ?? "") || !policy || typeof policy.version !== "string" || !opaque.test(policy.version) ||
    !["cc0_open", "private_eval_only"].includes(policy.licence) ||
    !isCopy(policy.guardian) || !isCopy(policy.assent) || !Array.isArray(m.writers) ||
    !m.writers.length || m.writers.length > 64) throw gone();
  for (const copy of [policy.guardian, policy.assent]) {
    for (const lang of ["he", "en"] as const) if (await hash(copy[lang].text) !== copy[lang].sha256) throw gone();
  }
  const writers = new Set<string>(), writerAccounts = new Set<string>(), guardians = new Set<string>(), prompts = new Map<string, ContributorSplit>();
  for (const w of m.writers) {
    if (!w || !writerKey.test(w.id) || writers.has(w.id) || !account.test(w.writerAccount) || writerAccounts.has(w.writerAccount) ||
      !account.test(w.guardianAccount) || w.guardianAccount === w.writerAccount ||
      !["under_13", "13_15", "16_17"].includes(w.ageBand) || !["train", "dev", "eval_open"].includes(w.split) ||
      policy.licence === "private_eval_only" && w.split !== "eval_open" ||
      !Array.isArray(w.tasks) || !w.tasks.length || w.tasks.length > 100 ||
      !w.tasks.every(t => validTask(t, w.split)) || new Set(w.tasks.map(t => t.id)).size !== w.tasks.length) throw gone();
    writers.add(w.id);
    writerAccounts.add(w.writerAccount);
    guardians.add(w.guardianAccount);
    const slots = new Set<string>();
    for (const task of w.tasks) {
      const slot = task.kind === "print" ? `print/${task.page}/${task.mode}` :
        task.kind === "line" ? `line/${task.proposalId}` : `${task.kind}/${task.page}`;
      if (slots.has(slot)) throw gone();
      slots.add(slot);
      if (task.kind === "handwriting") {
        const old = prompts.get(task.promptSha256);
        if (old && old !== w.split || await hash(task.sentences.join("\n")) !== task.promptSha256) throw gone();
        prompts.set(task.promptSha256, w.split);
      }
    }
  }
  if ([...writerAccounts].some(a => guardians.has(a))) throw gone();
  return m;
}

export async function contributorManifest(env: Env): Promise<Manifest> {
  const pin = env.CONTRIBUTOR_CONFIG_SHA256;
  if (!pin || !digest.test(pin) || !env.TRAIN_CAPTURE_MEDIA) throw gone();
  const object = await env.TRAIN_CAPTURE_MEDIA.get(`${contributorRoot}config/${pin}.json`);
  if (!object || object.size > 256 * 1024) throw gone();
  const data = new Uint8Array(await object.arrayBuffer());
  if (await hash(data) !== pin) throw gone();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data)); } catch { throw gone(); }
  return parseContributorManifest(value);
}
