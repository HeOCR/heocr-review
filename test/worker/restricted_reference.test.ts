import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/shared/sha256";
import { DRAFT_VERIFICATION } from "../../src/tasks/restricted_reference";
import { handle } from "../../src/worker/index";
import { Client } from "./helpers";
import type { Env } from "../../src/worker/env";

const host = "https://review.heocr.org";
const alternate = "https://heocr-review.heocr.workers.dev";
const otherHost = "https://preview.example.org";
const title = "fixture-limited-reference";
const exec = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const key = `${"a".repeat(64)}.jpg`;
const image = { ref: { source: "r2", key }, width: 1200, height: 1800, box: [0.1, 0.2, 0.9, 0.3] };
const images = JSON.stringify({ crop: image, page: image });
const confirm = { answer: "complete" };
const proposalMedia = (id: number, kind: "crop" | "page") => `/api/restricted-media/v1/proposals/${id}/${kind}`;
const pageMedia = (batch: string, id: number) => `/api/restricted-media/v1/batches/${batch}/pages/${id}`;

async function fixtureUsers() {
  async function user(name: string) {
    const c = new Client();
    const id = await c.signIn(name);
    await c.acceptTerms();
    return { id, cookie: c.cookie };
  }
  const owner = await user("restricted-owner");
  const admin = await user("restricted-other-admin");
  const volunteer = await user("restricted-volunteer");
  const expectedEnv = {
    ...env, ENVIRONMENT: "production",
    ADMIN_REVIEWER_IDS: `${owner.id},${admin.id}`,
    RESTRICTED_REFERENCE_REVIEWER_ID: owner.id,
    ASSETS: { fetch: () => new Response("static fixture") } as unknown as Fetcher,
  };
  const req = (method: string, path: string, cookie = owner.cookie, origin = host, json?: unknown, override?: Partial<Env>) =>
    handle(new Request(origin + path, {
      method, headers: { cookie, origin, "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json),
    }), { ...expectedEnv, ...override }, exec);
  return { owner, admin, volunteer, req };
}

async function fixtureLine() {
  const batch = "fixture_line_verify_v1";
  const { results } = await env.DB.prepare(`SELECT id, item_id, external_id, payload_json FROM proposals
    WHERE batch_id=?1 ORDER BY rank,id`).bind(batch).all<{ id: number; item_id: number; external_id: string; payload_json: string }>();
  const front = results[0]!;
  const outside = results.find((p) => p.item_id !== front.item_id)!;
  const orig = (JSON.parse(front.payload_json) as { candidate_text: string }).candidate_text;
  await env.DB.batch([
    env.DB.prepare("UPDATE batches SET restricted_reference=1,title=?2 WHERE id=?1").bind(batch, title),
    env.DB.prepare(`INSERT INTO batch_settings (batch_id,updated_at,updated_by,mode,pointed_books)
      VALUES (?1,'2026-11-20','fixture','triage','keep')`).bind(batch),
    env.DB.prepare("INSERT INTO restricted_reference_pages(batch_id,item_id) VALUES (?1,?2)").bind(batch, front.item_id),
    env.DB.prepare("UPDATE proposals SET media_json=?2 WHERE id=?1 OR id=?3").bind(front.id, images, outside.id),
    env.DB.prepare(`INSERT INTO triage_plants
      (batch_id,proposal_id,item_id,plant_type,position,planted_text,planted_sha256,candidate_sha256,plants_sha256,imported_at)
      VALUES (?1,?2,?3,'fixture',0,'בדיקה',?4,?5,?6,'2026-11-20')`)
      .bind(batch, front.id, front.external_id, sha256Hex("בדיקה"), sha256Hex(orig), "a".repeat(64)),
  ]);
  await env.RESTRICTED_REFERENCE_MEDIA!.put(`${batch}/${key}`, "fake jpeg");
  return { batch, front, outside, orig };
}

it("serves protected draft decisions directly and requires explicit checks after all lines", async () => {
  const { owner, admin, volunteer, req } = await fixtureUsers();
  const { batch, front, outside: second } = await fixtureLine();
  await env.DB.batch([
    env.DB.prepare("UPDATE batches SET source_json=json_set(source_json,'$.restricted_review',?2) WHERE id=?1").bind(batch, DRAFT_VERIFICATION),
    env.DB.prepare("UPDATE batch_settings SET mode='standard' WHERE batch_id=?1").bind(batch),
    env.DB.prepare("DELETE FROM triage_plants WHERE batch_id=?1").bind(batch),
    env.DB.prepare("INSERT INTO restricted_reference_pages(batch_id,item_id) VALUES (?1,?2)").bind(batch, second.item_id),
    env.DB.prepare("UPDATE proposals SET active=0 WHERE batch_id=?1 AND id NOT IN (?2,?3)").bind(batch, front.id, second.id),
    env.DB.prepare("UPDATE proposals SET payload_json=json_set(payload_json,'$.candidate_text','טיוטה','$.attention_spans',json('[[0,5]]')) WHERE id=?1")
      .bind(front.id),
  ]);
  const queue = `/api/batches/${batch}`;
  const first = `/api/proposals/${front.id}`;
  const other = `/api/proposals/${second.id}`;
  const page = `${queue}/pages/${front.item_id}`;
  const secondPage = `${queue}/pages/${second.item_id}`;
  const exportPath = `/api/admin/batches/${batch}/export`;
  for (const [cookie, origin, status] of [
    ["", host, 401], [admin.cookie, host, 404], [volunteer.cookie, host, 404], [owner.cookie, alternate, 404],
  ] as const) {
    const read = await req("GET", proposalMedia(front.id, "page"), cookie, origin);
    expect(read.status).toBe(status);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect((await req("GET", `${queue}/next`, cookie, origin)).status).toBe(status);
    expect((await req("POST", `${page}/check`, cookie, origin, confirm)).status).toBe(status);
  }
  expect((await req("GET", exportPath, admin.cookie)).status).toBe(404);
  expect((await req("GET", proposalMedia(front.id, "page"))).status).toBe(200);
  expect(await (await req("GET", `${queue}/next`)).json()).toMatchObject({
    proposal: { id: front.id, options: [{ value: "exact" }, { value: "edited" }], view: {
      draftVerification: true, candidate: "טיוטה", runs: [{ attention: true, text: "טיוטה" }],
      page: { url: proposalMedia(front.id, "page") },
    } }, progress: { total: 4, covered: 0 }, prefetch: [],
  });
  expect((await req("POST", `${first}/decision`, owner.cookie, host, { value: "different" })).status).toBe(400);
  expect((await req("POST", `${first}/decision`, owner.cookie, host, { value: "exact" })).status).toBe(200);
  expect((await req("POST", `${page}/check`, owner.cookie, host, confirm)).status).toBe(409);
  expect((await req("GET", pageMedia(batch, front.item_id))).status).toBe(404);
  expect(await (await req("GET", `${queue}/next`)).json()).toMatchObject({ proposal: { id: second.id } });
  expect((await req("POST", `${other}/skip`)).status).toBe(200);
  expect(await (await req("GET", `${queue}/next`)).json()).toMatchObject({
    proposal: null, page: null, progress: { covered: 1, skippedByMe: 1, remainingForMe: 2 },
  });
  expect((await req("POST", `${queue}/skips/clear`)).status).toBe(200);
  expect((await req("POST", `${other}/decision`, owner.cookie, host, { value: "edited", text: "שורה מתוקנת" })).status).toBe(200);
  expect(await (await req("GET", `${queue}/next`)).json()).toMatchObject({
    proposal: null, page: { itemId: front.item_id, mode: "check", image: { url: pageMedia(batch, front.item_id) } }, progress: { covered: 2 },
  });
  expect((await req("GET", pageMedia(batch, front.item_id), admin.cookie)).status).toBe(404);
  expect((await req("GET", pageMedia(batch, front.item_id))).status).toBe(200);
  expect((await req("POST", `${page}/check`, owner.cookie, host, confirm)).status).toBe(200);
  expect((await req("POST", `${secondPage}/check`, owner.cookie, host, { answer: "missing_lines" })).status).toBe(200);
  expect(await (await req("GET", `${queue}/next`)).json()).toMatchObject({
    page: { itemId: second.item_id, mode: "add" }, progress: { covered: 3, remainingForMe: 1 },
  });
  expect((await req("POST", `${secondPage}/done`)).status).toBe(409);
  expect((await req("POST", `${secondPage}/lines`, owner.cookie, host, { box: [0.1, 0.35, 0.8, 0.4], value: "typed", text: "שורה חסרה" })).status).toBe(200);
  expect((await req("POST", `${secondPage}/done`)).status).toBe(200);
  expect(await (await req("GET", `${queue}/next`)).json()).toMatchObject({
    page: null, progress: { covered: 4, remainingForMe: 0 },
  });
  const exported = await (await req("GET", exportPath)).json();
  expect(exported).toMatchObject({ files: {
    "line_verify_decisions.json": { decisions: expect.arrayContaining([
      expect.objectContaining({ item_id: front.external_id, decision: "exact", candidate_sha256: sha256Hex("טיוטה") }),
      expect.objectContaining({ item_id: second.external_id, decision: "edited", text: "שורה מתוקנת" }),
    ]) },
    "reference_verification_pages.json": {
      pages: expect.arrayContaining([
        expect.objectContaining({ completeness: expect.objectContaining({ answer: "complete" }) }),
        expect.objectContaining({ completeness: expect.objectContaining({ answer: "lines_added" }) }),
      ]),
      added_lines: [expect.objectContaining({ text: "שורה חסרה" })],
    },
  } });
});

it("fails closed on listings, deep links, all writes, media, exports and alternative hostnames", async () => {
  const { owner, admin, volunteer, req } = await fixtureUsers();
  const { batch, front, outside, orig } = await fixtureLine();
  const deep = `/api/proposals/${front.id}`;
  const queue = `/api/batches/${batch}`;
  const checks = `${queue}/pages/${front.item_id}`;
  const expiry = `/api/admin/batches/${batch}/export`;

  const staged = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM restricted_reference_pages WHERE batch_id=?1) AS pages,
    (SELECT COUNT(*) FROM triage_plants WHERE batch_id=?1) AS plants`).bind(batch).first();
  expect(staged).toEqual({ pages: 1, plants: 1 });

  for (const [cookie, origin, denied] of [
    ["", host, 401],
    [volunteer.cookie, host, 404],
    [admin.cookie, host, 404],
    [owner.cookie, alternate, 404],
    [owner.cookie, otherHost, 404],
  ] as const) {
    const res = await req("GET", "/api/batches", cookie, origin);
    expect(res.status).toBe(cookie ? 200 : 401);
    expect(await res.text()).not.toContain(title);
    for (const [method, path, body] of [
      ["GET", `${queue}/next`], ["GET", deep], ["GET", proposalMedia(front.id, "crop")], ["GET", proposalMedia(front.id, "page")],
      ["POST", `${deep}/decision`, { value: "correct" }], ["POST", `${deep}/skip`], ["PUT", `${deep}/draft`, {}],
      ["DELETE", `${deep}/draft`], ["POST", `${queue}/skips/clear`], ["POST", `${checks}/check`, confirm],
      ["GET", pageMedia(batch, front.item_id)], ["POST", `${checks}/lines`, {}], ["POST", `${checks}/done`],
      ["DELETE", `${queue}/added-lines/pl-1234567812345678`],
    ] as const) {
      const response = await req(method, path, cookie, origin, body);
      expect(response.status, `${origin} ${method} ${path}`).toBe(denied);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect((await req("GET", expiry, cookie, origin)).status).toBe(cookie === volunteer.cookie ? 403 : denied);
    expect(await (await req("GET", "/api/admin/progress", cookie, origin)).text()).not.toContain(title);
  }

  expect((await req("GET", deep, owner.cookie, host, undefined, { RESTRICTED_REFERENCE_MEDIA: undefined })).status).toBe(404);
  expect((await req("GET", deep, owner.cookie, host, undefined, { RESTRICTED_REFERENCE_REVIEWER_ID: undefined })).status).toBe(404);
  expect(await (await req("GET", "/api/batches")).text()).toContain(title);
  expect(await (await req("GET", `${queue}/next`)).json()).toMatchObject({ proposal: { id: front.id }, prefetch: [] });
  for (const mode of ["", "?queue=fix", "?queue=triage"]) {
    const detail = await req("GET", deep + mode);
    expect(detail.headers.get("cache-control")).toBe("no-store");
    expect(await detail.json()).toMatchObject({ proposal: { view: { candidate: "בדיקה", runs: [],
      crop: { url: proposalMedia(front.id, "crop") }, page: { url: proposalMedia(front.id, "page") } } } });
  }
  expect((await req("POST", `${deep}/decision`, owner.cookie, host, { value: "exact" })).status).toBe(409);
  const media = await req("GET", proposalMedia(front.id, "crop"));
  expect(media.status).toBe(200);
  expect(media.headers.get("cache-control")).toBe("private, no-store");
  expect(media.headers.get("cdn-cache-control")).toBe("no-store");
  expect(media.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
  expect(media.headers.has("etag")).toBe(false);
  expect(new TextDecoder().decode(await media.arrayBuffer())).toBe("fake jpeg");
  expect((await req("GET", proposalMedia(outside.id, "page"))).status).toBe(404);
  expect((await req("GET", `/api/proposals/${outside.id}`)).status).toBe(404);
  expect((await req("POST", `${queue}/pages/${outside.item_id}/check`, owner.cookie, host, confirm)).status).toBe(404);
  expect(await (await req("GET", expiry)).text()).not.toContain(outside.external_id);
  expect((await req("POST", `${deep}/decision`, owner.cookie, host, { value: "different" })).status).toBe(200);
  expect(await (await req("GET", deep)).json()).toMatchObject({ proposal: { view: { candidate: orig } } });
  expect((await req("POST", `${deep}/decision`, owner.cookie, host, { value: "edited", text: "תיקון" })).status).toBe(200);

  for (const origin of [host, alternate, otherHost]) {
    for (const path of ["/media/private-ref-fixture/page.jpg", "/media/newprinted_midcentury_v0/page.jpg",
      "/media/%6eewprinted_midcentury_v0/page.jpg", "/media/midcentury_triage_v1/page.jpg",
      "/media/%2Fprivate-ref-fixture/page.jpg", "/media/other/%2e%2e%2fnewprinted_midcentury_v0/page.jpg"]) {
      const response = await req("GET", path, "", origin);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  }
  expect(await (await req("GET", "/media/some-public-fixture/page.jpg")).text()).toBe("static fixture");
});

it("denies retired URLs before reading assets, the database or the bucket", async () => {
  const { owner } = await fixtureUsers();
  const assets = vi.fn(() => new Response("cached fixture", { headers: { etag: '"old"' } }));
  const prepare = vi.fn();
  const get = vi.fn();
  const bindings = {
    ...env,
    ASSETS: { fetch: assets }, DB: { prepare }, RESTRICTED_REFERENCE_MEDIA: { get },
  } as unknown as Env;
  for (const origin of [host, alternate]) {
    for (const path of [
      "/media/private-ref-fixture/page.jpg",
      "/Media/private-ref-fixture/page.jpg",
      "/%6dedia/private-ref-fixture/page.jpg",
      "/media/private-ref-fixture/page.jpg?ignored=1",
      "/api/proposals/12/image/crop",
      "/api/proposals/12/image/page",
      "/api/batches/private-ref-fixture/pages/34/image",
      "/%61pi/restricted-media/v1/proposals/12/page",
      "/api/restricted-media/v0/proposals/12/page",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await handle(new Request(origin + path, {
          method, headers: { cookie: owner.cookie, "if-none-match": '"old"' },
        }), bindings, exec);
        expect(res.status, `${method} ${origin}${path}`).toBe(404);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.has("location")).toBe(false);
        expect(res.headers.has("etag")).toBe(false);
      }
    }
  }
  expect(assets).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  const publicAsset = await handle(new Request(`${host}/media/public-fixture/page.jpg`), bindings, exec);
  expect(await publicAsset.text()).toBe("cached fixture");
  expect(assets).toHaveBeenCalledTimes(1);
});

it("keeps protected blind pages gated and closes first-pass reads, images, drafts and exports during the blind pass", async () => {
  const { owner, admin, req } = await fixtureUsers();
  const batch = "newprinted_midcentury_v0";
  const blind = (await env.DB.prepare(`SELECT id,item_id,gate_ref FROM proposals WHERE batch_id=?1 AND gate_kind='after_confirm' LIMIT 1`)
    .bind(batch).first<{ id: number; item_id: number; gate_ref: string }>())!;
  const anchor = (await env.DB.prepare("SELECT id,content_sha256 FROM proposals WHERE batch_id=?1 AND external_id=?2")
    .bind(batch, blind.gate_ref).first<{ id: number; content_sha256: string }>())!;
  const pass = `/api/proposals/${blind.id}`;
  const first = `/api/proposals/${anchor.id}`;
  expect((await req("GET", first)).status).toBe(404);
  expect((await req("GET", `/api/batches/${batch}/next`)).status).toBe(404);
  expect((await req("GET", `/api/admin/batches/${batch}/export`)).status).toBe(404);
  await env.DB.batch([
    env.DB.prepare("UPDATE batches SET restricted_reference=1 WHERE id=?1").bind(batch),
    env.DB.prepare("INSERT INTO restricted_reference_pages(batch_id,item_id,blind_allowed) VALUES (?1,?2,1)").bind(batch, blind.item_id),
    env.DB.prepare("UPDATE proposals SET media_json=?3 WHERE id IN (?1,?2)").bind(blind.id, anchor.id, images),
  ]);
  await env.RESTRICTED_REFERENCE_MEDIA!.put(`${batch}/${key}`, "fake scan");

  expect((await req("GET", pass)).status).toBe(409);
  expect((await req("GET", proposalMedia(blind.id, "page"))).status).toBe(409);
  expect((await req("POST", `${pass}/decision`, owner.cookie, host, { value: "confirm", text: "{}" })).status).toBe(409);
  expect((await req("GET", proposalMedia(anchor.id, "page"))).status).toBe(200);
  const prior = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO decisions (id,proposal_id,reviewer_id,value,text,proposal_sha256,terms_version,created_at,decided_on)
      SELECT 'fixture-first', ?1, id, 'confirm', '{"page_action":"confirm","lines":[]}', ?2, terms_version, ?3, substr(?3,1,10)
      FROM reviewers WHERE id=?4`).bind(anchor.id, anchor.content_sha256, prior, owner.id).run();
  expect((await req("GET", pass, admin.cookie)).status).toBe(404);
  expect((await req("GET", proposalMedia(blind.id, "page"), owner.cookie, alternate)).status).toBe(404);
  expect((await req("GET", proposalMedia(blind.id, "page"))).status).toBe(200);
  expect(await (await req("GET", `/api/batches/${batch}/next`)).json()).toMatchObject({ proposal: { id: blind.id, mine: null }, prefetch: [] });
  expect((await req("GET", first)).status).toBe(409);
  expect((await req("GET", proposalMedia(anchor.id, "page"))).status).toBe(409);
  expect((await req("PUT", `${first}/draft`, owner.cookie, host, {})).status).toBe(409);
  expect((await req("GET", `/api/admin/batches/${batch}/export`)).status).toBe(409);
  await env.DB.prepare("UPDATE restricted_reference_pages SET first_allowed=0 WHERE batch_id=?1").bind(batch).run();
  expect((await req("GET", first)).status).toBe(404);
  expect((await req("GET", proposalMedia(blind.id, "page"))).status).toBe(200);
  await env.DB.prepare("UPDATE restricted_reference_pages SET blind_allowed=0 WHERE batch_id=?1").bind(batch).run();
  expect((await req("GET", pass)).status).toBe(404);
  expect((await req("GET", proposalMedia(blind.id, "page"))).status).toBe(404);
});

it("serves a completeness-only page only with pinned coverage and requires a real check and recorded additions", async () => {
  const { owner, admin, req } = await fixtureUsers();
  const batch = "private-ref-completeness-fixture";
  const page = 6401;
  const queue = `/api/batches/${batch}`;
  const item = `${queue}/pages/${page}`;
  const img = pageMedia(batch, page);
  const now = "2026-11-21T00:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO batches (id,task_type,title,source_json,status,imported_at)
      VALUES (?1,'line_verify','fixture','{}','open',?2)`).bind(batch, now),
    env.DB.prepare(`INSERT INTO batch_settings (batch_id,updated_at,updated_by,mode,pointed_books)
      VALUES (?1,?2,'fixture','triage','keep')`).bind(batch, now),
    env.DB.prepare("INSERT INTO items(id,batch_id,external_id,title,payload_json) VALUES (?1,?2,'fixture-page','fixture',?3)")
      .bind(page, batch, JSON.stringify({ page_image: image, line_verify_imported_at: now, width: 1200, height: 1800 })),
    env.DB.prepare("INSERT INTO restricted_reference_pages(batch_id,item_id) VALUES (?1,?2)").bind(batch, page),
  ]);
  await env.RESTRICTED_REFERENCE_MEDIA!.put(`${batch}/${key}`, "fake scan");
  expect((await req("GET", img)).status).toBe(404);
  expect((await req("POST", `${item}/check`, owner.cookie, host, confirm)).status).toBe(409);
  const boxes = [{ box: image.box, lineIndex: 0 }];
  await env.DB.prepare("UPDATE restricted_reference_pages SET coverage_boxes_json=?1 WHERE batch_id=?2")
    .bind(JSON.stringify(boxes), batch).run();
  expect(await (await req("GET", `${queue}/next`)).json()).toMatchObject({ page: { itemId: page, mode: "check", image: { url: img }, boxes } });
  const imageResponse = await req("GET", img);
  expect(imageResponse.status).toBe(200);
  expect(imageResponse.headers.get("cache-control")).toBe("private, no-store");
  expect((await req("GET", img, admin.cookie)).status).toBe(404);
  expect((await req("GET", img, owner.cookie, alternate)).status).toBe(404);

  const exportPath = `/api/admin/batches/${batch}/export`;
  const getExport = async () => (await (await req("GET", exportPath)).json() as { files: Record<string, unknown> }).files["reference_triage.json"];
  expect(await getExport()).toMatchObject({ pages: [{ page_id: "fixture-page", completeness: null }], rows: [] });
  expect((await req("POST", `${item}/check`, owner.cookie, host, { answer: "missing_lines" })).status).toBe(200);
  expect((await req("POST", `${item}/done`)).status).toBe(409);
  expect((await req("GET", img)).status).toBe(200);
  const addedResponse = await req("POST", `${item}/lines`, owner.cookie, host, { box: [0.1, 0.4, 0.9, 0.5], value: "typed", text: "תוספת" });
  expect(addedResponse.status).toBe(200);
  const { id: added } = await addedResponse.json() as { id: string };
  expect((await req("POST", `${item}/done`)).status).toBe(200);
  expect((await req("GET", img)).status).toBe(404);
  expect((await req("DELETE", `${queue}/added-lines/${added}`)).status).toBe(404);
  expect(await getExport()).toMatchObject({ pages: [{
    page_id: "fixture-page", completeness: { answer: "missing_lines", lines_added_at: expect.any(String) },
  }], rows: [{ queue: "desktop_added", correction: { text: "תוספת" } }] });
});
