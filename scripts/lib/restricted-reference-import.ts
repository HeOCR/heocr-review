import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import { CAPTURE_BATCH_PREFIX, CAPTURE_DIGEST, captureRoster } from "../../src/shared/registered-captures";
import { lineVerifyImporter } from "../../src/tasks/line_verify/importer";
import { ITEMS_SCHEMA_V12, LLM_PROVENANCE, lineTextProblems, type PixelBox } from "../../src/tasks/line_verify/schema";
import { DRAFT_VERIFICATION, needsRestrictedRoster, RESTRICTED_BATCH_PREFIX } from "../../src/tasks/restricted_reference";
import type { ImportBundle } from "../../src/tasks/import";
import type { ProposalRecord } from "../../src/tasks/types";
import { planPlants } from "./plants";

export const digest = (bytes: Buffer, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const sha = /^[a-f0-9]{64}$/;
const batchKey = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const pagePath = /^pages\/[a-z0-9_-][a-z0-9._-]*\.(png|jpg|jpeg|webp)$/i;
const provenance = new Set(["pdf_text_layer", "stock_tesseract_heb"]);

export interface RestrictedPins {
  batch: string;
  itemsSha: string;
  plantsSha: string | null;
  pages: number;
  lines: number;
  plants: number;
  separateBlindPages: number;
  captureRosterSha?: string;
}

interface Page {
  page_id: string;
  split: "test";
  image: string;
  sha256: string;
  width: number;
  height: number;
  source: string;
  booklet: string;
  book_group: string;
  issuer_pdf_sha256?: string;
  issuer_page_index?: number;
  image_role?: string;
}

interface Line {
  item_id: string;
  page_id: string;
  split: "test";
  rank: number;
  line_index: number;
  pass?: number;
  kind: "verify" | "type";
  uncertain?: boolean;
  candidate_text: string | null;
  candidate_provenance: string | null;
  box: PixelBox;
  context_box: PixelBox;
}

interface Projection {
  schema_version: string;
  batch_id: string;
  pages: Page[];
  items: Line[];
  blind_second_pass: string[];
  draft_basis?: string;
}

function requireScope(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`restricted import refused: ${reason}`);
}

const name = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && !/[\x00-\x1f\x7f]/u.test(value);
const index = (value: number) => Number.isSafeInteger(value) && value >= 0;

function within(box: PixelBox, page: Page): boolean {
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) &&
    0 <= box[0] && box[0] < box[2] && box[2] <= page.width &&
    0 <= box[1] && box[1] < box[3] && box[3] <= page.height;
}

function byUnique<T>(records: T[], id: (record: T) => string, kind: string): Map<string, T> {
  const keyed = new Map<string, T>();
  for (const record of records) {
    requireScope(record && typeof record === "object", `malformed ${kind}`);
    const key = id(record);
    requireScope(name(key) && !key.endsWith("@pass2") && !keyed.has(key), `missing, reserved or repeated ${kind} ID`);
    keyed.set(key, record);
  }
  return keyed;
}

export async function prepareRestrictedReferenceImport(
  itemsBytes: Buffer, plantsBytes: Buffer | null, mediaRoot: string, pins: RestrictedPins, captureRosterBytes: Buffer | null = null,
) {
  requireScope(batchKey.test(pins.batch) && needsRestrictedRoster(pins.batch), "batch is outside the restricted writer's scope");
  requireScope(sha.test(pins.itemsSha) && digest(itemsBytes) === pins.itemsSha, "items checksum differs");
  const { plantsSha } = pins;
  const verification = plantsSha === null;
  if (verification) {
    requireScope(pins.batch.startsWith(RESTRICTED_BATCH_PREFIX), "draft verification needs a private-ref batch ID");
    requireScope(plantsBytes === null && pins.plants === 0 && pins.separateBlindPages === 0, "draft verification has neither plants nor blind passes");
  } else {
    requireScope(plantsBytes !== null && sha.test(plantsSha) && digest(plantsBytes) === plantsSha, "plants checksum differs");
  }
  const input = JSON.parse(itemsBytes.toString("utf8")) as Projection;
  const plants = plantsBytes === null ? null : JSON.parse(plantsBytes.toString("utf8")) as { bundle_sha256: string; plants: unknown[] };
  requireScope(input?.schema_version === ITEMS_SCHEMA_V12 && input.batch_id === pins.batch, "schema or batch differs");
  requireScope(Array.isArray(input.pages) && input.pages.length === pins.pages && pins.pages > 0 &&
    Array.isArray(input.items) && input.items.length === pins.lines && pins.lines > 0, "registered roster counts differ");
  requireScope(verification || (plants?.bundle_sha256 === pins.itemsSha && Array.isArray(plants.plants) && plants.plants.length === pins.plants),
    "plant count or binding to the items pin differs");

  const capture = pins.batch.startsWith(CAPTURE_BATCH_PREFIX);
  requireScope(capture === !!pins.captureRosterSha && capture === !!captureRosterBytes, "capture queue needs its separately pinned registration roster");
  const registered = captureRosterBytes && pins.captureRosterSha ? (() => {
    requireScope(verification && CAPTURE_DIGEST.test(pins.captureRosterSha) && digest(captureRosterBytes) === pins.captureRosterSha,
      "capture roster checksum or verification mode differs");
    const roster = captureRoster(JSON.parse(captureRosterBytes.toString("utf8")));
    requireScope(roster.batch_id === pins.batch && roster.pages.length === pins.pages && input.draft_basis === "issuer_text_layer",
      "capture roster batch, page count or draft basis differs");
    requireScope(roster.pages.every((entry, i) => {
      const page = input.pages[i];
      return page && page.page_id === entry.page_id && page.issuer_pdf_sha256 === entry.issuer_pdf_sha256 &&
        page.issuer_page_index === entry.issuer_page_index && page.book_group === entry.issue_key && page.image_role === "issuer_render";
    }), "verification pages differ from registered issuer locators or order");
    return new Map(roster.pages.map(page => [page.page_id, page]));
  })() : null;

  const pages = byUnique(input.pages, (page) => page.page_id, "page");
  const lines = byUnique(input.items, (line) => line.item_id, "item");
  requireScope(Array.isArray(input.blind_second_pass) && input.blind_second_pass.length === pins.separateBlindPages &&
    new Set(input.blind_second_pass).size === pins.separateBlindPages &&
    input.blind_second_pass.every((id) => pages.has(id) && !lines.has(id)), "blind checks must be separate page registrations");
  for (const page of pages.values()) {
    requireScope(page.split === "test" && name(page.source) && name(page.booklet) && name(page.book_group),
      "page is outside test or lacks source grouping");
    requireScope(name(page.image) && pagePath.test(page.image) && !page.image.includes("..") &&
      sha.test(page.sha256) && index(page.width) && page.width > 0 && index(page.height) && page.height > 0, "invalid page media pin");
  }
  const ranks = new Set<number>();
  const seenLineIndices = new Map(input.pages.map((page) => [page.page_id, new Set<number>()]));
  for (const line of lines.values()) {
    const page = pages.get(line.page_id);
    requireScope(page && line.split === "test" && (line.pass === undefined || line.pass === 1), "line is outside the test first pass");
    requireScope(index(line.rank) && !ranks.has(line.rank), "invalid or repeated rank");
    ranks.add(line.rank);
    const indices = seenLineIndices.get(line.page_id)!;
    requireScope(index(line.line_index) && !indices.has(line.line_index), "invalid or repeated page line index");
    indices.add(line.line_index);
    requireScope(within(line.box, page) && within(line.context_box, page) &&
      line.context_box[0] <= line.box[0] && line.context_box[1] <= line.box[1] &&
      line.context_box[2] >= line.box[2] && line.context_box[3] >= line.box[3], "invalid line/context geometry");
    if (verification) {
      requireScope(line.kind === "verify" && typeof line.candidate_text === "string" && lineTextProblems(line.candidate_text).length === 0 &&
        (line.candidate_provenance === "reference_draft" || LLM_PROVENANCE.test(line.candidate_provenance ?? "")) &&
        typeof line.uncertain === "boolean", "draft verification needs a valid candidate, provenance and uncertainty flag");
    } else {
      requireScope(line.kind === "verify" ? name(line.candidate_text) && provenance.has(line.candidate_provenance ?? "") :
        line.kind === "type" && line.candidate_text === null && line.candidate_provenance === null, "invalid first-pass candidate provenance");
    }
  }
  requireScope([...seenLineIndices.values()].every((indices) => indices.size > 0), "a registered page has no lines");

  const root = realpathSync(mediaRoot);
  const pagesRoot = resolve(root, "pages");
  requireScope(realpathSync(pagesRoot) === pagesRoot, "media directory redirects");
  const paths = new Map<string, string>();
  for (const page of pages.values()) {
    const path = realpathSync(resolve(root, page.image));
    requireScope(dirname(path) === pagesRoot, "page image escaped the approved media directory");
    const bytes = readFileSync(path);
    requireScope(digest(bytes) === page.sha256, "page bytes do not match their pin");
    const meta = await sharp(bytes, { failOn: "error" }).metadata();
    const extension = page.image.split(".").at(-1)?.toLowerCase();
    requireScope(meta.width === page.width && meta.height === page.height && (meta.orientation ?? 1) === 1 &&
      (meta.pages ?? 1) === 1 && meta.format === (extension === "jpg" ? "jpeg" : extension), "page format, orientation or dimensions differ");
    paths.set(page.page_id, path);
  }

  const bundle: ImportBundle = lineVerifyImporter.bundle({
    ...input, blind_second_pass: [],
    items: verification ? input.items.map((line) => ({ ...line, precheck: undefined })) : input.items,
  });
  bundle.batch.source = { ...bundle.batch.source, restricted_partition: "test", items_sha256: pins.itemsSha, plants_sha256: pins.plantsSha };
  if (verification) bundle.batch.source.restricted_review = DRAFT_VERIFICATION;
  if (registered) bundle.batch.source.capture_roster_sha256 = pins.captureRosterSha;
  for (const item of bundle.items) {
    const page = pages.get(item.externalId)!;
    Object.assign(item.payload, { booklet: page.booklet, book_group: page.book_group, restricted_partition: "test" });
    const entry = registered?.get(item.externalId);
    if (entry) Object.assign(item.payload, {
      issuer_pdf_sha256: entry.issuer_pdf_sha256, issuer_page_index: entry.issuer_page_index, image_role: "issuer_render",
    });
  }
  for (const proposal of bundle.proposals) {
    const line = lines.get(proposal.externalId)!;
    const page = pages.get(proposal.itemExternalId)!;
    proposal.rank = line.rank;
    if (verification) {
      const uncertain = line.uncertain === true;
      proposal.payload.uncertain = uncertain;
      proposal.payload.attention_spans = uncertain ? [[0, Array.from(line.candidate_text!).length]] : [];
    }
    const source = proposal.payload.page as Record<string, unknown>;
    Object.assign(source, { booklet: page.booklet, book_group: page.book_group, restricted_partition: "test" });
    if (!("script" in page)) delete source.script;
  }
  if (verification) {
    bundle.proposals.sort((a, b) => Number(b.payload.uncertain) - Number(a.payload.uncertain) || a.rank - b.rank);
    bundle.proposals.forEach((proposal, rank) => { proposal.rank = rank; });
  }

  const plan = plants === null ? { rows: [], refused: [], skipped_decided: [] } : planPlants(plants, bundle.proposals.map((proposal, i) => {
    const record: ProposalRecord = { ...proposal, id: i + 1, batchId: bundle.batch.id, itemTitle: "", active: true, media: {}, contentSha256: "" };
    return { proposal: record, decisions: 0 };
  }));
  requireScope(plan.rows.length === pins.plants && plan.refused.length === 0 && plan.skipped_decided.length === 0,
    `plant planner matched ${plan.rows.length}, skipped ${plan.skipped_decided.length}, refused ${plan.refused.length}`);
  return { bundle, paths, pins, plants: plan, separateBlindPages: input.blind_second_pass.length };
}

export type RestrictedImport = Awaited<ReturnType<typeof prepareRestrictedReferenceImport>>;
