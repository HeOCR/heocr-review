import { ageBands, captureModes, requiredPrintModes, type AgeBand, type CaptureMode, type ConsentCopy, type ContributorSplit, type FormField, type Language } from "../../shared/contributor";
import { hex } from "../crypto";
import type { Env } from "../env";
import { HttpError } from "../http";

export const contributorRoot = "contributor-v1/";
export const ROSTER_OPERATOR_ID = "eval-operator";
export const quarantinePrefix = (writer: string) => `${contributorRoot}quarantine/${writer}/`;
const digest = /^[a-f0-9]{64}$/;
const opaque = /^[A-Za-z0-9_-]{1,64}$/;
const account = /^rv_[a-f0-9]{8}$/;
const v3Page = /^HW-V3-([A-D])0[1-4]$/;
const writerKey = /^cw-[a-f0-9]{32}$/;
type Copy = Record<Language, ConsentCopy>;

type CommonTask = { id: string; page: string };
export type Task = CommonTask & (
  { kind: "print"; mode: CaptureMode; sheetSha256: string; sequence?: true } |
  { kind: "form"; pack: "TRN-FM01"; variant: "worksheet"; sheetSha256: string; referenceSha256: string } |
  { kind: "line"; proposalId: number; proposalSha256: string; cropSha256: string } |
  { kind: "handwriting"; sentences: string[]; promptSha256: string; rights: string; sheetSha256?: string }
);
export type PrintTask = Extract<Task, { kind: "print" }>;
export const optionalPrintTask = (task: Task): task is PrintTask & { sequence: true; mode: "shadow" } =>
  task.kind === "print" && task.sequence === true && task.mode === "shadow";
export type Writer = {
  id: string; writerAccount: string; guardianAccount: string | null;
  ageBand: AgeBand; split: ContributorSplit; tasks: Task[];
};
export type Manifest = {
  schema: "heocr.contributor.v1";
  approval: { evalSplitSha256: string; leadGo: string };
  policy: { version: string; licence: "cc0_open"; guardian: Copy; assent: Copy };
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
    const v3 = v3Page.test(task.page);
    const length = task.sentences?.length;
    return Array.isArray(task.sentences) && (v3
      ? length === 30 && typeof task.sheetSha256 === "string" && digest.test(task.sheetSha256)
      : !task.page.startsWith("HW-V3-") && task.sheetSha256 === undefined && length >= 1 && length <= 10) &&
      task.sentences.every(s => typeof s === "string" && s.trim().length > 0 && s.length <= 220 && !/[\p{Cc}\p{Cf}]/u.test(s)) &&
      digest.test(task.promptSha256) && typeof task.rights === "string" && /^(PD|CC0-1\.0): \S/.test(task.rights) && task.rights.length <= 240;
  }
  if (split !== "train") return false;
  if (task.kind === "print") return captureModes.includes(task.mode) && digest.test(task.sheetSha256) &&
    (task.sequence === undefined || task.sequence === true);
  if (task.kind === "form") return task.pack === "TRN-FM01" && task.variant === "worksheet" &&
    digest.test(task.sheetSha256) && digest.test(task.referenceSha256);
  return task.kind === "line" && Number.isSafeInteger(task.proposalId) && task.proposalId > 0 &&
    digest.test(task.proposalSha256) && digest.test(task.cropSha256);
}

function validPrintSequences(tasks: Task[]) {
  const print = tasks.filter(task => task.kind === "print");
  const pages = new Set(print.filter(task => task.sequence).map(task => task.page));
  for (const page of pages) {
    const slots = print.filter(task => task.page === page);
    const first = slots[0]!;
    const offset = print.indexOf(first);
    const n = requiredPrintModes.length;
    if (slots.length !== n && slots.length !== n + 1) return false;
    if (!slots.every((task, index) => task.sequence && task === print[offset + index] &&
      task.sheetSha256 === first.sheetSha256 && task.mode === (index === n ? "shadow" : requiredPrintModes[index]))) return false;
  }
  return true;
}
export async function parseContributorManifest(data: unknown): Promise<Manifest> {
  const m = data as Manifest | null;
  const policy = m?.policy;
  if (m?.schema !== "heocr.contributor.v1" || !digest.test(m.approval?.evalSplitSha256 ?? "") ||
    !opaque.test(m.approval?.leadGo ?? "") || !policy || typeof policy.version !== "string" || !opaque.test(policy.version) ||
    policy.licence !== "cc0_open" ||
    !isCopy(policy.guardian) || !isCopy(policy.assent) || !Array.isArray(m.writers) ||
    !m.writers.length || m.writers.length > 64) throw gone();
  for (const copy of [policy.guardian, policy.assent]) {
    for (const lang of ["he", "en"] as const) if (await hash(copy[lang].text) !== copy[lang].sha256) throw gone();
  }
  const writers = new Set<string>(), writerAccounts = new Set<string>(), guardians = new Set<string>(), prompts = new Map<string, ContributorSplit>();
  const v3Pages = new Set<string>(), v3Texts = new Set<string>();
  for (const w of m.writers) {
    if (!w || !writerKey.test(w.id) || writers.has(w.id) || !account.test(w.writerAccount) || writerAccounts.has(w.writerAccount) ||
      (w.ageBand === "18_plus" ? w.guardianAccount !== null :
        typeof w.guardianAccount !== "string" || !account.test(w.guardianAccount) || w.guardianAccount === w.writerAccount) ||
      !ageBands.includes(w.ageBand) || !["train", "dev", "eval_open"].includes(w.split) ||
      !Array.isArray(w.tasks) || !w.tasks.length || w.tasks.length > 100 ||
      !w.tasks.every(t => validTask(t, w.split)) || new Set(w.tasks.map(t => t.id)).size !== w.tasks.length ||
      !validPrintSequences(w.tasks)) throw gone();
    writers.add(w.id);
    writerAccounts.add(w.writerAccount);
    if (w.guardianAccount) guardians.add(w.guardianAccount);
    const sheets = w.tasks.filter(task => task.kind === "handwriting" && v3Page.test(task.page));
    if (sheets.length && (sheets.length < 3 || sheets.length > 4 ||
        !sheets.every(task => v3Page.exec(task.page)![1] === v3Page.exec(sheets[0]!.page)![1]))) throw gone();
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
        if (v3Page.test(task.page)) {
          if (v3Pages.has(task.page) || v3Texts.has(task.promptSha256)) throw gone();
          v3Pages.add(task.page);
          v3Texts.add(task.promptSha256);
        }
      }
    }
  }
  if ([...writerAccounts].some(a => guardians.has(a))) throw gone();
  return m;
}

export async function pinnedJSON(bucket: R2Bucket, key: string, pin: string, maxBytes: number): Promise<unknown> {
  const object = await bucket.get(`${contributorRoot}${key}/${pin}.json`);
  if (!object || object.size > maxBytes) throw gone();
  const data = new Uint8Array(await object.arrayBuffer());
  if (await hash(data) !== pin) throw gone();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data));
  } catch {
    throw gone();
  }
}

export async function contributorManifest(env: Env): Promise<Manifest> {
  const pin = env.CONTRIBUTOR_CONFIG_SHA256;
  if (!pin || !digest.test(pin) || !env.TRAIN_CAPTURE_MEDIA) throw gone();
  return parseContributorManifest(await pinnedJSON(env.TRAIN_CAPTURE_MEDIA, "config", pin, 256 * 1024));
}

type FormReference = {
  schema: "heocr.contributor.form_reference.v1";
  page: string;
  worksheetSha256: string;
  fields: FormField[];
};

function fieldText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

export async function formFields(env: Env, task: Extract<Task, { kind: "form" }>): Promise<FormField[]> {
  if (!env.TRAIN_CAPTURE_MEDIA) throw gone();
  const ref = await pinnedJSON(env.TRAIN_CAPTURE_MEDIA, "form-references", task.referenceSha256, 32 * 1024) as FormReference | null;
  if (ref?.schema !== "heocr.contributor.form_reference.v1" || ref.page !== task.page ||
      ref.worksheetSha256 !== task.sheetSha256 || !Array.isArray(ref.fields) || !ref.fields.length || ref.fields.length > 60 ||
      !ref.fields.every(f => f && typeof f.id === "string" && opaque.test(f.id) &&
        fieldText(f.label, 160) && fieldText(f.value, 240)) ||
      new Set(ref.fields.map(f => f.id)).size !== ref.fields.length) throw gone();
  return ref.fields.map(({ id, label, value }) => ({ id, label, value }));
}
