import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { CONTRIBUTOR_API, handwritingSets, type ContributorProfile } from "../../src/shared/contributor";
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

async function fixture() {
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
    policy, sheets, invites:await Promise.all([1,2,3,4].map(i=>hash(invitation(i)))),
    capacity:[{split:"train",max:2},{split:"dev",max:1},{split:"eval_open",max:1}] };
  const pin = await hash(JSON.stringify(plan));
  await env.TRAIN_CAPTURE_MEDIA!.put(contributorRoot+"handwriting-signup/"+pin+".json",JSON.stringify(plan));
  const req = (client: Client | null, route: string, body?: object | Uint8Array<ArrayBuffer>,
    overrides: Partial<Env> = {}, host = origin, headers?: HeadersInit) =>
    handle(new Request(host+route,{
      method:body ? "POST" : "GET",
      headers:{cookie:client?.cookie??"",origin:host,"content-type":"application/json",...headers},
      body:body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
    }),{...env,CONTRIBUTOR_APP_ENABLED:"1",CONTRIBUTOR_HANDWRITING_CONFIG_SHA256:pin,CONTRIBUTOR_ROSTER_REVIEWER_ID:evaluationAccount,
      CONTRIBUTOR_DEV_MEDIA:env.HANDWRITING_MEDIA,CONTRIBUTOR_EVAL_MEDIA:env.HANDWRITING_CONTROL,...overrides},execution);
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
  expect((await f.req(f.writer,writerPath+"/withdraw",{withdraw:true})).status).toBe(200);
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

it("allocates a set only once when two accounts try to claim it concurrently",async()=>{
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
