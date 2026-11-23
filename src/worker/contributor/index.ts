import { contributorPhotoType } from "./photo";
import {
  CONTRIBUTOR_API, type AgeBand, type ContributorKind, type ContributorNext, type ContributorProfile,
  type ContributorQueue, type ContributorSplit, type Language, type PrintCapture,
} from "../../shared/contributor";
import { candidateOf } from "../../tasks/line_verify/triage";
import { isPass2, normalizeLineDecision } from "../../tasks/line_verify";
import { readSession } from "../auth/session";
import type { Ctx } from "../api";
import { getBatch, getProposal, getReviewer } from "../db";
import { captureImageType } from "../capture-image";
import { randomId } from "../crypto";
import { assertSameOrigin, HttpError, json, readBytes, readJson } from "../http";
import { enforce, LIMITS } from "../ratelimit";
import {
  canonicalContributorOrigin, contributorManifest, contributorRoot, formFields, gone, hash, invalid, optionalPrintTask, submissionBucket,
  type Manifest, type PrintTask, type Task, type Writer,
} from "./config";

type Enrolment = {
  guardian_version: string | null; guardian_sha256: string | null;
  assent_version: string | null; assent_sha256: string | null;
  receipt: string; withdrawn_at: string | null; purged_at: string | null;
  writer_id: string; writer_account: string; guardian_account: string; age_band: AgeBand; split: ContributorSplit;
};
type Access = { ctx: Ctx; manifest: Manifest; actor: string; writer: Writer; role: "guardian" | "writer"; row: Enrolment | null };
const enrollmentFields = `writer_id, writer_account, guardian_account, age_band, split, receipt,
  guardian_version, guardian_sha256, assent_version, assent_sha256, withdrawn_at, purged_at`;
const current = (a: Access) => a.manifest.policy;
const consentKey = (a: Access) => current(a).version + ":" + current(a).licence;
const referencePin = (task: Task) => task.kind === "form" ? task.referenceSha256 :
  task.kind === "handwriting" ? task.promptSha256 : null;
const maxPhoto = 16 * 1024 * 1024;
const privateHeaders = {
  "cache-control": "private, no-store",
  "cdn-cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const rootFor = (writer: string) => `${contributorRoot}quarantine/${writer}/`;
const now = (c: Ctx) => new Date(c.now).toISOString();
const owner = (row: Enrolment, w: Writer) =>
  row.writer_account === w.writerAccount && row.guardian_account === w.guardianAccount &&
  row.split === w.split && row.age_band === w.ageBand;

export function isContributorAPI(path: string) {
  return path === CONTRIBUTOR_API || path.startsWith(CONTRIBUTOR_API + "/");
}

/** A contributor can sign in and sign out using the shared account shell. Minor accounts cannot use legacy queues or public credit names. */
export async function isContributorWriter(ctx: Ctx, actor: string) {
  const enrolled = await ctx.env.DB.prepare("SELECT 1 FROM contributor_enrolments WHERE writer_account=?")
    .bind(actor).first();
  if (enrolled) return true;
  if (!ctx.env.CONTRIBUTOR_CONFIG_SHA256) return false;
  return (await contributorManifest(ctx.env)).writers.some(w => w.writerAccount === actor);
}

export async function guardContributorLegacy(ctx: Ctx) {
  const path = ctx.url.pathname;
  if (path === "/api/config" || path === "/api/me" || path.startsWith("/api/auth/")) return;
  const actor = await readSession(ctx.env, ctx.request, ctx.now);
  if (actor && await isContributorWriter(ctx, actor)) throw gone();
}

async function session(ctx: Ctx) {
  const actor = await readSession(ctx.env, ctx.request, ctx.now);
  if (!actor) throw new HttpError(401, "sign_in_required");
  const reviewer = await getReviewer(ctx.env.DB, actor);
  if (!reviewer || reviewer.blocked) throw gone();
  return actor;
}
async function access(ctx: Ctx, requested: string | null): Promise<Access> {
  if (ctx.env.CONTRIBUTOR_APP_ENABLED !== "1" || !canonicalContributorOrigin(ctx.env, ctx.url)) throw gone();
  const actor = await session(ctx);
  enforce(ctx.request.method === "GET" ? LIMITS.readMinute : LIMITS.writeMinute, actor, ctx.now);
  const manifest = await contributorManifest(ctx.env);
  const writer = manifest.writers.find(w => w.writerAccount === actor && (!requested || w.id === requested)) ??
    manifest.writers.find(w => w.guardianAccount === actor && w.id === requested);
  if (!writer) throw gone();
  const row = await ctx.env.DB.prepare(`SELECT ${enrollmentFields} FROM contributor_enrolments WHERE writer_id=?`)
    .bind(writer.id).first<Enrolment>();
  if (row && !owner(row, writer)) throw gone();
  return {ctx, manifest, actor, writer, role: writer.writerAccount === actor ? "writer" : "guardian", row};
}
function state(a: Access): ContributorProfile["state"] {
  if (a.row?.withdrawn_at) return "withdrawn";
  const {guardian, assent}=current(a);
  const version=consentKey(a);
  if (a.row?.guardian_version !== version || !Object.values(guardian).some(c=>c.sha256===a.row?.guardian_sha256)) return "guardian";
  if (a.row?.assent_version !== version || !Object.values(assent).some(c=>c.sha256===a.row?.assent_sha256)) return "assent";
  return "ready";
}
function requireReady(a: Access) {
  if (a.role !== "writer" || state(a) !== "ready") throw gone();
  const bucket = submissionBucket(a.ctx.env,a.writer.split);
  if (!bucket) throw gone();
  return bucket;
}
async function completed(a: Access) {
  const rows=await a.ctx.env.DB.prepare("SELECT task_id FROM contributor_submissions WHERE writer_id=?")
    .bind(a.writer.id).all<{task_id:string}>();
  return new Set(rows.results.map(r=>r.task_id));
}
async function line(a: Access, task: Extract<Task,{kind:"line"}>) {
  const db=a.ctx.env.DB;
  const proposal=await getProposal(db,task.proposalId);
  if (!proposal?.active || proposal.contentSha256!==task.proposalSha256 || isPass2(proposal)) throw gone();
  const batch=await getBatch(db,proposal.batchId);
  if (batch?.status!=="open" || batch.taskType!=="line_verify" || batch.source.contributor_scope!=="train" ||
      batch.restrictedReference || !proposal.batchId.startsWith("contributor-train-") || !candidateOf(proposal)) throw gone();
  const eligible=await db.prepare(`SELECT 1 FROM proposals p WHERE p.id=? AND p.gate_kind IS NULL
    AND json_extract(p.payload_json,'$.gold') IS NULL`).bind(task.proposalId).first();
  if (!eligible) throw gone();
  return proposal;
}
const sheetSlots = (a: Access, page: string) => a.writer.tasks.filter((t): t is PrintTask => t.kind === "print" && t.page === page);
const nextRequired = (tasks: Task[], done: Set<string>) => tasks.find(t => !optionalPrintTask(t) && !done.has(t.id));
function printView(a: Access, task: PrintTask, done: Set<string>): PrintCapture {
  return { id: task.id, page: task.page, kind: task.kind, mode: task.mode,
    sheet: `${CONTRIBUTOR_API}/writers/${a.writer.id}/tasks/${task.id}/sheet`,
    ...(task.sequence ? { captureSteps: sheetSlots(a, task.page).map(slot => ({ mode: slot.mode, saved: done.has(slot.id) })) } : {}) };
}
async function nextView(a: Access, task: Task, done: Set<string>): Promise<ContributorNext> {
  const base={id:task.id,page:task.page};
  const path=`${CONTRIBUTOR_API}/writers/${a.writer.id}/tasks/${task.id}`;
  switch(task.kind) {
    case "print": return printView(a, task, done);
    case "form": return {...base,kind:task.kind,sheet:path+"/sheet",
      fields:await formFields(a.ctx.env,task),referenceSha256:task.referenceSha256};
    case "line": return {...base,kind:task.kind,crop:path+"/crop",candidate:candidateOf(await line(a,task))};
    case "handwriting": return {...base,kind:task.kind,prompt:task.sentences.join("\n"),rights:task.rights,referenceSha256:task.promptSha256};
  }
}
async function profile(a: Access): Promise<ContributorProfile> {
  const phase=state(a);
  const queues: ContributorQueue[]=[];
  if (a.role==="writer" && phase==="ready") {
    requireReady(a);
    const done=await completed(a);
    const assigned = new Map<ContributorKind, Task[]>();
    for (const task of a.writer.tasks) {
      const tasks = assigned.get(task.kind);
      if (tasks) tasks.push(task);
      else assigned.set(task.kind, [task]);
    }
    for (const [kind, tasks] of assigned) {
      const required = tasks.filter(t => !optionalPrintTask(t));
      const next = nextRequired(required, done);
      const optionalPrint = tasks.filter(optionalPrintTask).filter(t => !done.has(t.id) && !nextRequired(sheetSlots(a, t.page), done))
        .map(t => printView(a, t, done));
      queues.push({kind,total:required.length,done:required.filter(t=>done.has(t.id)).length,next:next?await nextView(a,next,done):null,
        ...(optionalPrint.length ? { optionalPrint } : {})});
    }
  }
  const policy=current(a);
  return {role:a.role,writer:a.writer.id,ageBand:a.writer.ageBand,state:phase,receipt:a.row?.receipt??null,
    licence:policy.licence, version:policy.version,copy:a.role==="guardian"?policy.guardian:policy.assent,queues};
}

function enrolment(a: Access) {
  const w=a.writer;
  return a.ctx.env.DB.prepare(`INSERT INTO contributor_enrolments
    (writer_id,writer_account,guardian_account,age_band,split,receipt)
    VALUES (?,?,?,?,?,?) ON CONFLICT(writer_id) DO NOTHING`)
    .bind(w.id,w.writerAccount,w.guardianAccount,w.ageBand,w.split,randomId("cw-withdraw-",16));
}
async function consent(a: Access) {
  const body=await readJson(a.ctx.request);
  const lang=body.lang;
  if (body.accept!==true || (lang!=="he" && lang!=="en")) throw invalid();
  const version=consentKey(a);
  const copy=current(a)[a.role==="guardian"?"guardian":"assent"][lang as Language];
  if (body.version!==current(a).version || body.sha256!==copy.sha256) throw new HttpError(409,"consent_changed");
  if (a.role==="guardian") {
    if (state(a)==="withdrawn") throw gone();
    await a.ctx.env.DB.batch([enrolment(a),a.ctx.env.DB.prepare(`
      UPDATE contributor_enrolments SET guardian_version=?, guardian_sha256=?, guardian_at=?
      WHERE writer_id=? AND guardian_account=? AND writer_account=? AND age_band=? AND split=? AND withdrawn_at IS NULL
      AND (guardian_version IS NOT ? OR guardian_sha256 IS NOT ?)`)
      .bind(version,copy.sha256,now(a.ctx),a.writer.id,a.actor,a.writer.writerAccount,a.writer.ageBand,a.writer.split,version,copy.sha256)]);
  } else {
    if (state(a)!=="assent" && state(a)!=="ready") throw gone();
    const guardianSha=a.row!.guardian_sha256;
    await a.ctx.env.DB.prepare(`
      UPDATE contributor_enrolments SET assent_version=?, assent_sha256=?, assent_at=?
      WHERE writer_id=? AND writer_account=? AND guardian_version=? AND guardian_sha256=? AND withdrawn_at IS NULL
      AND (assent_version IS NOT ? OR assent_sha256 IS NOT ?)`)
      .bind(version,copy.sha256,now(a.ctx),a.writer.id,a.actor,version,guardianSha,version,copy.sha256).run();
  }
  return json(await profile(await access(a.ctx,a.writer.id)));
}
async function withdraw(a: Access) {
  const body=await readJson(a.ctx.request);
  if (body.withdraw!==true) throw invalid();
  const role=a.role==="writer"?"writer_account":"guardian_account";
  await a.ctx.env.DB.batch([enrolment(a),a.ctx.env.DB.prepare(`
    UPDATE contributor_enrolments SET withdrawn_at=COALESCE(withdrawn_at,?)
    WHERE writer_id=? AND ${role}=? AND writer_account=? AND guardian_account=? AND age_band=? AND split=? AND withdrawn_at IS NULL`)
    .bind(now(a.ctx),a.writer.id,a.actor,a.writer.writerAccount,a.writer.guardianAccount,a.writer.ageBand,a.writer.split)]);
  return json(await profile(await access(a.ctx,a.writer.id)));
}

async function taskFor(a: Access, id: string) {
  requireReady(a);
  const task=a.writer.tasks.find(t=>t.id===id);
  if (!task) throw gone();
  const done=await completed(a);
  if (!done.has(id)) {
    if (optionalPrintTask(task)) {
      if (nextRequired(sheetSlots(a, task.page), done)) throw gone();
    } else if (nextRequired(a.writer.tasks.filter(t => t.kind === task.kind), done)?.id !== id) throw gone();
  }
  return {task,done:done.has(id)};
}
async function asset(a: Access, task: Task, action: string) {
  const bucket=a.ctx.env.TRAIN_CAPTURE_MEDIA;
  if (!bucket) throw gone();
  const sheet=action==="sheet" && (task.kind==="print"||task.kind==="form");
  const crop=action==="crop" && task.kind==="line";
  if (!sheet && !crop) throw gone();
  if (crop) await line(a,task);
  const pin=task.kind==="line"?task.cropSha256:task.sheetSha256;
  const key=sheet?`${contributorRoot}sheets/${pin}.pdf`:`${contributorRoot}line-crops/${pin}.jpg`;
  const object=await bucket.get(key);
  if (!object || object.size>24*1024*1024) throw gone();
  const data=new Uint8Array(await object.arrayBuffer());
  if (await hash(data)!==pin) throw gone();
  if (sheet && new TextDecoder().decode(data.subarray(0,5))!=="%PDF-") throw gone();
  if (crop && captureImageType(data,false)!=="image/jpeg") throw gone();
  return new Response(data,{headers:{...privateHeaders,"content-type":sheet?"application/pdf":"image/jpeg",
    ...(sheet?{"content-disposition":`attachment; filename="${task.page}.pdf"`}:{})}});
}

/** Accept at most one result per slot. Consent is checked again in the write to close withdrawal/version races. */
async function save(a: Access, task: Task, digest: string, key: string|null, review: string|null) {
  const policy=current(a);
  const w=a.writer;
  const ref=referencePin(task);
  const result=await a.ctx.env.DB.prepare(`
    INSERT INTO contributor_submissions
      (writer_id,task_id,kind,policy_version,policy_licence,guardian_sha256,assent_sha256,reference_sha256,content_sha256,storage_key,review_result_json,uploaded_at)
    SELECT writer_id,?,?,?,?,guardian_sha256,assent_sha256,?,?,?,?,? FROM contributor_enrolments
    WHERE writer_id=? AND writer_account=? AND guardian_account=? AND split=? AND withdrawn_at IS NULL
      AND guardian_version=? AND guardian_sha256=? AND assent_version=? AND assent_sha256=?
    ON CONFLICT DO NOTHING
  `).bind(task.id,task.kind,policy.version,policy.licence,ref,digest,key,review,now(a.ctx),
    w.id,w.writerAccount,w.guardianAccount,w.split,consentKey(a),a.row!.guardian_sha256,consentKey(a),a.row!.assent_sha256).run();
  if (result.meta.changes===1) return true;
  const saved=await a.ctx.env.DB.prepare("SELECT content_sha256,reference_sha256 FROM contributor_submissions WHERE writer_id=? AND task_id=?")
    .bind(w.id,task.id).first<{content_sha256:string; reference_sha256:string|null}>();
  if (saved?.content_sha256===digest && saved.reference_sha256===ref) return false;
  throw new HttpError(409,"contributor_slot_conflict");
}
async function submit(a: Access, task: Task) {
  const bucket=requireReady(a);
  const request=a.ctx.request;
  if (task.kind==="line") {
    const body=await readJson(request);
    const p=await line(a,task);
    if (body.value!=="exact" && body.value!=="edited") throw invalid();
    const result=normalizeLineDecision(candidateOf(p),body.value,body.text);
    if (!result.ok) throw invalid();
    const review=JSON.stringify({proposalId:task.proposalId,proposalSha256:task.proposalSha256,value:result.value,text:result.text});
    await save(a,task,await hash(`${a.writer.id}\n${task.id}\n${review}`),null,review);
  } else {
    if (request.headers.get("x-contributor-privacy")!=="confirmed") throw invalid();
    const ref=referencePin(task);
    if (ref && request.headers.get("x-contributor-reference")!==ref) throw new HttpError(409,"contributor_reference_changed");
    if (task.kind==="form") await formFields(a.ctx.env,task);
    const bytes=await readBytes(request,maxPhoto,"invalid_contributor_image");
    const mime=contributorPhotoType(bytes);
    if (!mime) throw new HttpError(400,"contributor_photo_format");
    const digest=await hash(bytes);
    const key=rootFor(a.writer.id)+randomId("",16);
    await bucket.put(key,bytes,{httpMetadata:{contentType:mime,cacheControl:"private, no-store"},
      ...(task.kind === "print" ? { customMetadata: { captureVariant: task.mode } } : {})});
    try {
      if (!await save(a,task,digest,key,null)) await bucket.delete(key);
    } catch (error) {
      // If D1 committed before a transport error, keep the acknowledged original.
      // If D1 is unavailable, leave the object in quarantine for operator reconciliation.
      const stored=await a.ctx.env.DB.prepare("SELECT storage_key FROM contributor_submissions WHERE writer_id=? AND task_id=?")
        .bind(a.writer.id,task.id).first<{storage_key:string}>();
      if (stored?.storage_key!==key) await bucket.delete(key);
      throw error;
    }
  }
  return json(await profile(await access(a.ctx,a.writer.id)));
}

async function purge(ctx: Ctx, receipt: string) {
  if (!canonicalContributorOrigin(ctx.env,ctx.url)) throw gone();
  const actor=await session(ctx);
  if (!(ctx.env.ADMIN_REVIEWER_IDS??"").split(",").map(id=>id.trim()).includes(actor)) throw gone();
  const row=await ctx.env.DB.prepare(`SELECT ${enrollmentFields} FROM contributor_enrolments WHERE receipt=?`)
    .bind(receipt).first<Enrolment>();
  if (!row) throw gone();
  const bucket=submissionBucket(ctx.env,row.split);
  if (!bucket) throw gone();
  const prefix=rootFor(row.writer_id);
  await ctx.env.DB.prepare("UPDATE contributor_enrolments SET withdrawn_at=? WHERE writer_id=? AND withdrawn_at IS NULL")
    .bind(now(ctx),row.writer_id).run();
  for (;;) {
    const {objects}=await bucket.list({prefix,limit:100});
    if (!objects.length) break;
    await bucket.delete(objects.map(o=>o.key));
  }
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM contributor_submissions WHERE writer_id=?").bind(row.writer_id),
    ctx.env.DB.prepare("UPDATE contributor_enrolments SET purged_at=? WHERE writer_id=? AND purged_at IS NULL").bind(now(ctx),row.writer_id),
  ]);
  return json({purged:true});
}
export async function contributor(ctx: Ctx) {
  const suffix=ctx.url.pathname.slice(CONTRIBUTOR_API.length);
  const method=ctx.request.method;
  if (method!=="GET") assertSameOrigin(ctx.request);
  const deletion=/^\/operator\/withdrawals\/(cw-withdraw-[a-f0-9]{32})$/.exec(suffix);
  if (method==="POST" && deletion) return purge(ctx,deletion[1]!);
  if (suffix==="/enrolments" && method==="GET") {
    if (ctx.env.CONTRIBUTOR_APP_ENABLED!=="1" || !canonicalContributorOrigin(ctx.env,ctx.url)) throw gone();
    const actor=await session(ctx);
    enforce(LIMITS.readMinute,actor,ctx.now);
    const m=await contributorManifest(ctx.env);
    return json({enrolments:m.writers.filter(w=>w.guardianAccount===actor||w.writerAccount===actor)
      .map(w=>({writer:w.id,ageBand:w.ageBand,role:w.writerAccount===actor?"writer":"guardian"}))});
  }
  const route=/^\/writers\/(cw-[a-f0-9]{32})(?:\/(consent|withdraw)|\/tasks\/([A-Za-z0-9_-]{1,64})\/(sheet|crop|submit))?$/.exec(suffix);
  if (!route) throw gone();
  const a=await access(ctx,route[1]!);
  if (method==="GET" && !route[2] && !route[3]) return json(await profile(a));
  if (method==="POST" && route[2]==="consent") return consent(a);
  if (method==="POST" && route[2]==="withdraw") return withdraw(a);
  if (!route[3]) throw gone();
  const {task,done}=await taskFor(a,route[3]);
  if (method==="GET" && !done && ["sheet","crop"].includes(route[4]!)) return asset(a,task,route[4]!);
  if (method==="POST" && route[4]==="submit") return submit(a,task);
  throw gone();
}
