import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { CONTRIBUTOR_API, handwritingSets, type ContributorProfile, type ContributorSplit, type HandwritingOffer, type HandwritingSet } from "../../src/shared/contributor";
import { createSessionCookie } from "../../src/worker/auth/session";
import { contributorRoot, hash, ROSTER_OPERATOR_ID } from "../../src/worker/contributor/config";
import { hmacSha256 } from "../../src/worker/crypto";
import { paymentCodeFromMac, paymentMessage } from "../../src/shared/payment-code";
import type { Env } from "../../src/worker/env";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";

const execution = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const path = CONTRIBUTOR_API;
const enrolmentRoute = path + "/enrolments";
const optionsRoute = enrolmentRoute + "/options";
const roster = path + "/operator/handwriting-roster";
const fixtureToken = "heocr_roster_v1_" + "a".repeat(43);
const invitation = (i: number) => String(i).repeat(32);
const origin = "http://localhost";
const photo = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/R8kAAAAASUVORK5CYII="), c => c.charCodeAt(0));

type FixtureOptions = {
  writerLimit?: number;
  capacity?: {split: ContributorSplit; max: number}[];
  setsBySplit?: Partial<Record<ContributorSplit,HandwritingSet[]>>;
  sharedSentence?: boolean;
  lineRoles?: Record<string,string>;
  amendmentSha256?: string;
  cohort?: {maxUses:number;expiresAt:string};
  kids?: boolean;
};
const cohortCode = invitation(8);
// Invented slot lists in kids_slots_v1.json's shape: 10-12 runs TEST, TEST, DEV, TRAIN, TRAIN; 13-17 TRAIN, DEV.
const kidsSlotsFile = JSON.stringify({schema:"heocr.handwriting_v3.kids_slots.v1",date:"2026-11-25",rule:"fixture",
  bands:{"10-12":["TEST","TEST","DEV","TRAIN","TRAIN"],"13-17":["TRAIN","DEV"]}},null,1)+"\n";
const splitFor = (set: string): ContributorSplit => set==="D" ? "eval_open" : set==="C" ? "dev" : "train";
const enrol = (inviteCode: string, set: string, ageBand = "18_plus") => ({inviteCode,ageBand,split:splitFor(set),set});
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
  const setsBySplit = options.setsBySplit??{train:["A","B","E"],dev:["C"],eval_open:["D"]};
  const planSets = options.kids ? handwritingSets : handwritingSets.filter(set => Object.values(setsBySplit).flat().includes(set));
  const sheets = Object.fromEntries(await Promise.all(planSets.map(async set => {
    return [set,await Promise.all(Array.from({length:4},async (_, index) => {
      const page = `HW-V3-${set}0${index+1}`;
      const sentences = Array.from({length:30},(_, i) => `שורת בדיקה ${page} ${i+1}`);
      if (options.sharedSentence && index===0) sentences[28] = set==="D" ? "e\u0301  142" : "é 142";
      sentences[29] = "שורת כיול לדוגמה 37";
      const pdf = "%PDF-1.4\n% invented fixture " + page;
      const sheetSha256 = await hash(pdf);
      const mediaKey = contributorRoot+"sheets/"+sheetSha256+".pdf";
      await Promise.all([env.TRAIN_CAPTURE_MEDIA!.put(mediaKey,pdf),env.HANDWRITING_MEDIA!.put(mediaKey,pdf),env.HANDWRITING_CONTROL!.put(mediaKey,pdf)]);
      return {kind:"handwriting",id:page,page,sentences,rights:"CC0-1.0: invented fixture",sheetSha256,promptSha256:await hash(sentences.join("\n"))};
    }))];
  })));
  const plan = { schema:"heocr.handwriting_signup.v1", approval:{evalSplitSha256:"1".repeat(64),leadGo:"fixture",
    allocationAmendmentSha256:options.amendmentSha256??"3".repeat(64)},
    policy, sheets, writerLimit:options.writerLimit??4, invites:await Promise.all([1,2,3,4].map(i=>hash(invitation(i)))),
    lineRoles:options.lineRoles??{"30":"calibration"},
    capacity:options.capacity??[{split:"train",max:2},{split:"dev",max:1},{split:"eval_open",max:1}],
    setsBySplit,
    ...(options.kids ? {kids:{slotsSha256:await hash(kidsSlotsFile)}} : {}),
    ...(options.cohort ? {cohort:{sha256:await hash(cohortCode),...options.cohort}} : {}) };
  if (options.kids) await env.TRAIN_CAPTURE_MEDIA!.put(contributorRoot+"handwriting-kids-slots/"+await hash(kidsSlotsFile)+".json",kidsSlotsFile);
  const pin = await hash(JSON.stringify(plan));
  await env.TRAIN_CAPTURE_MEDIA!.put(contributorRoot+"handwriting-signup/"+pin+".json",JSON.stringify(plan));
  const rosterTokenSha256 = await hash(fixtureToken);
  const req = (client: Client | null, route: string, body?: object | Uint8Array<ArrayBuffer>,
    overrides: Partial<Env> = {}, host = origin, headers?: HeadersInit, method = body ? "POST" : "GET") =>
    handle(new Request(host+route,{
      method,
      headers:{cookie:client?.cookie??"",origin:host,"content-type":"application/json",...headers},
      body:body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
    }),{...env,CONTRIBUTOR_APP_ENABLED:"1",CONTRIBUTOR_HANDWRITING_CONFIG_SHA256:pin,CONTRIBUTOR_ROSTER_REVIEWER_ID:ROSTER_OPERATOR_ID,
      CONTRIBUTOR_ROSTER_TOKEN_SHA256:rosterTokenSha256,
      CONTRIBUTOR_DEV_MEDIA:env.HANDWRITING_MEDIA,CONTRIBUTOR_EVAL_MEDIA:env.HANDWRITING_CONTROL,
      ADMIN_REVIEWER_IDS:evaluationAccount,CONTRIBUTOR_PAYMENT_CODE_SECRET:"fixture-payment-secret",...overrides},execution);
  const copyBody = (role: "guardian"|"assent") =>
    ({version:policy.version,accept:true,lang:"en",sha256:policy[role].en.sha256});
  const rosterReq = (body?: object, overrides: Partial<Env> = {}) =>
    req(null,roster,body,overrides,origin,{authorization:"Bearer "+fixtureToken});
  return {writer,guardian,evaluator,other,stranger,fourth,req,rosterReq,copyBody};
}

it("admits the roster bearer only on the canonical roster GET and POST",async()=>{
  const f=await fixture();
  const bearer={authorization:"Bearer "+fixtureToken};
  for (const route of ["/api/me","/api/config","/api/admin/progress","/privacy",path+"/enrolments",
    path+"/operator/handwriting-roster/",path+"/operator/handwriting-publications",
    path+"/writers/cw-"+"1".repeat(32)+"/tasks/HW-V3-A01/sheet"]) {
    expect((await f.req(f.evaluator,route,undefined,{},origin,bearer)).status).toBe(404);
  }
  expect((await f.req(f.evaluator,path+"/operator/handwriting-publications",{}, {},origin,bearer)).status).toBe(404);
  expect((await f.req(f.evaluator,roster)).status).toBe(404);
  for (const method of ["HEAD","OPTIONS","PUT","DELETE"]) {
    expect((await f.req(null,roster,undefined,{},origin,bearer,method)).status).toBe(404);
  }
  expect((await f.req(null,roster,undefined,{},origin,{authorization:"Bearer "+fixtureToken.replace(/a$/, "b")})).status).toBe(404);
  expect((await f.req(null,roster,undefined,{},origin,{cookie:fixtureToken})).status).toBe(404);
  expect((await f.req(null,roster+"?token=fixture",undefined,{},origin,bearer)).status).toBe(404);
  expect((await f.req(null,roster,undefined,{},origin,{...bearer,origin:"https://example.org"})).status).toBe(404);
  expect((await f.req(null,roster,undefined,{ENVIRONMENT:"production"},"https://heocr-review.heocr.workers.dev",bearer)).status).toBe(404);
  expect((await f.rosterReq(undefined,{CONTRIBUTOR_ROSTER_TOKEN_SHA256:undefined})).status).toBe(404);
  expect((await f.rosterReq(undefined,{CONTRIBUTOR_ROSTER_REVIEWER_ID:"rv_00000000"})).status).toBe(404);
  expect((await f.rosterReq(undefined,{CONTRIBUTOR_HANDWRITING_CONFIG_SHA256:undefined})).status).toBe(404);
  expect(await env.DB.prepare("SELECT 1 FROM contributor_handwriting_roster_access").first()).toBeNull();

  expect((await f.req(f.writer,enrolmentRoute,enrol(invitation(1),"A"))).status).toBe(200);
  const get=await f.rosterReq(undefined,{CONTRIBUTOR_APP_ENABLED:"0"});
  expect(get.status).toBe(200);
  expect(get.headers.get("cache-control")).toBe("private, no-store");
  const {canonical,...pin}=await get.json<{canonical:string;sha256:string;throughOrdinal:number;previousSha256:null}>();
  expect(await hash(canonical)).toBe(pin.sha256);
  expect(canonical).not.toContain("rv_");
  expect(canonical).not.toContain("invite");
  expect((await f.rosterReq(pin,{CONTRIBUTOR_APP_ENABLED:"0"})).status).toBe(200);
  const calls=await env.DB.prepare("SELECT * FROM contributor_handwriting_roster_access ORDER BY id").all();
  expect(calls.results).toEqual([
    {id:expect.any(Number),principal:"eval-operator",method:"GET",requested_at_ms:expect.any(Number)},
    {id:expect.any(Number),principal:"eval-operator",method:"POST",requested_at_ms:expect.any(Number)},
  ]);
});

it("limits concurrent roster requests in a five-minute window and keeps GET and POST independent",async()=>{
  const f=await fixture();
  const fixed=Date.parse("2026-11-24T10:00:05.000Z");
  const now=vi.spyOn(Date,"now").mockReturnValue(fixed);
  try {
    const gets=await Promise.all(Array.from({length:8},()=>f.rosterReq()));
    expect(gets.map(response=>response.status).sort()).toEqual([200,200,200,200,200,200,429,429]);
    expect(gets.find(response=>response.status===429)!.headers.get("retry-after")).toBe("295");
    const posts=await Promise.all(Array.from({length:4},()=>f.rosterReq({})));
    expect(posts.map(response=>response.status).sort()).toEqual([400,400,400,429]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster_access").first("n")).toBe(9);
    now.mockReturnValue(fixed+300_000);
    expect((await f.rosterReq()).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster_access").first("n")).toBe(10);
  } finally {
    now.mockRestore();
  }
});

it("allows the owner an upload after guardian consent and assent before the first daily audit",async()=>{
  const f=await fixture({kids:true});
  const join=enrol(invitation(1),"A","13_17");
  expect((await f.req(null,path+"/enrolments",join)).status).toBe(401);
  expect((await f.req(f.writer,path+"/enrolments",join,{CONTRIBUTOR_APP_ENABLED:"0"})).status).toBe(404);
  expect((await f.req(f.writer,path+"/enrolments",join,{ENVIRONMENT:"production"},"https://heocr-review.heocr.workers.dev")).status).toBe(404);
  expect((await f.req(f.writer,path+"/enrolments",{...join,inviteCode:invitation(9)})).status).toBe(404);
  expect(await (await f.req(f.writer,optionsRoute,{inviteCode:join.inviteCode,ageBand:join.ageBand})).json())
    .toEqual({split:"train",sets:["A","B"]});
  const response=await f.req(f.writer,path+"/enrolments",join);
  expect(response.status).toBe(200);
  const profile=await response.json<ContributorProfile>();
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(profile).toMatchObject({role:"writer",ageBand:"13_17",state:"guardian",queues:[]});
  expect(profile.writer).toMatch(/^cw-[a-f0-9]{32}$/);
  expect(profile.guardianPairingCode).toBeTruthy();
  const writerPath=path+"/writers/"+profile.writer;
  let task=writerPath+"/tasks/HW-V3-A01";
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
  const pin=await (await f.rosterReq()).json<{sha256:string;canonical:string;throughOrdinal:number;previousSha256:null}>();
  expect(await hash(pin.canonical)).toBe(pin.sha256);
  expect(JSON.parse(pin.canonical).rows).toEqual([{ordinal:pin.throughOrdinal,writer:profile.writer,ageBand:"13_17",set:"E",split:"train",slot:1,second:"A"}]);
  const {canonical, ...acceptPin}=pin;
  expect(canonical).not.toContain("rv_");
  expect((await f.req(f.stranger,roster,acceptPin)).status).toBe(404);
  expect((await f.rosterReq({...acceptPin,sha256:"2".repeat(64)})).status).toBe(409);
  const assent=await f.req(f.writer,writerPath+"/consent",f.copyBody("assent"));
  const ready=await assent.json<ContributorProfile>();
  expect(ready).toMatchObject({state:"ready",queues:[{kind:"handwriting",total:8,done:0}]});
  const first=ready.queues[0]!.next!.page;
  task=writerPath+"/tasks/"+first;
  expect(new TextDecoder().decode(await (await f.req(f.writer,task+"/sheet")).arrayBuffer())).toBe("%PDF-1.4\n% invented fixture "+first);
  const photoHeaders=uploadHeaders(ready);
  expect((await f.req(f.guardian,task+"/submit",photo,{},origin,photoHeaders)).status).toBe(404);
  expect((await f.req(f.stranger,task+"/submit",photo,{},origin,photoHeaders)).status).toBe(404);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_pins").first<{n:number}>())?.n).toBe(0);
  expect((await f.req(f.writer,task+"/submit",photo,{},origin,photoHeaders)).status).toBe(200);
  expect(await env.DB.prepare("SELECT 1 FROM contributor_handwriting_release_candidates").first()).toBeNull();
  expect((await f.rosterReq(acceptPin)).status).toBe(200);
  expect(await env.DB.prepare("SELECT 1 AS eligible FROM contributor_handwriting_release_candidates").first()).toEqual({eligible:1});
  expect((await f.rosterReq(acceptPin)).status).toBe(409);
  expect((await f.req(f.guardian,writerPath+"/withdraw",{withdraw:true})).status).toBe(200);
  expect((await f.req(f.writer,task+"/submit",photo,{},"http://localhost",photoHeaders)).status).toBe(404);
  expect((await (await f.rosterReq()).json<{sha256:string}>()).sha256).toBe(pin.sha256);
});

it("offers the least-filled split first, rejects a set from another split, and chains pins",async()=>{
  const f=await fixture();
  const join=(who:Client,i:number,set:string)=>f.req(who,enrolmentRoute,enrol(invitation(i),set));
  expect((await join(f.writer,1,"A")).status).toBe(200);
  const previous=await (await f.rosterReq()).json<{sha256:string;throughOrdinal:number;previousSha256:null}>();
  expect((await join(f.other,2,"D")).status).toBe(409);
  expect((await f.req(f.other,enrolmentRoute,{...enrol(invitation(2),"D"),split:"dev"})).status).toBe(409);
  expect(await (await f.req(f.other,optionsRoute,{inviteCode:invitation(2),ageBand:"18_plus"})).json()).toEqual({split:"dev",sets:["C"]});
  const other=await (await join(f.other,2,"C")).json<ContributorProfile>();
  expect(other.state).toBe("assent");
  expect((await f.rosterReq(previous)).status).toBe(200);
  expect((await join(f.stranger,3,"D")).status).toBe(200);
  expect((await join(f.fourth,4,"B")).status).toBe(200);
  const next=await (await f.rosterReq()).json<{canonical:string;sha256:string;throughOrdinal:number;previousSha256:string}>();
  expect(next.previousSha256).toBe(previous.sha256);
  expect(JSON.parse(next.canonical).rows.map((row:{set:string;split:string})=>[row.set,row.split])).toEqual([
    ["A","train"],["C","dev"],["D","eval_open"],["B","train"],
  ]);
  const otherPath=path+"/writers/"+other.writer;
  expect(await (await f.req(f.other,otherPath+"/consent",f.copyBody("assent"))).json())
    .toMatchObject({state:"ready"});
  expect((await f.rosterReq({...next,previousSha256:null})).status).toBe(409);
  expect((await f.rosterReq(next)).status).toBe(200);
  expect((await f.req(f.other,otherPath+"/tasks/HW-V3-C01/sheet",undefined,{CONTRIBUTOR_DEV_MEDIA:undefined})).status).toBe(404);
  expect((await f.req(f.other,otherPath+"/tasks/HW-V3-C01/sheet")).status).toBe(200);
  expect((await f.req(f.other,otherPath+"/tasks/HW-V3-A01/sheet")).status).toBe(404);
  expect((await join(f.guardian,4,"B")).status).toBe(409);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster").first<{n:number}>())?.n).toBe(4);
});


function uploadHeaders(profile: ContributorProfile) {
  const task=profile.queues[0]?.next;
  if (task?.kind!=="handwriting") throw Error("missing fixture task");
  return {"x-contributor-reference":task.referenceSha256,"x-contributor-privacy":"confirmed"};
}

async function readyAdult(f: Awaited<ReturnType<typeof fixture>>) {
  const joined=await (await f.req(f.writer,enrolmentRoute,enrol(invitation(1),"A"))).json<ContributorProfile>();
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
  const before=await (await f.rosterReq()).json<{sha256:string;throughOrdinal:number;previousSha256:null}>();
  const publicationRoute=path+"/operator/handwriting-publications";
  const firstPin={contentSha256:await hash(photo),releaseSha256:"3".repeat(64)};
  expect((await f.req(f.stranger,publicationRoute,firstPin)).status).toBe(404);
  expect((await f.req(f.evaluator,publicationRoute,firstPin,{},"https://heocr-review.heocr.workers.dev")).status).toBe(404);
  expect((await f.req(f.evaluator,publicationRoute,firstPin)).status).toBe(409);
  expect((await f.rosterReq(before)).status).toBe(200);
  expect((await f.req(f.evaluator,publicationRoute,firstPin)).status).toBe(200);
  expect((await f.req(f.evaluator,publicationRoute,{...firstPin,releaseSha256:"4".repeat(64)})).status).toBe(409);
  await bucket.put(prefix+"orphan","private fixture");
  const stopped=await f.req(f.writer,ready.writerPath+"/withdraw",{withdraw:true});
  expect(stopped.status).toBe(200);
  expect(await stopped.json()).toMatchObject({state:"withdrawn",receipt:first.receipt,queues:[]});
  expect(await env.DB.prepare("SELECT 1 FROM contributor_enrolments WHERE writer_id=?").bind(ready.writer).first()).toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM contributor_submissions WHERE writer_id=?").bind(ready.writer).first()).toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM contributor_handwriting_release_candidates WHERE writer_id=?").bind(ready.writer).first()).toBeNull();
  expect((await (await f.rosterReq()).json<{sha256:string}>()).sha256).toBe(before.sha256);
  expect((await f.req(f.writer,ready.writerPath+"/consent",f.copyBody("assent"))).status).toBe(404);
  expect((await f.req(f.writer,"/api/batches")).status).toBe(404);
  const rejoin=enrol(cohortCode,"C");
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
    expect((await f.req(f.writer,optionsRoute,{inviteCode:invitation(9),ageBand:"18_plus"})).status).toBe(404);
  }
  const limited=await f.req(f.writer,enrolmentRoute,enrol(invitation(1),"A"));
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster").first<{n:number}>())?.n).toBe(0);
});

it.each(["dev","eval_open"] as const)("stores the original only in the assigned %s bucket",async split=>{
  const f=await fixture();
  const join=(actor:Client,i:number,set:string)=>f.req(actor,enrolmentRoute,enrol(invitation(i),set));
  expect((await join(f.writer,1,"A")).status).toBe(200);
  if (split==="eval_open") expect((await join(f.other,2,"C")).status).toBe(200);
  const set=split==="dev" ? "C" : "D";
  const joined=await (await join(f.stranger,split==="dev"?2:3,set)).json<ContributorProfile>();
  const writerPath=path+"/writers/"+joined.writer;
  const ready=await (await f.req(f.stranger,writerPath+"/consent",f.copyBody("assent"))).json<ContributorProfile>();
  const prefix=contributorRoot+"quarantine/"+ready.writer+"/";
  const saved=await f.req(f.stranger,writerPath+`/tasks/HW-V3-${set}01/submit`,photo,{},origin,uploadHeaders(ready));
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

it("rejects a stale split offer when two writers sign up concurrently",async()=>{
  const f=await fixture();
  const actors=[f.writer,f.other];
  const offers=await Promise.all(actors.map((actor,index)=>f.req(actor,optionsRoute,{
    inviteCode:invitation(index+1),ageBand:"18_plus",
  }).then(res=>res.json())));
  expect(offers).toEqual([{split:"train",sets:["A","B","E"]},{split:"train",sets:["A","B","E"]}]);
  const replies=await Promise.all(actors.map((actor,index)=>f.req(actor,enrolmentRoute,enrol(invitation(index+1),"A"))));
  expect(replies.map(reply=>reply.status).sort()).toEqual([200,409]);
  const totals=await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM contributor_enrolments) AS enrolled,
    (SELECT COUNT(*) FROM contributor_handwriting_roster) AS roster`).first();
  expect(totals).toEqual({enrolled:1,roster:1});
  const losingIndex=replies.findIndex(reply=>reply.status===409);
  const actor=actors[losingIndex]!, inviteCode=invitation(losingIndex+1);
  expect(await (await f.req(actor,optionsRoute,{inviteCode,ageBand:"18_plus"})).json()).toEqual({split:"dev",sets:["C"]});
  expect((await f.req(actor,enrolmentRoute,enrol(inviteCode,"C"))).status).toBe(200);
});

const revokeRoute = path+"/operator/handwriting-invites/revoke";
const liveCohort = {maxUses:50,expiresAt:"2099-01-01T00:00:00Z"};
const usingCohort = (set: string) => enrol(cohortCode,set);

it("allows the same cohort code for multiple writers, atomically enforces its own use cap and keeps individual codes",async()=>{
  const f=await fixture({cohort:{...liveCohort,maxUses:2}});
  expect((await f.req(f.writer,enrolmentRoute,usingCohort("A"))).status).toBe(200);
  expect(await (await f.req(f.other,optionsRoute,{inviteCode:cohortCode,ageBand:"18_plus"})).json()).toEqual({split:"dev",sets:["C"]});
  const replies=await Promise.all([
    f.req(f.other,enrolmentRoute,usingCohort("C")),f.req(f.stranger,enrolmentRoute,usingCohort("C")),
  ]);
  expect(replies.map(x=>x.status).sort()).toEqual([200,409]);
  const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster WHERE invite_sha256=?")
    .bind(await hash(cohortCode)).first<{n:number}>();
  expect(count?.n).toBe(2);
  const actor=replies[0]!.ok?f.stranger:f.other;
  expect((await f.req(actor,enrolmentRoute,enrol(invitation(1),"D"))).status).toBe(200);
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
  expect((await f.req(f.other,enrolmentRoute,usingCohort("C"))).status).toBe(409);
  expect((await f.req(f.writer,path+"/writers/"+first.writer)).status).toBe(200);
  expect((await f.req(f.other,enrolmentRoute,enrol(invitation(1),"C"))).status).toBe(200);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_revoked_invites").first()).toEqual({n:1});
});

it("fills the registered split capacities in tie-break order and never admits a 51st writer",async()=>{
  const f=await fixture({cohort:liveCohort,writerLimit:50,capacity:[
    {split:"eval_open",max:20},{split:"train",max:24},{split:"dev",max:6},
  ]});
  const reviewers=Array.from({length:51},(_,i)=>"rv_"+(i+11000).toString(16).padStart(8,"0"));
  const time=new Date().toISOString();
  await env.DB.batch(reviewers.map(id=>env.DB.prepare("INSERT INTO reviewers (id,created_at,last_seen_at) VALUES (?,?,?)").bind(id,time,time)));
  const actors=await Promise.all(reviewers.map(async id=>{
    const client=new Client();
    client.cookie=(await createSessionCookie(env,id)).split(";")[0]!;
    return client;
  }));
  const offer=(actor: Client)=>f.req(actor,optionsRoute,{inviteCode:cohortCode,ageBand:"18_plus"}).then(res=>res.json<HandwritingOffer>());
  const initial=["eval_open","train","dev"];
  for (let i=0;i<49;i++) {
    const {split,sets}=await offer(actors[i]!);
    if (i<initial.length) expect(split).toBe(initial[i]);
    expect(sets.every(set=>splitFor(set)===split)).toBe(true);
    expect((await f.req(actors[i]!,enrolmentRoute,usingCohort(sets[0]!))).status).toBe(200);
  }
  const {sets}=await offer(actors[49]!);
  const last=await Promise.all(actors.slice(49).map(actor=>f.req(actor,enrolmentRoute,usingCohort(sets[0]!))));
  expect(last.map(x=>x.status).sort()).toEqual([200,409]);
  const setCounts=(await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster GROUP BY set_id ORDER BY n").all<{n:number}>()).results;
  const splits=(await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster GROUP BY split ORDER BY n").all<{n:number}>()).results;
  expect(setCounts.map(r=>r.n)).toEqual([6,8,8,8,20]);
  expect(splits.map(r=>r.n)).toEqual([6,20,24]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_enrolments").first()).toEqual({n:50});
  const rejected=last[0]!.ok?1:0;
  const actor=actors[49+rejected]!;
  expect((await f.req(actor,enrolmentRoute,enrol(invitation(1),sets[0]!))).status).toBe(409);
  expect((await f.req(actor,optionsRoute,{inviteCode:invitation(1),ageBand:"18_plus"})).status).toBe(409);
});

it.each([{}, {train:["A","B"],dev:["C"],eval_open:["C","D"]}] as FixtureOptions["setsBySplit"][])(
  "rejects an incomplete or overlapping set allocation", async setsBySplit=>{
    const f=await fixture({setsBySplit});
    expect((await f.req(f.writer,enrolmentRoute)).status).toBe(404);
  },
);

it("rejects a sentence shared across differently hashed sheets",async()=>{
  const f=await fixture({sharedSentence:true});
  expect((await f.req(f.writer,enrolmentRoute)).status).toBe(404);
});

const badCalibrationPlans: FixtureOptions[] = [
  {lineRoles:{}}, {lineRoles:{"29":"calibration","30":"calibration"}}, {amendmentSha256:""},
];
it.each(badCalibrationPlans)("requires a pinned amendment and marks only line 30 as calibration",async options=>{
  const f=await fixture(options);
  expect((await f.req(f.writer,enrolmentRoute)).status).toBe(404);
});

it("rejects under-10 ages and refuses to pin a cross-split assignment",async()=>{
  const f=await fixture();
  const inviteCode=invitation(1);
  expect((await f.req(f.writer,optionsRoute,{inviteCode,ageBand:"under_10"})).status).toBe(400);
  expect((await f.req(f.writer,enrolmentRoute,enrol(inviteCode,"A","under_10"))).status).toBe(400);
  const joined=await (await f.req(f.writer,enrolmentRoute,enrol(inviteCode,"A"))).json<ContributorProfile>();
  const pin=await (await f.rosterReq()).json<{sha256:string;throughOrdinal:number;previousSha256:null}>();
  await env.DB.prepare("UPDATE contributor_handwriting_roster SET set_id='D' WHERE writer_id=?").bind(joined.writer).run();
  expect((await f.rosterReq()).status).toBe(404);
  expect((await f.rosterReq(pin)).status).toBe(404);
  expect((await f.req(f.writer,path+"/writers/"+joined.writer)).status).toBe(404);
  expect(await env.DB.prepare("SELECT 1 FROM contributor_handwriting_pins").first()).toBeNull();
});

it("loads a plan with only the sets it maps (production's A-D shape) and keeps kids OFF without a slot list",async()=>{
  const f=await fixture({setsBySplit:{train:["A","B"],dev:["C"],eval_open:["D"]}});
  expect(await (await f.req(f.writer,optionsRoute,{inviteCode:invitation(1),ageBand:"18_plus"})).json())
    .toEqual({split:"train",sets:["A","B"]});
  expect((await f.req(f.writer,enrolmentRoute,enrol(invitation(1),"F"))).status).toBe(409);
});

it("assigns kids the band's next slot, an 8-sheet pack in seeded order and X of 8 progress",async()=>{
  const f=await fixture({kids:true,writerLimit:1,capacity:[{split:"train",max:1},{split:"dev",max:1},{split:"eval_open",max:1}],
    cohort:{maxUses:20,expiresAt:"2099-01-01T00:00:00Z"}});
  const kids=await Promise.all(Array.from({length:6},async(_, i)=>{ const c=new Client(); await c.signIn("signup-kid-"+i); return c; }));
  const join=async(kid: Client, ageBand: string, pick?: string)=>{
    const offer=await (await f.req(kid,optionsRoute,{inviteCode:cohortCode,ageBand})).json<HandwritingOffer>();
    const res=await f.req(kid,enrolmentRoute,{inviteCode:cohortCode,ageBand,split:offer.split,set:pick??offer.sets[0]});
    expect(res.status).toBe(200);
    return {offer,profile:await res.json<ContributorProfile>()};
  };
  // 10-12 slots: TEST, TEST, DEV, TRAIN; 13-17 slot 1: TRAIN. Adult capacity is untouched by kids.
  const a=await join(kids[0]!,"10_12");
  expect(a.offer).toEqual({split:"eval_open",sets:["D"]});
  expect((await join(kids[1]!,"10_12")).offer.split).toBe("eval_open");
  expect((await join(kids[2]!,"10_12")).offer).toEqual({split:"dev",sets:["C"]});
  const train=await (await f.req(kids[3]!,optionsRoute,{inviteCode:cohortCode,ageBand:"10_12"})).json<HandwritingOffer>();
  expect(train).toEqual({split:"train",sets:["A","B"]});
  expect((await f.req(kids[3]!,enrolmentRoute,{inviteCode:cohortCode,ageBand:"10_12",split:"train",set:"E"})).status).toBe(409);
  expect((await f.req(kids[3]!,enrolmentRoute,{inviteCode:cohortCode,ageBand:"10_12",split:"dev",set:"C"})).status).toBe(409);
  const t=await join(kids[3]!,"10_12","B");
  expect((await join(kids[4]!,"13_17","A")).offer.split).toBe("train");
  expect(await (await f.req(f.writer,optionsRoute,{inviteCode:cohortCode,ageBand:"18_plus"})).json()).toMatchObject({split:"train"});

  const rows=(await env.DB.prepare("SELECT age_band,split,set_id,kids_slot,kids_second_set FROM contributor_handwriting_roster ORDER BY ordinal").all()).results;
  expect(rows).toEqual([
    {age_band:"10_12",split:"eval_open",set_id:"D",kids_slot:1,kids_second_set:"F"},
    {age_band:"10_12",split:"eval_open",set_id:"D",kids_slot:2,kids_second_set:"F"},
    {age_band:"10_12",split:"dev",set_id:"C",kids_slot:3,kids_second_set:"G"},
    {age_band:"10_12",split:"train",set_id:"E",kids_slot:4,kids_second_set:"B"},
    {age_band:"13_17",split:"train",set_id:"E",kids_slot:1,kids_second_set:"A"},
  ]);

  // The pack: E01-E04 + B01-B04, ranked by sha256(seed + ":" + page) with seed = sha256(prefix + writer code).
  const guardian=new Client(); await guardian.signIn("signup-kid-parent");
  await f.req(guardian,path+"/guardian",{...f.copyBody("guardian"),code:t.profile.guardianPairingCode});
  const ready=await (await f.req(kids[3]!,path+"/writers/"+t.profile.writer+"/consent",f.copyBody("assent"))).json<ContributorProfile>();
  expect(ready.queues).toMatchObject([{kind:"handwriting",total:8,done:0}]);
  // Payment code (amendment 3b): six symbols, HMAC of the writer code under the operator secret.
  expect(ready.paymentCode).toBe(paymentCodeFromMac(new Uint8Array(await hmacSha256("fixture-payment-secret",paymentMessage(t.profile.writer)))));
  expect(ready.paymentCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  expect((await (await f.req(guardian,path+"/writers/"+t.profile.writer)).json<ContributorProfile>()).paymentCode).toBeUndefined();
  const unset=await (await f.req(kids[3]!,path+"/writers/"+t.profile.writer,undefined,{CONTRIBUTOR_PAYMENT_CODE_SECRET:undefined})).json<ContributorProfile>();
  expect(unset.paymentCode).toBeUndefined();
  const pages=["E01","E02","E03","E04","B01","B02","B03","B04"].map(p=>"HW-V3-"+p);
  const seed=await hash("20261125:hw3-kids-order:"+t.profile.writer);
  const keyed=await Promise.all(pages.map(async p=>[await hash(seed+":"+p),p] as const));
  const order=keyed.sort(([x],[y])=>x<y?-1:1).map(([,p])=>p);
  expect(ready.queues[0]!.next?.page).toBe(order[0]);
  const second=path+"/writers/"+t.profile.writer+"/tasks/"+order[1]+"/submit";
  expect((await f.req(kids[3]!,second,photo,{},origin,uploadHeaders(ready))).status).toBe(404);
  const first=path+"/writers/"+t.profile.writer+"/tasks/"+order[0]+"/submit";
  expect((await f.req(kids[3]!,first,photo,{},origin,uploadHeaders(ready))).status).toBe(200);
  const after=await (await f.req(kids[3]!,path+"/writers/"+t.profile.writer)).json<ContributorProfile>();
  expect(after.queues).toMatchObject([{kind:"handwriting",total:8,done:1,next:{page:order[1]}}]);

  // Checkpoint: kids' rows carry their slot and second set; a pin makes the kid's B page a release candidate.
  const pin=await (await f.rosterReq()).json<{sha256:string;canonical:string;throughOrdinal:number;previousSha256:null}>();
  expect(JSON.parse(pin.canonical).rows[3]).toEqual({ordinal:expect.any(Number),writer:t.profile.writer,ageBand:"10_12",set:"E",split:"train",slot:4,second:"B"});
  const {canonical:_c,...accept}=pin;
  expect((await f.rosterReq(accept)).status).toBe(200);
  expect((await env.DB.prepare("SELECT task_id FROM contributor_handwriting_release_candidates").all()).results).toEqual([{task_id:order[0]}]);

  // Withdrawal keeps the slot: the next 10-12 kid gets slot 5 (TRAIN), never slot 4 again.
  await f.req(guardian,path+"/writers/"+t.profile.writer+"/withdraw",{withdraw:true});
  await join(kids[5]!,"10_12","A");
  expect(await env.DB.prepare("SELECT MAX(kids_slot) AS n FROM contributor_handwriting_roster WHERE age_band='10_12'").first()).toEqual({n:5});
});

it("refuses every minor on the adult route while no kids block is pinned",async()=>{
  const f=await fixture();
  for (const ageBand of ["10_12","13_17"]) {
    expect((await f.req(f.writer,optionsRoute,{inviteCode:invitation(1),ageBand})).status).toBe(409);
    expect((await f.req(f.writer,enrolmentRoute,{inviteCode:invitation(1),ageBand,split:"train",set:"A"})).status).toBe(409);
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contributor_handwriting_roster").first()).toEqual({n:0});
  expect((await f.req(f.writer,enrolmentRoute,enrol(invitation(1),"A"))).status).toBe(200);
});
