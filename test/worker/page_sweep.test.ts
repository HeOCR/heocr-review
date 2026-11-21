import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";
import type { SweepPage } from "../../src/shared/page-sweep";

const batch = "midcentury_triage_v1";
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const root = "/api/page-sweep/" + batch;
const captureBatch = "private-ref-capture-sweep-fixture";
const capturePin = "a".repeat(64);
const issuerBatch = "private-ref-draft-sweep-fixture";
const issuerPin = "b".repeat(64);
const registry = JSON.stringify({[issuerBatch]:issuerPin,"private-ref-draft-spare-fixture":"c".repeat(64)});
const scan = { ref: { source: "r2", key: "1".repeat(64) + ".jpg" }, width: 700, height: 900, box: null };
const box = [0.1, 0.1, 0.8, 0.14];
async function fixture(idOfBatch = batch) {
  const capture = idOfBatch === captureBatch;
  const issuer = idOfBatch === issuerBatch;
  const verification = capture || issuer;
  const batch = idOfBatch;
  const owner = new Client();
  const id = await owner.signIn("sweep-fixture-owner");
  await owner.acceptTerms();
  const other = new Client();
  await other.signIn("sweep-fixture-other");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO batches(id,task_type,title,source_json,imported_at,status,restricted_reference)
      VALUES (?,'line_verify','Fixture',?,'now','open',1)`).bind(batch,JSON.stringify({
        batch_id:batch,schema_version:"line_verify_items.v1.2",
        ...(verification ? {restricted_review:"draft_verification"} : {}),
        ...(capture ? {capture_roster_sha256:capturePin} : {}),
        ...(issuer ? {items_sha256:issuerPin} : {}),
      })),
    env.DB.prepare("INSERT INTO batch_settings(batch_id,updated_at,updated_by,mode,pointed_books) VALUES (?,'now','fixture',?,'keep')").bind(batch,verification?"standard":"triage"),
    ...[93100,93110,93120].map(n => env.DB.prepare("INSERT INTO items(id,batch_id,external_id,title,payload_json) VALUES (?,?,?,'Fixture',?)")
      .bind(n,batch,"fixture-page-"+n,JSON.stringify({page_image:scan,line_verify_imported_at:"now",width:700,height:900}))),
    env.DB.prepare("INSERT INTO restricted_reference_pages(batch_id,item_id) VALUES (?,93100)").bind(batch),
    env.DB.prepare("INSERT INTO restricted_reference_pages(batch_id,item_id,first_allowed,blind_allowed) VALUES (?,93120,0,1)").bind(batch),
    ...[93101,93102,93103,93104].map((n, i) => env.DB.prepare(`INSERT INTO proposals
      (id,batch_id,item_id,external_id,category,confidence,rank,payload_json,media_json,content_sha256)
      VALUES (?,?,93100,?,'a','a',?,?,?,?)`).bind(n,batch,"fixture-line-"+n,i,JSON.stringify({
        item_id:"fixture-line-"+n,page_id:"fixture-page-93100",order:i,line_index:i,pass:1,
        kind: i===3 && !verification ? "type" : "verify", candidate_text:i===2?".":i===3&&!verification?"":"תוכן בדיקה",
        attention_spans:[],candidate_provenance:i===3&&!verification?"":"pdf_text_layer",page:{width:700,height:900},
        ...(verification ? {uncertain:i===1} : {}),
      }),JSON.stringify({page:{...scan,box:i===3?null:box}}),"sha-"+n)),
    env.DB.prepare("INSERT INTO decisions(id,proposal_id,reviewer_id,value,text,proposal_sha256,terms_version,created_at,decided_on) VALUES ('old-fixture',93101,?,'exact',NULL,'sha-93101','fixture','now','now')").bind(id),
  ]);
  await env.RESTRICTED_REFERENCE_MEDIA!.put(`${batch}/${scan.ref.key}`, "sample");
  function request(path: string, data?: unknown, opts: {cookie?:string; host?:string; flag?:string; pin?:string; registry?:string} = {}) {
    const host=opts.host??"http://localhost";
    return handle(new Request(host+path,{
      method:data===undefined?"GET":"POST",
      headers:{cookie:opts.cookie??owner.cookie,origin:host,"content-type":"application/json"},
      body:data===undefined?undefined:JSON.stringify(data),
    }),{ ...env, PAGE_SWEEP_ENABLED:opts.flag??"1",RESTRICTED_REFERENCE_REVIEWER_ID:id,ADMIN_REVIEWER_IDS:id,
      REGISTERED_CAPTURE_ROSTER_SHA256:opts.pin??capturePin,REGISTERED_CAPTURE_ENABLED:"0",
      RATIFIED_ISSUER_SWEEP_PINS:opts.registry??registry },exec);
  }
  const page=async()=> (await (await request("/api/page-sweep/"+batch+"/next")).json() as {page:SweepPage}).page;
  return {request,page,other};
}

it("uses restricted page media and atomically finishes a page with preserved and inline verdicts", async () => {
  const f=await fixture();
  expect((await f.request(root+"/next",undefined,{flag:"0"})).status).toBe(404);
  expect((await f.request(root+"/next",undefined,{cookie:""})).status).toBe(401);
  expect((await f.request(root+"/next",undefined,{cookie:f.other.cookie})).status).toBe(404);
  expect((await f.request(root+"/next",undefined,{host:"https://heocr-review.heocr.workers.dev"})).status).toBe(404);
  expect((await f.request(root+"/pages/93110/image")).status).toBe(404);
  expect((await f.request(root+"/pages/93120/image")).status).toBe(404);
  expect((await f.request(root+"/pages/93120")).status).toBe(404);
  const page=await f.page();
  expect(page.lines.map(l=>[l.state,l.box])).toEqual([["done",box],["open",box],["open",null],["open",null]]);
  expect((await f.request(page.image.url)).headers.get("cache-control")).toContain("no-store");
  const edit=await f.request(root+"/pages/"+page.id,{action:"edit",line:93102,token:page.token,value:"edited",text:"תוכן מתוקן"});
  expect(edit.status).toBe(200);
  const next=(await edit.json() as {page:SweepPage}).page;
  expect(next.lines[1]).toMatchObject({ state:"edited", text:"תוכן מתוקן" });
  expect((await f.request(root+"/pages/"+page.id,{action:"finish",token:page.token})).status).toBe(409);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM page_checks WHERE batch_id=?").bind(batch).first())?.n).toBe(0);
  const finish=await f.request(root+"/pages/"+page.id,{action:"finish",token:next.token});
  expect(finish.status).toBe(200);
  expect(await finish.json()).toEqual({complete:true,written:2});
  const rows=await env.DB.prepare("SELECT value,method,superseded_at FROM decisions WHERE proposal_id BETWEEN 93101 AND 93104 ORDER BY proposal_id").all();
  expect(rows.results).toEqual([
    {value:"exact",method:"line",superseded_at:null}, {value:"edited",method:"page_sweep",superseded_at:null},
    {value:"exact",method:"page_sweep",superseded_at:null}, {value:"exact",method:"page_sweep",superseded_at:null},
  ]);
  expect(await f.page()).toBeNull();
  expect(await env.DB.prepare("SELECT answer,method FROM page_checks WHERE batch_id=?").bind(batch).first()).toEqual({answer:"complete",method:"page_sweep"});
  expect((await f.request(root+"/pages/"+page.id,{action:"finish",token:next.token})).status).toBe(409);
});

it("keeps a historical plant while both enabled views use the same unplanted draft", async () => {
  const f=await fixture();
  const digest=(await import("../../src/shared/sha256")).sha256Hex;
  await env.DB.prepare(`INSERT INTO triage_plants (batch_id,proposal_id,item_id,plant_type,position,planted_text,planted_sha256,candidate_sha256,plants_sha256,imported_at)
    VALUES (?,93102,'fixture-line-93102','fixture','0','טקסט בדיקה',?,?,'fixture','now')`)
    .bind(batch,digest("טקסט בדיקה"),digest("תוכן בדיקה")).run();
  const path="/api/proposals/93102?queue=triage";
  expect(await (await f.request(path,undefined,{flag:"0"})).json()).toMatchObject({proposal:{view:{candidate:"טקסט בדיקה"}}});
  expect(await (await f.request(path)).json()).toMatchObject({proposal:{view:{candidate:"תוכן בדיקה"}}});
  const page=await f.page();
  expect(page.lines[1]!.text).toBe("תוכן בדיקה");
  expect((await f.request("/api/proposals/93102/decision",{value:"correct"})).status).toBe(409);
  expect((await f.request("/api/proposals/93102/decision",{value:"correct",pageSweepDraft:true})).status).toBe(200);
  expect(await env.DB.prepare("SELECT method,value FROM decisions WHERE proposal_id=93102").first())
    .toEqual({method:"line_unplanted",value:"correct"});
  const fresh=await f.page();
  expect(fresh.lines[1]!.state).toBe("done");
  expect((await f.request(root+"/pages/93100",{action:"missing_lines",token:fresh.token})).status).toBe(200);
  expect(await env.DB.prepare("SELECT answer FROM page_checks WHERE item_id=93100").first()).toEqual({answer:"missing_lines"});
  expect(await env.DB.prepare("SELECT position FROM triage_plants WHERE proposal_id=93102").first()).toEqual({position:"0"});
});

it.each([captureBatch,issuerBatch])("uses the correct pin for %s and preserves private verification", async (batchId) => {
  const f = await fixture(batchId);
  const root = "/api/page-sweep/" + batchId;
  const wrongPin = batchId === captureBatch ? {pin:"b".repeat(64),registry:"{"} : {registry:JSON.stringify({[issuerBatch]:capturePin})};
  const line = "/api/proposals/93104";
  expect((await f.request("/registered-captures")).status).toBe(404);
  expect((await f.request(root + "/next", undefined, {flag:"0"})).status).toBe(404);
  expect((await f.request(root + "/next", undefined, wrongPin)).status).toBe(404);
  expect((await f.request(root + "/pages/93100/image", undefined, {cookie:f.other.cookie})).status).toBe(404);
  expect((await f.request(root + "/pages/93120")).status).toBe(404);
  expect(await (await f.request("/api/batches")).json()).toMatchObject({
    batches:expect.arrayContaining([expect.objectContaining({id:batchId,pageSweep:{remainingPages:1}})]),
  });
  const page = await f.page();
  expect(page.lines.map(l => [l.state, l.options.map(o => o.value)])).toEqual([
    ["done", []], ["pending", ["exact"]], ["open", []], ["open", []],
  ]);
  expect((await f.request(page.image.url, undefined, wrongPin)).status).toBe(404);
  expect((await f.request(page.image.url)).headers.get("cache-control")).toContain("no-store");
  const write = root + "/pages/" + page.id;
  expect((await f.request(write, {action:"finish",token:page.token})).status).toBe(409);
  expect((await f.request(write, {action:"edit",token:page.token,line:93102,value:"unreadable"})).status).toBe(400);
  expect((await f.request(write, {action:"edit",token:page.token,line:93102,value:"exact"})).status).toBe(200);
  const priorLine = await (await f.request(line)).json() as {proposal:{pageSweepDraft?:boolean}};
  expect(priorLine.proposal.pageSweepDraft).toBeUndefined();
  expect((await f.request(line + "/decision", {value:"exact"})).status).toBe(200);
  const next = await f.page();
  expect(await (await f.request(write, {action:"missing_lines",token:next.token})).json()).toEqual({complete:true,written:1});
  expect(await env.DB.prepare("SELECT method,value FROM decisions WHERE proposal_id=93104").first()).toEqual({method:"line",value:"exact"});
  expect(await env.DB.prepare("SELECT answer,method FROM page_checks WHERE item_id=93100").first()).toEqual({answer:"missing_lines",method:"page_sweep"});
  await env.DB.batch([
    env.DB.prepare("INSERT INTO restricted_reference_pages(batch_id,item_id) VALUES (?,93110)").bind(batchId),
    env.DB.prepare(`INSERT INTO proposals
      (id,batch_id,item_id,external_id,category,confidence,rank,payload_json,media_json,content_sha256)
      SELECT 93111,batch_id,93110,'fixture-line-93111',category,confidence,10,
        json_set(payload_json,'$.page_id','fixture-page-93110','$.item_id','fixture-line-93111'),media_json,'sha-93111'
      FROM proposals WHERE id=93104`),
  ]);
  expect(await (await f.request("/api/batches/" + batchId + "/next?queue=fix")).json()).toMatchObject({
    proposal:null, page:{itemId:93100,mode:"add"},
  });
});

it("keeps unpinned issuer drafts out of the listing, private routes, decisions, and exports", async () => {
  const f = await fixture(issuerBatch);
  const route = "/api/page-sweep/" + issuerBatch;
  for (const registry of ["", "{", null, [issuerPin], {"private-ref-draft-spare-fixture":issuerPin},
    {[issuerBatch]:issuerPin + "\n"}, {[issuerBatch]:{digest:issuerPin}}].map(v => typeof v === "string" ? v : JSON.stringify(v))) {
    const opts = {registry};
    const {batches} = await (await f.request("/api/batches",undefined,opts)).json() as {batches:{id:string}[]};
    expect(batches.some(row => row.id === issuerBatch)).toBe(false);
    for (const path of [route + "/next", "/api/batches/" + issuerBatch + "/next", "/api/proposals/93102",
      "/api/restricted-media/v1/proposals/93102/page", "/api/admin/batches/" + issuerBatch + "/export"]) {
      expect((await f.request(path,undefined,opts)).status).toBe(404);
    }
    expect((await f.request("/api/proposals/93102/decision",{value:"exact"},opts)).status).toBe(404);
  }
  expect((await f.request(route + "/next",undefined,{cookie:f.other.cookie})).status).toBe(404);
  expect((await f.request(route + "/next",undefined,{host:"https://heocr-review.heocr.workers.dev"})).status).toBe(404);
  expect((await f.request("/api/proposals/93102",undefined,{flag:"0"})).status).toBe(200);
  expect((await f.request(route + "/next",undefined,{pin:""})).status).toBe(200);
  const page = await f.page();
  await env.DB.prepare("UPDATE batches SET source_json=json_set(source_json,'$.items_sha256',?) WHERE id=?")
    .bind(capturePin,issuerBatch).run();
  expect((await f.request(route + "/pages/" + page.id,{action:"edit",token:page.token,line:93102,value:"exact"})).status).toBe(404);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM decisions WHERE proposal_id=93102").first()).toEqual({n:0});
});
