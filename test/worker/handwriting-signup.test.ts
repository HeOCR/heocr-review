import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { CONTRIBUTOR_API, handwritingSets, type ContributorProfile, type HandwritingSignup } from "../../src/shared/contributor";
import { createSessionCookie } from "../../src/worker/auth/session";
import { contributorRoot, hash } from "../../src/worker/contributor/config";
import type { Env } from "../../src/worker/env";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

const execution = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const path = CONTRIBUTOR_API;
const roster = path + "/operator/handwriting-roster";
const invitation = (i: number) => String(i).repeat(32);
const origin = "http://localhost";
const photo = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/R8kAAAAASUVORK5CYII="), c => c.charCodeAt(0));

type FixtureOptions = {
  writerLimit?: number;
  capacity?: {split: "train" | "dev" | "eval_open"; max: number}[];
  cohort?: {maxUses:number;expiresAt:string};
};
const cohortCode = invitation(8);
async function fixture(options: FixtureOptions = {}) {
  const writer = new Client(), guardian = new Client(), other = new Client(), evaluator = new Client(), stranger = new Client();
  const fourth = new Client();
  await fourth.signIn("signup-fourth");
  await writer.signIn("signup-writer");
  await guardian.signIn("signup-guardian");
  await other.signIn("signup-other");
  await stranger.signIn("signup-stranger");
  const evaluationAccount = await evaluator.signIn("signup-eval");
  const copy = async (purpose: string) => {
    const he = "נוסח בדיקה " + purpose;
    const en = "Invented test terms " + purpose;
    return {he:{text:he,sha256:await hash(he)},en:{text:en,sha256:await hash(en)}};
  };
  const policy = { version: "fixture", licence:"cc0_open", guardian:await copy("guardian"), assent:await copy("assent") };
  const sheets = Object.fromEntries(await Promise.all(handwritingSets.map(async set => {
    return [set,await Promise.all(Array.from({length:4},async (_, index) => {
      const page = `HW-V3-${set}0${index+1}`;
      const sentences = Array.from({length:30},(_, i) => `שורת בדיקה ${page} ${i+1}`);
      const pdf = "%PDF-1.4\n% invented fixture " + page;
      const sheetSha256 = await hash(pdf);
      const mediaKey = contributorRoot+"sheets/"+sheetSha256+".pdf";
      await Promise.all([env.TRAIN_CAPTURE_MEDIA!.put(mediaKey,pdf),env.HANDWRITING_MEDIA!.put(mediaKey,pdf),env.HANDWRITING_CONTROL!.put(mediaKey,pdf)]);
      return {kind:"handwriting",id:page,page,sentences,rights:"CC0-1.0: invented fixture",sheetSha256,promptSha256:await hash(sentences.join("\n"))};
    }))];
  })));
  const plan = { schema:"heocr.handwriting_signup.v1", approval:{evalSplitSha256:"1".repeat(64),leadGo:"fixture"},
    policy, sheets, writerLimit:options.writerLimit??4, invites:await Promise.all([1,2,3,4].map(i=>hash(invitation(i)))),
    capacity:options.capacity??[{split:"train",max:2},{split:"dev",max:1},{split:"eval_open",max:1}],
    ...(options.cohort ? {cohort:{sha256:await hash(cohortCode),...options.cohort}} : {}) };
  const pin = await hash(JSON.stringify(plan));
  await env.TRAIN_CAPTURE_MEDIA!.put(contributorRoot+"handwriting-signup/"+pin+".json",JSON.stringify(plan));
  const req = (client: Client | null, route: string, body?: object | Uint8Array<ArrayBuffer>,
    overrides: Partial<Env> = {}, host = origin, headers?: HeadersInit) =>
    handle(new Request(host+route,{
      method:body ? "POST" : "GET",
      headers:{cookie:client?.cookie??"",origin:host,"content-type":"application/json",...headers},
      body:body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
    }),{...env,CONTRIBUTOR_APP_ENABLED:"1",CONTRIBUTOR_HANDWRITING_CONFIG_SHA256:pin,CONTRIBUTOR_ROSTER_REVIEWER_ID:evaluationAccount,
      CONTRIBUTOR_DEV_MEDIA:env.HANDWRITING_MEDIA,CONTRIBUTOR_EVAL_MEDIA:env.HANDWRITING_CONTROL,
      ADMIN_REVIEWER_IDS:evaluationAccount,...overrides},execution);
  const copyBody = (role: "guardian"|"assent") =>
    ({version:policy.version,accept:true,lang:"en",sha256:policy[role].en.sha256});
  return {writer,guardian,evaluator,other,stranger,fourth,req,copyBody};
}

it("allows the owner an upload after guardian consent and assent before the first daily audit",async()=>{
  const f=await fixture();
  const join={inviteCode:invitation(1),ageBand:"13_17",set:"A"};
  expect((await f.req(null,path+"/enrolments",join)).status).toBe(401);
  expect((await f.req(f.writer,path+"/enrolments",join,{CONTRIBUTOR_APP_ENABLED:"0"})).status).toBe(404);
  expect((await f.req(f.writer,path+"/enrolments",join,{ENVIRONMENT:"production"},"https://heocr-review.heocr.workers.dev")).status).toBe(404);
  expect((await f.req(f.writer,path+"/enrolments",{...join,inviteCode:invitation(9)})).status).toBe(404);
  const response=await f.req(f.writer,path+"/enrolments",join);
  expect(response.status).toBe(200);
  const profile=await response.json<ContributorProfile>();
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(profile).toMatchObject({role:"writer",ageBand:"13_17",state:"guardian",queues:[]});
  expect(profile.writer).toMatch(/^cw-[a-f0-9]{32}$/);
  expect(profile.guardianPairingCode).toBeTruthy();
  const writerPath=path+"/writers/"+profile.writer;
  const task=writerPath+"/tasks/HW-V3-A01";
  expect((await f.req(f.stranger,writerPath)).status).toBe(404);
  expect((await f.req(f.writer,"/api/batches")).status).toBe(404);
  expect((await f.req(f.writer,task+"/sheet")).status).toBe(404);
  expect((await f.req(f.writer,task+"/submit",photo)).status).toBe(404);
  expect((await f.req(f.writer,writerPath+"/consent",f.copyBody("assent"))).status).toBe(404);
  expect((await f.req(f.other,path+"/enrolments",{...join,ageBand:"18_plus",set:"B"})).status).toBe(409);

  const guardianBody={...f.copyBody("guardian"),code:profile.guardianPairingCode};
  expect((await f.req(f.guardian,path+"/guardian",{...guardianBody,sha256:"0".repeat(64)})).status).toBe(409);
  expect((await f.req(f.guardian,path+"/guardian",{...guardianBody,code:"not-a-code"})).status).toBe(400);
  expect((await f.req(f.writer,path+"/guardian",guardianBody)).status).toBe(404);
  const paired=await f.req(f.guardian,path+"/guardian",guardianBody);
  expect(paired.status).toBe(200);
  expect(await paired.json()).toMatchObject({role:"guardian",state:"assent",queues:[]});
  expect((await f.req(f.other,path+"/guardian",guardianBody)).status).toBe(404);
  expect((await f.req(f.guardian,task+"/sheet")).status).toBe(404);
  expect((await f.req(f.stranger,roster)).status).toBe(404);
  const pin=await (await f.req(f.evaluator,roster)).json<{sha256:string;canonical:string;throughOrdinal:number;previousSha256:null}>();
  expect(await hash(pin.canonical)).toBe(pin.sha256);
  expect(JSON.parse(pin.canonical).rows).toEqual([{ordinal:pin.throughOrdinal,writer:profile.writer,ageBand:"13_17",set:"A",split:"train"}]);
  const {canonical, ...acceptPin}=pin;
  expect(canonical).not.toContain("rv_");
  expect((await f.req(f.stranger,roster,acceptPin)).status).toBe(404);
  expect((await f.req(f.evaluator,roster,{...acceptPin,sha256:"2".repeat(64)})).status).toBe(409);
  const assent=await f.req(f.writer,writerPath+"/consent",f.copyBody("assent"));
  const ready=await assent.json<ContributorProfile>();
  expect(ready).toMatchObject({state:"ready",queues:[{kind:"handwriting",total:4,done:0}]});
  expect(new TextDecoder().decode(await (await f.req(f.writer,task+"/sheet")).arrayBuffer())).toBe("%PDF-1.4\n% invented fixture HW-V3-A01");
  const photoHeaders=uploadHeaders(ready);
  expect((await f.req(f.guardian,task+"/submit",photo,{},origin,photoHeaders)).status).toBe(404);
  expect((await f.req(f.stranger,task+"/submit",photo,{},origin,photoHeaders)).status).toBe(404);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_pins").first<{n:number}>())?.n).toBe(0);
  expect((await f.req(f.writer,task+"/submit",photo,{},origin,photoHeaders)).status).toBe(200);
  expect((await f.req(f.evaluator,roster,acceptPin)).status).toBe(200);
  expect((await f.req(f.evaluator,roster,acceptPin)).status).toBe(409);
  expect((await f.req(f.guardian,writerPath+"/withdraw",{withdraw:true})).status).toBe(200);
  expect((await f.req(f.writer,task+"/submit",photo,{},"http://localhost",photoHeaders)).status).toBe(404);
  expect((await (await f.req(f.evaluator,roster)).json<{sha256:string}>()).sha256).toBe(pin.sha256);
});

it("assigns the least-filled available split, never reassigns a set and chains pins",async()=>{
  const f=await fixture();
  const join=(who:Client,i:number,set:string)=>f.req(who,path+"/enrolments",{inviteCode:invitation(i),ageBand:"18_plus",set});
  expect((await join(f.writer,1,"D")).status).toBe(200);
  const previous=await (await f.req(f.evaluator,roster)).json<{sha256:string;throughOrdinal:number;previousSha256:null}>();
  expect((await join(f.other,2,"D")).status).toBe(409);
  const other=await (await join(f.other,2,"A")).json<ContributorProfile>();
  expect(other.state).toBe("assent");
  expect((await f.req(f.evaluator,roster,previous)).status).toBe(200);
  expect((await join(f.stranger,3,"C")).status).toBe(200);
  expect((await join(f.fourth,4,"B")).status).toBe(200);
  const next=await (await f.req(f.evaluator,roster)).json<{canonical:string;sha256:string;throughOrdinal:number;previousSha256:string}>();
  expect(next.previousSha256).toBe(previous.sha256);
  expect(JSON.parse(next.canonical).rows.map((row:{set:string;split:string})=>[row.set,row.split])).toEqual([
    ["D","train"],["A","dev"],["C","eval_open"],["B","train"],
  ]);
  const otherPath=path+"/writers/"+other.writer;
  expect(await (await f.req(f.other,otherPath+"/consent",f.copyBody("assent"))).json())
    .toMatchObject({state:"ready"});
  expect((await f.req(f.evaluator,roster,{...next,previousSha256:null})).status).toBe(409);
  expect((await f.req(f.evaluator,roster,next)).status).toBe(200);
  expect((await f.req(f.other,otherPath+"/tasks/HW-V3-A01/sheet",undefined,{CONTRIBUTOR_DEV_MEDIA:undefined})).status).toBe(404);
  expect((await f.req(f.other,otherPath+"/tasks/HW-V3-A01/sheet")).status).toBe(200);
  expect((await f.req(f.other,otherPath+"/tasks/HW-V3-C01/sheet")).status).toBe(404);
  expect((await join(f.guardian,4,"B")).status).toBe(409);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster").first<{n:number}>())?.n).toBe(4);
});


function uploadHeaders(profile: ContributorProfile) {
  const task=profile.queues[0]?.next;
  if (task?.kind!=="handwriting") throw Error("missing fixture task");
  return {"x-contributor-reference":task.referenceSha256,"x-contributor-privacy":"confirmed"};
}

async function readyAdult(f: Awaited<ReturnType<typeof fixture>>) {
  const joined=await (await f.req(f.writer,path+"/enrolments",{
    inviteCode:invitation(1),ageBand:"18_plus",set:"A",
  })).json<ContributorProfile>();
  const writerPath=path+"/writers/"+joined.writer;
  expect((await f.req(f.writer,writerPath+"/tasks/HW-V3-A01/submit",photo)).status).toBe(404);
  const ready=await (await f.req(f.writer,writerPath+"/consent",f.copyBody("assent"))).json<ContributorProfile>();
  expect(ready.state).toBe("ready");
  return {writerPath,task:writerPath+"/tasks/HW-V3-A01/submit",writer:ready.writer,headers:uploadHeaders(ready)};
}

function afterPut(bucket: R2Bucket, action: () => Promise<void>) {
  return new Proxy(bucket,{
    get(target,property) {
      if (property==="put") return async (...args: Parameters<R2Bucket["put"]>) => {
        const result=await target.put(...args);
        await action();
        return result;
      };
      const value=Reflect.get(target,property);
      return typeof value==="function" ? value.bind(target) : value;
    },
  });
}

it.each(["withdrawal","roster mismatch"] as const)("rechecks %s after R2 put and before the D1 write",async change=>{
  const f=await fixture();
  const ready=await readyAdult(f);
  const bucket=env.TRAIN_CAPTURE_MEDIA!;
  const hooked=afterPut(bucket,async()=>{
    if (change==="withdrawal") {
      expect((await f.req(f.writer,ready.writerPath+"/withdraw",{withdraw:true})).status).toBe(200);
    } else {
      // Change the authoritative set after initial access and before the guarded write.
      await env.DB.prepare("UPDATE contributor_handwriting_roster SET set_id='B' WHERE writer_id=?").bind(ready.writer).run();
    }
  });
  expect((await f.req(f.writer,ready.task,photo,{TRAIN_CAPTURE_MEDIA:hooked},origin,ready.headers)).status).toBe(409);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_submissions").first<{n:number}>())?.n).toBe(0);
  expect((await bucket.list({prefix:contributorRoot+"quarantine/"+ready.writer+"/"})).objects).toHaveLength(0);
});

it("withdraws a writer, deletes unpublished files and preserves a previously published original",async()=>{
  const f=await fixture({cohort:{maxUses:4,expiresAt:"2099-01-01T00:00:00Z"}});
  const ready=await readyAdult(f);
  const bucket=env.TRAIN_CAPTURE_MEDIA!;
  const prefix=contributorRoot+"quarantine/"+ready.writer+"/";
  const first=await (await f.req(f.writer,ready.task,photo,{},origin,ready.headers)).json<ContributorProfile>();
  const secondPhoto=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNkYPjPwMDAxAAGAAsfAQMU4wsAAAAAAElFTkSuQmCC"), c => c.charCodeAt(0));
  const second=ready.writerPath+"/tasks/HW-V3-A02/submit";
  expect((await f.req(f.writer,second,secondPhoto,{},origin,uploadHeaders(first))).status).toBe(200);
  const published=await env.DB.prepare("SELECT storage_key FROM contributor_submissions WHERE writer_id=? AND task_id='HW-V3-A01'")
    .bind(ready.writer).first<string>("storage_key");
  const unpublished=await env.DB.prepare("SELECT storage_key FROM contributor_submissions WHERE writer_id=? AND task_id='HW-V3-A02'")
    .bind(ready.writer).first<string>("storage_key");
  expect(published).toBeTruthy();
  expect(unpublished).toBeTruthy();
  const before=await (await f.req(f.evaluator,roster)).json<{sha256:string}>();
  const publicationRoute=path+"/operator/handwriting-publications";
  const firstPin={contentSha256:await hash(photo),releaseSha256:"3".repeat(64)};
  expect((await f.req(f.stranger,publicationRoute,firstPin)).status).toBe(404);
  expect((await f.req(f.evaluator,publicationRoute,firstPin,{},"https://heocr-review.heocr.workers.dev")).status).toBe(404);
  expect((await f.req(f.evaluator,publicationRoute,firstPin)).status).toBe(200);
  expect((await f.req(f.evaluator,publicationRoute,{...firstPin,releaseSha256:"4".repeat(64)})).status).toBe(409);
  await bucket.put(prefix+"orphan","private fixture");
  const stopped=await f.req(f.writer,ready.writerPath+"/withdraw",{withdraw:true});
  expect(stopped.status).toBe(200);
  expect(await stopped.json()).toMatchObject({state:"withdrawn",receipt:first.receipt,queues:[]});
  expect(await env.DB.prepare("SELECT 1 FROM contributor_enrolments WHERE writer_id=?").bind(ready.writer).first()).toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM contributor_submissions WHERE writer_id=?").bind(ready.writer).first()).toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM contributor_handwriting_release_candidates WHERE writer_id=?").bind(ready.writer).first()).toBeNull();
  expect((await (await f.req(f.evaluator,roster)).json<{sha256:string}>()).sha256).toBe(before.sha256);
  expect((await f.req(f.writer,ready.writerPath+"/consent",f.copyBody("assent"))).status).toBe(404);
  expect((await f.req(f.writer,"/api/batches")).status).toBe(404);
  const rejoin={inviteCode:cohortCode,ageBand:"18_plus",set:"B"};
  expect((await f.req(f.writer,path+"/enrolments",rejoin)).status).toBe(409);
  expect((await f.req(f.other,path+"/enrolments",rejoin)).status).toBe(200);
  expect(await bucket.get(unpublished!)).toBeNull();
  expect(await bucket.get(prefix+"orphan")).toBeNull();
  expect(await hash(new Uint8Array(await (await bucket.get(published!))!.arrayBuffer()))).toBe(firstPin.contentSha256);
  expect((await f.req(f.evaluator,publicationRoute,firstPin)).status).toBe(200);
  expect((await f.req(f.evaluator,publicationRoute,{...firstPin,contentSha256:await hash(secondPhoto)})).status).toBe(409);
  await bucket.put(prefix+"late-orphan","late private fixture");
  const purge=path+"/operator/withdrawals/"+first.receipt;
  expect((await f.req(f.evaluator,purge,{}, {CONTRIBUTOR_APP_ENABLED:"0"})).status).toBe(200);
  expect((await bucket.list({prefix})).objects.map(object=>object.key)).toEqual([published]);
});

it("excludes unpublished material immediately and retries a failed R2 purge by receipt",async()=>{
  const f=await fixture();
  const ready=await readyAdult(f);
  const saved=await (await f.req(f.writer,ready.task,photo,{},origin,ready.headers)).json<ContributorProfile>();
  const bucket=env.TRAIN_CAPTURE_MEDIA!;
  const broken=new Proxy(bucket,{
    get(target,property) {
      if (property==="delete") return async()=>{throw Error("R2 unavailable");};
      const value=Reflect.get(target,property);
      return typeof value==="function" ? value.bind(target) : value;
    },
  });
  const purge=path+"/operator/withdrawals/"+saved.receipt;
  const failed=await f.req(f.evaluator,purge,{}, {TRAIN_CAPTURE_MEDIA:broken});
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({error:"contributor_withdrawal_pending"});
  expect((await f.req(f.writer,ready.task,photo,{},origin,ready.headers)).status).toBe(404);
  expect(await env.DB.prepare("SELECT 1 FROM contributor_handwriting_release_candidates").first()).toBeNull();
  expect((await f.req(f.evaluator,path+"/operator/handwriting-publications",{
    contentSha256:await hash(photo),releaseSha256:"3".repeat(64),
  })).status).toBe(409);
  expect((await f.req(f.evaluator,purge,{})).status).toBe(200);
  expect(await env.DB.prepare("SELECT 1 FROM contributor_enrolments").first()).toBeNull();
  expect((await bucket.list({prefix:contributorRoot+"quarantine/"+ready.writer+"/"})).objects).toHaveLength(0);
});

it("commits only one upload and keeps one private object for simultaneous retries",async()=>{
  const f=await fixture();
  const ready=await readyAdult(f);
  const send=()=>f.req(f.writer,ready.task,photo,{},origin,ready.headers);
  expect((await Promise.all([send(),send()])).map(response=>response.status)).toEqual([200,200]);
  const rows=await env.DB.prepare("SELECT writer_id,task_id,storage_key FROM contributor_submissions").all<{
    writer_id:string;task_id:string;storage_key:string;
  }>();
  expect(rows.results).toMatchObject([{writer_id:ready.writer,task_id:"HW-V3-A01"}]);
  const objects=await env.TRAIN_CAPTURE_MEDIA!.list({prefix:contributorRoot+"quarantine/"+ready.writer+"/"});
  expect(objects.objects.map(object=>object.key)).toEqual([rows.results[0]!.storage_key]);
});

it("rate-limits a burst of invalid enrolment attempts without onboarding the account",async()=>{
  const f=await fixture();
  for (let i=0;i<8;i++) {
    expect((await f.req(f.writer,path+"/enrolments",{inviteCode:invitation(9),ageBand:"18_plus",set:"A"})).status).toBe(404);
  }
  const limited=await f.req(f.writer,path+"/enrolments",{inviteCode:invitation(1),ageBand:"18_plus",set:"A"});
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster").first<{n:number}>())?.n).toBe(0);
});

it.each(["dev","eval_open"] as const)("stores the original only in the assigned %s bucket",async split=>{
  const f=await fixture();
  const join=(actor:Client,i:number,set:string)=>f.req(actor,path+"/enrolments",{
    inviteCode:invitation(i),ageBand:"18_plus",set,
  });
  expect((await join(f.writer,1,"D")).status).toBe(200);
  if (split==="eval_open") expect((await join(f.other,2,"B")).status).toBe(200);
  const joined=await (await join(f.stranger,split==="dev"?2:3,"A")).json<ContributorProfile>();
  const writerPath=path+"/writers/"+joined.writer;
  const ready=await (await f.req(f.stranger,writerPath+"/consent",f.copyBody("assent"))).json<ContributorProfile>();
  const prefix=contributorRoot+"quarantine/"+ready.writer+"/";
  const saved=await f.req(f.stranger,writerPath+"/tasks/HW-V3-A01/submit",photo,{},origin,uploadHeaders(ready));
  expect(saved.status).toBe(200);
  const buckets={train:env.TRAIN_CAPTURE_MEDIA!,dev:env.HANDWRITING_MEDIA!,eval_open:env.HANDWRITING_CONTROL!};
  for (const [name,bucket] of Object.entries(buckets)) {
    const {objects}=await bucket.list({prefix});
    expect(objects).toHaveLength(name===split?1:0);
    if (name===split) {
      const object=await bucket.get(objects[0]!.key);
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(photo);
    }
  }
});

it("keeps least-used-set eligibility atomic when writers sign up concurrently",async()=>{
  const f=await fixture();
  const replies=await Promise.all([f.writer,f.other].map((actor,index)=>f.req(actor,path+"/enrolments",{
    inviteCode:invitation(index+1),ageBand:"18_plus",set:"A",
  })));
  expect(replies.map(reply=>reply.status).sort()).toEqual([200,409]);
  const totals=await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM contributor_enrolments) AS enrolled,
    (SELECT COUNT(*) FROM contributor_handwriting_roster) AS roster`).first();
  expect(totals).toEqual({enrolled:1,roster:1});
  const losingIndex=replies.findIndex(reply=>reply.status===409);
  expect((await f.req([f.writer,f.other][losingIndex]!,path+"/enrolments",{
    inviteCode:invitation(losingIndex+1),ageBand:"18_plus",set:"B",
  })).status).toBe(200);
});

const enrolmentRoute = path+"/enrolments";
const revokeRoute = path+"/operator/handwriting-invites/revoke";
const liveCohort = {maxUses:50,expiresAt:"2099-01-01T00:00:00Z"};
const usingCohort = (set: string) => ({inviteCode:cohortCode,ageBand:"18_plus",set});

it("allows the same cohort code for multiple writers, atomically enforces its own use cap and keeps individual codes",async()=>{
  const f=await fixture({cohort:{...liveCohort,maxUses:2}});
  expect((await f.req(f.writer,enrolmentRoute,usingCohort("A"))).status).toBe(200);
  expect((await (await f.req(f.other,enrolmentRoute)).json<{signup:HandwritingSignup}>()).signup.sets).toEqual(["B","C","D"]);
  const replies=await Promise.all([
    f.req(f.other,enrolmentRoute,usingCohort("B")),f.req(f.stranger,enrolmentRoute,usingCohort("C")),
  ]);
  expect(replies.map(x=>x.status).sort()).toEqual([200,409]);
  const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster WHERE invite_sha256=?")
    .bind(await hash(cohortCode)).first<{n:number}>();
  expect(count?.n).toBe(2);
  const actor=replies[0]!.ok?f.stranger:f.other;
  const set=replies[0]!.ok?"C":"B";
  expect((await f.req(actor,enrolmentRoute,{...usingCohort(set),inviteCode:invitation(1)})).status).toBe(200);
});

it("refuses expired cohort codes and keeps an available one-use enrolment",async()=>{
  const f=await fixture({cohort:{...liveCohort,expiresAt:"2000-01-01T00:00:00Z"}});
  expect((await f.req(f.writer,enrolmentRoute,usingCohort("A"))).status).toBe(404);
  expect((await f.req(f.writer,enrolmentRoute,{...usingCohort("A"),inviteCode:invitation(1)})).status).toBe(200);
});

it("allows only an admin to revoke a cohort code and preserves existing writers",async()=>{
  const f=await fixture({cohort:liveCohort});
  const first=await (await f.req(f.writer,enrolmentRoute,usingCohort("A"))).json<ContributorProfile>();
  const revocation={sha256:await hash(cohortCode)};
  expect((await f.req(f.other,revokeRoute,revocation)).status).toBe(404);
  expect((await f.req(f.evaluator,revokeRoute,revocation)).status).toBe(200);
  expect((await f.req(f.evaluator,revokeRoute,revocation)).status).toBe(200);
  expect((await f.req(f.other,enrolmentRoute,usingCohort("B"))).status).toBe(409);
  expect((await f.req(f.writer,path+"/writers/"+first.writer)).status).toBe(200);
  expect((await f.req(f.other,enrolmentRoute,{...usingCohort("B"),inviteCode:invitation(1)})).status).toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_revoked_invites").first()).toEqual({n:1});
});

it("balances reused sets and split counts and never admits a 51st writer",async()=>{
  const f=await fixture({cohort:liveCohort,writerLimit:50,capacity:[
    {split:"train",max:30},{split:"dev",max:20},{split:"eval_open",max:20},
  ]});
  const reviewers=Array.from({length:51},(_,i)=>"rv_"+(i+11000).toString(16).padStart(8,"0"));
  const time=new Date().toISOString();
  await env.DB.batch(reviewers.map(id=>env.DB.prepare("INSERT INTO reviewers (id,created_at,last_seen_at) VALUES (?,?,?)").bind(id,time,time)));
  const actors=await Promise.all(reviewers.map(async id=>{
    const client=new Client();
    client.cookie=(await createSessionCookie(env,id)).split(";")[0]!;
    return client;
  }));
  for (let i=0;i<49;i++)
    expect((await f.req(actors[i]!,enrolmentRoute,usingCohort(handwritingSets[i%4]!))).status).toBe(200);
  const last=await Promise.all(["B","C"].map((set,i)=>f.req(actors[49+i]!,enrolmentRoute,usingCohort(set))));
  expect(last.map(x=>x.status).sort()).toEqual([200,409]);
  const setCounts=(await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster GROUP BY set_id ORDER BY n").all<{n:number}>()).results;
  const splits=(await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster GROUP BY split ORDER BY n").all<{n:number}>()).results;
  expect(setCounts.map(r=>r.n)).toEqual([12,12,13,13]);
  expect(splits.map(r=>r.n)).toEqual([16,17,17]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_enrolments").first()).toEqual({n:50});
  const rejected=last[0]!.ok?1:0;
  const unusedSet=rejected===0?"B":"C";
  const actor=actors[49+rejected]!;
  expect((await f.req(actor,enrolmentRoute,{...usingCohort(unusedSet),inviteCode:invitation(1)})).status).toBe(409);
  expect((await (await f.req(actor,enrolmentRoute)).json<{signup:HandwritingSignup}>()).signup.sets).toEqual([]);
});
