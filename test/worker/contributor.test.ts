import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { captureModes, CONTRIBUTOR_API, requiredPrintModes, type ContributorProfile } from "../../src/shared/contributor";
import { parseContributorManifest, contributorRoot, hash, type Manifest, type PrintTask } from "../../src/worker/contributor/config";
import type { Env } from "../../src/worker/env";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const origin = "http://localhost";
const pageImage = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/R8kAAAAASUVORK5CYII="), c => c.charCodeAt(0));
const sheet = new TextEncoder().encode("%PDF-1.4\n% invented worksheet\n");
const jpg = Uint8Array.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]);
const writerKey = "cw-" + "1".repeat(32);
const secondKey = "cw-" + "2".repeat(32);

async function fixture(label: string, customize?: (manifest: Manifest) => void | Promise<void>) {
  const writer = new Client(), guardian = new Client(), stranger = new Client(), second = new Client();
  const writerAccount = await writer.signIn(label + "-writer");
  const guardianAccount = await guardian.signIn(label + "-guardian");
  const strangerAccount = await stranger.signIn(label + "-stranger");
  const secondAccount = await second.signIn(label + "-second");
  const bucket = env.TRAIN_CAPTURE_MEDIA!;
  const cropSha256 = await hash(jpg);
  const sheetSha256 = await hash(new Uint8Array(sheet));
  const fields = [
    {id:"sample-name",label:"שם לדוגמה",value:"דמות  בדיקה"},
    {id:"sample-email",label:"דוא״ל",value:"form-fixture@example.invalid"},
  ];
  const formReference = JSON.stringify({
    schema:"heocr.contributor.form_reference.v1",page:"P01",worksheetSha256:sheetSha256,fields,
  });
  const referenceSha256 = await hash(formReference);
  const referenceKey = contributorRoot+"form-references/"+referenceSha256+".json";
  await bucket.put(referenceKey,formReference);
  await bucket.put(contributorRoot+"line-crops/"+cropSha256+".jpg",jpg);
  await bucket.put(contributorRoot+"sheets/"+sheetSha256+".pdf",sheet);
  const now="2026-11-22T12:00:00Z";
  const batch="contributor-train-invented";
  const proposalSha256="e".repeat(64);
  const draft="זהו משפט לדוגמה";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO batches(id,task_type,title,source_json,min_reviewers,status,imported_at) VALUES (?,?,?,?,1,'open',?)")
      .bind(batch,"line_verify","fixture","{\"contributor_scope\":\"train\"}",now),
    env.DB.prepare("INSERT INTO items(batch_id,external_id,title,payload_json) VALUES (?,?,?,?)").bind(batch,"page","page","{}"),
    env.DB.prepare(`INSERT INTO proposals(batch_id,item_id,external_id,category,confidence,rank,payload_json,media_json,content_sha256,active)
      VALUES (?,(SELECT id FROM items WHERE batch_id=?),'test-line','draft','plain',0,?,'{}',?,1)`)
      .bind(batch,batch,JSON.stringify({candidate_text:draft,kind:"verify",pass:1}),proposalSha256),
  ]);
  const proposal=await env.DB.prepare("SELECT id FROM proposals WHERE batch_id=?").bind(batch).first<{id:number}>();
  const makeCopy=async (text:string)=>{
    const he="נוסח בדיקה "+text, en="Fixture wording "+text;
    return {he:{text:he,sha256:await hash(he)},en:{text:en,sha256:await hash(en)}};
  };
  const sentences=["זהו משפט שנכתב לדוגמה"];
  const manifest: Manifest={
    schema:"heocr.contributor.v1",approval:{evalSplitSha256:"a".repeat(64),leadGo:"fixture"},
    policy:{version:"fixture-v1",licence:"cc0_open",guardian:await makeCopy("guardian"),assent:await makeCopy("writer")},
    writers:[{id:writerKey,writerAccount,guardianAccount,ageBand:"10_12",split:"train",tasks:[
      ...captureModes.map((mode,i)=>({id:"photo"+i,page:"PAGE-1",kind:"print" as const,mode,sheetSha256})),
      {id:"form",kind:"form",page:"P01",pack:"TRN-FM01",variant:"worksheet",sheetSha256,referenceSha256},
      {id:"line",kind:"line",page:"LINE-1",proposalId:proposal!.id,proposalSha256,cropSha256},
      {id:"hand",kind:"handwriting",page:"HAND-1",sentences,promptSha256:await hash(sentences.join("\n")),rights:"PD: invented fixture"},
    ]},{id:secondKey,writerAccount:secondAccount,guardianAccount,ageBand:"16_17",split:"dev",
      tasks:[{id:"h-dev",kind:"handwriting",page:"D-1",sentences:["עוד משפט לדוגמה"],promptSha256:await hash("עוד משפט לדוגמה"),rights:"PD: invented fixture"}]}],
  };
  await customize?.(manifest);
  const bytes=JSON.stringify(manifest);
  const pin=await hash(bytes);
  await bucket.put(contributorRoot+"config/"+pin+".json",bytes);
  const settings:Env={...env,CONTRIBUTOR_APP_ENABLED:"1",CONTRIBUTOR_CONFIG_SHA256:pin,
    ADMIN_REVIEWER_IDS:strangerAccount,CONTRIBUTOR_DEV_MEDIA:env.HANDWRITING_MEDIA};
  const path=CONTRIBUTOR_API+"/writers/"+manifest.writers[0]!.id;
  const req=(actor:Client|null,path:string,opts:{method?:string;body?:unknown;image?:Uint8Array<ArrayBuffer>;ok?:boolean;reference?:string;env?:Partial<Env>;host?:string;origin?:string}={})=>
    handle(new Request((opts.host??origin)+path,{method:opts.method??(opts.body||opts.image?"POST":"GET"),
      headers:{origin:opts.origin??opts.host??origin,cookie:actor?.cookie??"",
        ...(opts.body?{"content-type":"application/json"}:{}),...(opts.ok?{"x-contributor-privacy":"confirmed"}:{}),
        ...(opts.reference?{"x-contributor-reference":opts.reference}:{})},
      body:opts.image??(opts.body?JSON.stringify(opts.body):undefined)}),{...settings,...opts.env},exec);
  const consent=(role:"guardian"|"assent",override:Record<string,unknown>={})=>req(role==="guardian"?guardian:writer,path+"/consent",
    {body:{version:manifest.policy.version,sha256:manifest.policy[role].en.sha256,lang:"en",accept:true,...override}});
  return {manifest,settings,req,consent,path,writer,guardian,stranger,second,proposal,draft,bucket,fields,referenceSha256,referenceKey};
}

it("gates each queue, assets, legacy review and all writes on assigned guardian and writer consent",async()=>{
  const f=await fixture("consent");
  const read=async()=>await (await f.req(f.writer,f.path)).json<ContributorProfile>();
  expect((await f.req(null,f.path)).status).toBe(401);
  expect((await f.req(f.stranger,f.path)).status).toBe(404);
  expect((await f.req(f.writer,f.path,{env:{CONTRIBUTOR_APP_ENABLED:"0"}})).status).toBe(404);
  expect((await f.req(f.writer,f.path,{env:{ENVIRONMENT:"production"},host:"https://heocr-review.heocr.workers.dev"})).status).toBe(404);
  expect((await f.req(f.writer,f.path,{env:{CONTRIBUTOR_CONFIG_SHA256:"0".repeat(64)}})).status).toBe(404);
  expect((await (await f.req(f.writer,"/api/me")).json())).toMatchObject({contributorWriter:true,displayName:null});
  expect((await f.req(f.writer,"/api/me/display-name",{body:{displayName:"fixture",consent:true}})).status).toBe(404);
  expect((await f.req(f.writer,"/api/batches")).status).toBe(404);
  expect((await f.req(f.stranger,"/api/proposals/"+f.proposal!.id)).status).toBe(404);
  expect(await read()).toMatchObject({state:"guardian",queues:[]});
  expect((await f.req(f.writer,f.path+"/tasks/photo0/sheet")).status).toBe(404);
  expect((await f.consent("assent")).status).toBe(404);
  expect((await f.consent("guardian",{sha256:"2".repeat(64)})).status).toBe(409);
  expect((await f.consent("guardian")).status).toBe(200);
  expect(await read()).toMatchObject({state:"assent",queues:[]});
  expect((await f.consent("assent")).status).toBe(200);
  const ready=await read();
  expect(ready).toMatchObject({state:"ready",ageBand:"10_12",licence:"cc0_open"});
  expect(ready.queues[1]?.next).toMatchObject({fields:f.fields,referenceSha256:f.referenceSha256});
  expect(ready.queues.map(q=>[q.kind,q.total,q.done,q.next?.id])).toEqual([
    ["print",6,0,"photo0"],["form",1,0,"form"],["line",1,0,"line"],["handwriting",1,0,"hand"],
  ]);
  expect((await f.req(f.guardian,f.path+"/tasks/photo0/sheet")).status).toBe(404);
  expect((await f.req(f.writer,f.path+"/tasks/photo1/sheet")).status).toBe(404);
  expect((await f.req(f.writer,CONTRIBUTOR_API+"/writers/"+secondKey)).status).toBe(404);
  const worksheet=await f.req(f.writer,f.path+"/tasks/form/sheet");
  expect(worksheet.status).toBe(200);
  expect(worksheet.headers.get("cache-control")).toBe("private, no-store");
  expect(new Uint8Array(await worksheet.arrayBuffer())).toEqual(sheet);
  expect((await f.req(f.writer,f.path+"/tasks/line/crop")).status).toBe(200);
  expect((await f.req(f.writer,f.path+"/tasks/line/submit",{body:{value:"exact"},origin:"https://example.invalid"})).status).toBe(403);
  const saved=await f.req(f.writer,f.path+"/tasks/line/submit",{body:{value:"edited",text:"משפט מתוקן לדוגמה"}});
  expect(saved.status).toBe(200);
  expect((await saved.json<ContributorProfile>()).queues.find(q=>q.kind==="line")).toMatchObject({done:1,next:null});
  expect(await env.DB.prepare(`SELECT policy_version,policy_licence,guardian_sha256,assent_sha256
    FROM contributor_submissions WHERE writer_id=? AND task_id='line'`).bind(writerKey).first()).toEqual({
    policy_version:f.manifest.policy.version,policy_licence:"cc0_open",
    guardian_sha256:f.manifest.policy.guardian.en.sha256,assent_sha256:f.manifest.policy.assent.en.sha256,
  });
});

it("returns only assigned queues in manifest order and rejects unassigned task URLs", async () => {
  const f = await fixture("allow-list", (manifest) => {
    const first = manifest.writers[0]!;
    first.tasks = [first.tasks.find(task => task.kind === "handwriting")!, first.tasks[0]!];
  });
  expect((await f.req(null, CONTRIBUTOR_API+"/enrolments")).status).toBe(401);
  expect((await f.req(null, f.path+"/tasks/photo0/sheet")).status).toBe(401);
  expect((await f.consent("guardian")).status).toBe(200);
  const ready = await (await f.consent("assent")).json<ContributorProfile>();
  expect(ready.queues.map(q => [q.kind, q.total, q.next?.id])).toEqual([
    ["handwriting", 1, "hand"], ["print", 1, "photo0"],
  ]);
  expect((await f.req(f.writer, f.path+"/tasks/form/sheet")).status).toBe(404);
  expect((await f.req(f.writer, f.path+"/tasks/line/crop")).status).toBe(404);
  expect((await f.req(f.writer, f.path+"/tasks/photo1/submit", {image:pageImage,ok:true})).status).toBe(404);
});

it("uses an ordered TRAIN queue, quarantines unchanged bytes and supports idempotent receipt withdrawal",async()=>{
  const f=await fixture("withdraw");
  expect((await f.consent("guardian")).status).toBe(200);
  expect((await f.consent("assent")).status).toBe(200);
  const route=f.path+"/tasks/photo0/submit";
  expect((await f.req(f.writer,route,{image:pageImage})).status).toBe(400);
  expect((await f.req(f.writer,f.path+"/tasks/photo1/submit",{image:pageImage,ok:true})).status).toBe(404);
  const [a,b]=await Promise.all([f.req(f.writer,route,{image:pageImage,ok:true}),f.req(f.writer,route,{image:pageImage,ok:true})]);
  expect([a.status,b.status]).toEqual([200,200]);
  const profile=await a.json<ContributorProfile>();
  expect(profile.queues[0]).toMatchObject({done:1,next:{id:"photo1",mode:"angle"}});
  const original=(await f.bucket.list({prefix:contributorRoot+"quarantine/"+writerKey+"/"})).objects;
  expect(original).toHaveLength(1);
  expect(new Uint8Array(await (await f.bucket.get(original[0]!.key))!.arrayBuffer())).toEqual(pageImage);
  expect((await f.req(f.writer,f.path+"/tasks/photo1/submit",{image:pageImage,ok:true})).status).toBe(409);
  const receipt=profile.receipt;
  expect(receipt).toMatch(/^cw-withdraw-/);
  const purge=CONTRIBUTOR_API+"/operator/withdrawals/"+receipt;
  expect((await f.req(f.writer,purge,{body:{}})).status).toBe(404);
  const withdrawn=await f.req(f.guardian,f.path+"/withdraw",{body:{withdraw:true}});
  expect(await withdrawn.json()).toMatchObject({state:"withdrawn",queues:[]});
  expect((await f.req(f.writer,route,{image:pageImage,ok:true})).status).toBe(404);
  expect((await f.req(f.stranger,purge,{body:{},env:{CONTRIBUTOR_APP_ENABLED:"0"}})).status).toBe(200);
  expect((await f.req(f.stranger,purge,{body:{}})).status).toBe(200);
  expect((await f.bucket.list({prefix:contributorRoot+"quarantine/"+writerKey+"/"})).objects).toHaveLength(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_submissions").first("n")).toBe(0);
});

function printSequence(page: string, sheetSha256: string, withShadow = true): PrintTask[] {
  const modes = withShadow ? [...requiredPrintModes, "shadow" as const] : requiredPrintModes;
  return modes.map(mode => ({ kind: "print", page, id: `${page}-${mode}`, mode, sequence: true, sheetSha256 }));
}

it("enforces each sheet's required photo order and saves the server-assigned variant on originals", async () => {
  const sequenceWriter = "cw-" + "3".repeat(32);
  const f = await fixture("photo-sequence", manifest => {
    const first = manifest.writers[0]!;
    first.id = sequenceWriter;
    const pin = (first.tasks[0] as PrintTask).sheetSha256;
    first.tasks = [...printSequence("P1", pin), ...printSequence("P2", pin, false)];
  });
  expect((await f.consent("guardian")).status).toBe(200);
  const ready = await (await f.consent("assent")).json<ContributorProfile>();
  const queue = ready.queues[0]!;
  expect(queue).toMatchObject({ total: 10, done: 0, next: { id: "P1-flat", captureSteps: [...requiredPrintModes,"shadow"].map(mode=>({mode,saved:false})) } });
  expect(queue.optionalPrint).toBeUndefined();
  const submit = (id: string, size: number) => {
    const image = jpg.slice();
    image[10] = size;
    return f.req(f.writer, `${f.path}/tasks/${id}/submit`, { image, ok: true });
  };
  expect((await submit("P1-folded", 3)).status).toBe(404);
  expect((await submit("P1-shadow", 6)).status).toBe(404);
  expect((await submit("P2-flat", 7)).status).toBe(404);
  expect((await f.req(f.writer, `${f.path}/tasks/P1-angle/sheet`)).status).toBe(404);
  for (const [index, mode] of requiredPrintModes.entries()) expect((await submit(`P1-${mode}`, index + 1)).status).toBe(200);
  const after = (await (await f.req(f.writer, f.path)).json<ContributorProfile>()).queues[0]!;
  expect(after).toMatchObject({ done: 5, total: 10, next: { id: "P2-flat" }, optionalPrint: [{ id: "P1-shadow" }] });
  expect((await submit("P2-flat", 7)).status).toBe(200);
  expect((await submit("P1-shadow", 6)).status).toBe(200);
  const optionalDone = (await (await f.req(f.writer, f.path)).json<ContributorProfile>()).queues[0]!;
  expect(optionalDone).toMatchObject({ done: 6, total: 10, next: { id: "P2-angle" } });
  expect(optionalDone.optionalPrint).toBeUndefined();

  const rows = await env.DB.prepare("SELECT task_id,storage_key FROM contributor_submissions WHERE writer_id=?").bind(sequenceWriter)
    .all<{task_id:string;storage_key:string}>();
  expect(rows.results).toHaveLength(7);
  for (const row of rows.results) {
    const object = await f.bucket.get(row.storage_key);
    expect(object?.customMetadata).toEqual({ captureVariant: row.task_id.split("-").at(-1) });
  }
});

it("rejects incomplete, reordered or mixed-digest capture sequences and accepts original CC0 prompts", async () => {
  const {manifest} = await fixture("capture-plan");
  const writer = manifest.writers[0]!;
  const pin = (writer.tasks[0] as PrintTask).sheetSha256;
  writer.tasks = printSequence("P1", pin).slice(1);
  await expect(parseContributorManifest(manifest)).rejects.toThrow();
  const slots = printSequence("P1", pin);
  writer.tasks = [slots[1]!, slots[0]!, ...slots.slice(2)];
  await expect(parseContributorManifest(manifest)).rejects.toThrow();
  writer.tasks = printSequence("P1", pin);
  (writer.tasks[4] as PrintTask).sheetSha256 = "b".repeat(64);
  await expect(parseContributorManifest(manifest)).rejects.toThrow();
  writer.tasks = printSequence("P1", pin);
  const hand = manifest.writers[1]!.tasks[0]!;
  if (hand.kind !== "handwriting") throw new Error("missing fixture prompt");
  hand.rights = "CC0-1.0: original invented fixture";
  await expect(parseContributorManifest(manifest)).resolves.toBe(manifest);
});

it("refuses inconsistent splits, same-account guardians, duplicate conditions, ages below ten and other licences",async()=>{
  const f=await fixture("split");
  const m=structuredClone(f.manifest);
  m.writers[1]!.tasks=[m.writers[0]!.tasks[0]!];
  await expect(parseContributorManifest(m)).rejects.toThrow();
  const role=structuredClone(f.manifest);
  role.writers[0]!.guardianAccount=role.writers[1]!.writerAccount;
  await expect(parseContributorManifest(role)).rejects.toThrow();
  const repeated=structuredClone(f.manifest);
  repeated.writers[0]!.tasks.push({...repeated.writers[0]!.tasks[0]!,id:"duplicate"});
  await expect(parseContributorManifest(repeated)).rejects.toThrow();
  const ineligible=structuredClone(f.manifest);
  await expect(parseContributorManifest({...ineligible,writers:[{...ineligible.writers[0],ageBand:"under_10"}]})).rejects.toThrow();
  await expect(parseContributorManifest({...ineligible,writers:[{...ineligible.writers[0],ageBand:"under_13"}]})).rejects.toThrow();
  await expect(parseContributorManifest({...ineligible,policy:{...ineligible.policy,licence:"private_eval_only"}})).rejects.toThrow();
  const splitPrompt=structuredClone(f.manifest);
  splitPrompt.writers[1]!.tasks=[splitPrompt.writers[0]!.tasks.at(-1)!];
  await expect(parseContributorManifest(splitPrompt)).rejects.toThrow();
});

it("routes DEV handwriting only to the DEV bucket and keeps its prompt out of TRAIN",async()=>{
  const f=await fixture("dev-storage");
  const path=CONTRIBUTOR_API+"/writers/"+secondKey;
  const accept=async (client:Client,role:"guardian"|"assent")=>f.req(client,path+"/consent",
    {body:{version:f.manifest.policy.version,sha256:f.manifest.policy[role].en.sha256,lang:"en",accept:true}});
  expect((await accept(f.guardian,"guardian")).status).toBe(200);
  expect((await accept(f.second,"assent")).status).toBe(200);
  const view=await (await f.req(f.second,path)).json<ContributorProfile>();
  expect(view.queues.filter(q=>q.total>0).map(q=>q.kind)).toEqual(["handwriting"]);
  expect((await f.req(f.second,path+"/tasks/photo0/submit",{image:pageImage,ok:true})).status).toBe(404);
  expect((await f.req(f.second,path+"/tasks/h-dev/submit",{image:pageImage,ok:true,env:{CONTRIBUTOR_DEV_MEDIA:undefined}})).status).toBe(404);
  const active=view.queues.find(q=>q.kind==="handwriting")!.next;
  expect(active?.kind).toBe("handwriting");
  const reference=active?.kind==="handwriting"?active.referenceSha256:undefined;
  expect(reference).toBe(await hash("עוד משפט לדוגמה"));
  expect((await f.req(f.second,path+"/tasks/h-dev/submit",{image:pageImage,ok:true})).status).toBe(409);
  expect((await f.req(f.second,path+"/tasks/h-dev/submit",{image:pageImage,ok:true,reference})).status).toBe(200);
  expect(await env.DB.prepare("SELECT reference_sha256 FROM contributor_submissions WHERE writer_id=?").bind(secondKey).first("reference_sha256"))
    .toBe(reference);
  const prefix=contributorRoot+"quarantine/"+secondKey+"/";
  const train=await f.bucket.list({prefix});
  const dev=await f.settings.CONTRIBUTOR_DEV_MEDIA!.list({prefix});
  expect(train.objects).toHaveLength(0);
  expect(dev.objects).toHaveLength(1);
});

it("rejects GPS metadata before quarantine without printing its value",async()=>{
  const f=await fixture("gps");
  expect((await f.consent("guardian")).status).toBe(200);
  expect((await f.consent("assent")).status).toBe(200);
  // GPS IFD tag with a synthetic value. Only the presence of the tag is consulted.
  const exif=[69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,37,136,4,0,1,0,0,0,0,0,0,0,0,0,0,0];
  const image=new Uint8Array([255,216,255,225,0,exif.length+2,...exif,...jpg.subarray(2)]);
  const result=await f.req(f.writer,f.path+"/tasks/photo0/submit",{image,ok:true});
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({error:"contributor_photo_format"});
  expect((await f.bucket.list({prefix:contributorRoot+"quarantine/"+writerKey+"/"})).objects).toHaveLength(0);
});

it("binds the exact fictional field JSON to the form receipt and refuses stale or compromised references",async()=>{
  const f=await fixture("form-reference");
  expect((await f.consent("guardian")).status).toBe(200);
  expect((await f.consent("assent")).status).toBe(200);
  const route=f.path+"/tasks/form/submit";
  const photo={image:pageImage,ok:true};
  const stale=await f.req(f.writer,route,{...photo,reference:"b".repeat(64)});
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({error:"contributor_reference_changed"});
  const saved=await f.req(f.writer,route,{...photo,reference:f.referenceSha256});
  expect(saved.status).toBe(200);
  expect((await saved.json<ContributorProfile>()).queues.find(q=>q.kind==="form")).toMatchObject({done:1,next:null});
  expect(await env.DB.prepare("SELECT reference_sha256 FROM contributor_submissions WHERE writer_id=? AND task_id='form'")
    .bind(writerKey).first("reference_sha256")).toBe(f.referenceSha256);
  const stored=await f.bucket.get(f.referenceKey);
  const raw=await stored!.text();
  expect(await hash(raw)).toBe(f.referenceSha256);
  const decoded=JSON.parse(raw);
  expect(decoded.fields).toEqual(f.fields);
  await f.bucket.put(f.referenceKey,JSON.stringify({...decoded,page:"WRONG-PAGE"}));
  expect((await f.req(f.writer,route,{...photo,reference:f.referenceSha256})).status).toBe(404);

  const invalid=JSON.stringify({...decoded,page:"WRONG-PAGE"});
  const pin=await hash(invalid);
  await f.bucket.put(contributorRoot+"form-references/"+pin+".json",invalid);
  const manifest=structuredClone(f.manifest);
  const updated=manifest.writers[0]!.tasks.find(t=>t.kind==="form")!;
  if (updated.kind==="form") updated.referenceSha256=pin;
  const config=JSON.stringify(manifest);
  const digest=await hash(config);
  await f.bucket.put(contributorRoot+"config/"+digest+".json",config);
  expect((await f.req(f.writer,route,{...photo,reference:pin,env:{CONTRIBUTOR_CONFIG_SHA256:digest}})).status).toBe(404);
});

it("gates v3 worksheet downloads, accepts adult CC0 consent and routes scans into quarantine", async () => {
  const adultKey = "cw-"+"a".repeat(32);
  const exactSheet = new TextEncoder().encode("%PDF-1.4\n% invented v3 sheet\n");
  const f = await fixture("v3-adult", async m => {
    const w = m.writers[0]!;
    w.id = adultKey;
    w.ageBand = "18_plus";
    w.guardianAccount = null;
    w.split = "dev";
    const sheetSha256 = await hash(new Uint8Array(exactSheet));
    w.tasks = await Promise.all([1,2,3].map(async number => {
      const page = `HW-V3-A0${number}`;
      const sentences = Array.from({length:30}, (_, i) => `שורת בדיקה ${number}·${i + 1}`);
      return {id:page,page,kind:"handwriting" as const,sentences,sheetSha256,rights:"PD: invented fixture",
        promptSha256:await hash(sentences.join("\n"))};
    }));
  });
  const pdfKey = contributorRoot+"sheets/"+await hash(new Uint8Array(exactSheet))+".pdf";
  await f.settings.CONTRIBUTOR_DEV_MEDIA!.put(pdfKey,exactSheet);
  expect(await f.bucket.head(pdfKey)).toBeNull();
  const asset = f.path + "/tasks/HW-V3-A01/sheet";
  const before = await (await f.req(f.writer,f.path)).json<ContributorProfile>();
  expect(before).toMatchObject({state:"assent",ageBand:"18_plus",queues:[]});
  expect((await f.req(f.writer,asset)).status).toBe(404);
  expect((await f.consent("guardian")).status).toBe(404);
  const accepted = await f.consent("assent");
  expect(accepted.status).toBe(200);
  const profile = await accepted.json<ContributorProfile>();
  expect(profile).toMatchObject({state:"ready",licence:"cc0_open"});
  const task = profile.queues[0]?.next;
  expect(task).toMatchObject({kind:"handwriting",page:"HW-V3-A01",sheet:asset});
  if (task?.kind !== "handwriting") throw new Error("missing v3 task");
  expect(task.prompt.split("\n")).toHaveLength(30);
  expect((await f.req(f.stranger,asset)).status).toBe(404);
  expect((await f.req(f.writer,f.path+"/tasks/HW-V3-A02/sheet")).status).toBe(404);
  const download = await f.req(f.writer,asset);
  expect(download.headers.get("content-disposition")).toBe('attachment; filename="HW-V3-A01.pdf"');
  expect(download.headers.get("cache-control")).toBe("private, no-store");
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(exactSheet);
  const submit = f.path+"/tasks/HW-V3-A01/submit";
  expect((await f.req(f.writer,submit,{image:pageImage,ok:true,reference:"f".repeat(64)})).status).toBe(409);
  expect((await f.req(f.writer,submit,{image:pageImage,ok:true,reference:task.referenceSha256})).status).toBe(200);
  expect(await env.DB.prepare("SELECT guardian_sha256, assent_sha256, reference_sha256 FROM contributor_submissions WHERE writer_id=?")
    .bind(adultKey).first()).toEqual({guardian_sha256:null,assent_sha256:f.manifest.policy.assent.en.sha256,
      reference_sha256:task.referenceSha256});
  const prefix = contributorRoot+"quarantine/"+adultKey+"/";
  const [{objects:train},{objects:dev}] = await Promise.all([f.bucket.list({prefix}),f.settings.CONTRIBUTOR_DEV_MEDIA!.list({prefix})]);
  expect(train).toHaveLength(0);
  expect(dev).toHaveLength(1);
  expect(await f.settings.CONTRIBUTOR_DEV_MEDIA!.get(dev[0]!.key).then(async object =>
    new Uint8Array(await object!.arrayBuffer()))).toEqual(pageImage);

  const reused = structuredClone(f.manifest);
  reused.writers[1]!.tasks = reused.writers[0]!.tasks;
  await expect(parseContributorManifest(reused)).rejects.toThrow();
  const missingPdf = structuredClone(f.manifest);
  const taskWithoutSheet = missingPdf.writers[0]!.tasks[0]!;
  if (taskWithoutSheet.kind!=="handwriting") throw new Error("missing fixture");
  delete taskWithoutSheet.sheetSha256;
  await expect(parseContributorManifest(missingPdf)).rejects.toThrow();

  expect((await f.req(f.writer,f.path+"/withdraw",{body:{withdraw:true}})).status).toBe(200);
  expect((await f.req(f.writer,f.path+"/tasks/HW-V3-A02/sheet")).status).toBe(404);
});
