/**
 * line_verify P-hist gold (docs/specs/line_verify_phist_gold_v1_1.md): eval's registered gold file, its lines as
 * proposals of a `volunteer_v1_1` batch, the per-reviewer serving schedule, grading, and the second standing gate.
 * Pure: the Worker reads and writes D1 (src/worker/phist_gold.ts), scripts/import-gold.ts writes the SQL.
 */
import type { Box } from "../../shared/media";
import { isOpenLicence, OPEN_LICENCE_PROBLEM } from "../../shared/licence";
import { sha256Hex } from "../../shared/sha256";
import type { ImportItem, ImportProposal } from "../import";
import type { LineVerifyPayload } from "./index";
import { decisionValue, lineFoldV1 } from "./resolution";
import type { PixelBox } from "./schema";

export const PHIST_GOLD_SCHEMA = "phist_volunteer_gold.v1.1.1";
export const PHIST_GOLD_FILE = "phist_gold_v1_1_1.json";
/** heocr-restricted-eval#93, preregistration/phist_volunteer_gold_2026-11-19/SHA256SUMS. */
export const PHIST_GOLD_SHA256 = "08bdb75e62485cd9cd3a9597c56712f25d05cabd7dc0157aa97813f0981c6393";
/** v1.1 had no page metadata: superseded, refused. */
export const PHIST_GOLD_SUPERSEDED = ["phist_gold_v1_1.json"];

/** The second gate: at least this many graded (unpulled) P-hist gold decisions, at least this share of hits. */
export const PHIST_GOLD_MIN = 15;
export const PHIST_GOLD_FLOOR = 0.9;
/** Schedule: one gold line in each block of FRONT_BLOCK for a reviewer's first FRONT_LINES lines, then one per BLOCK. */
export const FRONT_LINES = 75;
export const FRONT_BLOCK = 5;
export const BLOCK = 15;

export interface GoldPage {
  page_id: string;
  source: string;
  book_id: string;
  book_title: string;
  page_label: string;
  text_license: string;
  attribution: string;
  image: string;
  sha256: string;
  width: number;
  height: number;
  release_split: string | null;
  script: string | null;
  book_group: string | null;
}

export interface GoldLine {
  gold_id: string;
  kind: "verify" | "type";
  page_key: string;
  i: number;
  box: PixelBox;
  image_sha256: string;
  prefill_shown: string | null;
  planted_error: null | Record<string, unknown>;
  answer: { action: string; text: string | null };
}

export interface GoldFile {
  schema: string;
  pages: Record<string, GoldPage>;
  gold: GoldLine[];
}

/** What a gold proposal's payload carries beyond a normal line's: never sent to the browser (toView picks fields). */
export interface GoldMark {
  gold_id: string;
  answer: { action: string; text: string | null };
  planted_error: null | Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isBox = (v: unknown): v is PixelBox => Array.isArray(v) && v.length === 4 && v.every((n) => Number.isFinite(n));
const SHA = /^[0-9a-f]{64}$/;

export function goldFileProblems(raw: unknown): string[] {
  if (!isObj(raw)) return [`${PHIST_GOLD_FILE} must be a JSON object`];
  if (raw.schema !== PHIST_GOLD_SCHEMA) return [`${PHIST_GOLD_FILE}: schema must be ${PHIST_GOLD_SCHEMA}`];
  const out: string[] = [];
  const pages = isObj(raw.pages) ? raw.pages : null;
  if (!pages) return [`${PHIST_GOLD_FILE}: pages must map page keys to pages`];
  for (const [key, p] of Object.entries(pages)) {
    const at = `page ${key}`;
    if (!isObj(p)) {
      out.push(`${at}: must be an object`);
      continue;
    }
    for (const f of ["page_id", "source", "book_id", "book_title", "page_label", "attribution", "image"]) if (!isStr(p[f])) out.push(`${at}: ${f} is required`);
    if (!isOpenLicence(p.text_license)) out.push(`${at}: ${OPEN_LICENCE_PROBLEM}`);
    if (!(typeof p.sha256 === "string" && SHA.test(p.sha256))) out.push(`${at}: sha256 must be a SHA-256`);
    if (!(Number.isInteger(p.width) && Number.isInteger(p.height) && (p.width as number) > 0 && (p.height as number) > 0)) out.push(`${at}: width and height are required`);
  }
  if (!Array.isArray(raw.gold) || raw.gold.length === 0) return [...out, `${PHIST_GOLD_FILE}: gold must be a non-empty list`];
  const ids = new Set<string>();
  const at = new Set<string>();
  for (const [k, g] of (raw.gold as unknown[]).entries()) {
    const label = `gold[${k}]`;
    if (!isObj(g)) {
      out.push(`${label}: must be an object`);
      continue;
    }
    if (!isStr(g.gold_id) || ids.has(g.gold_id)) out.push(`${label}: gold_id must be unique`);
    else ids.add(g.gold_id);
    if (g.kind !== "verify" && g.kind !== "type") out.push(`${label}: kind must be verify or type`);
    const page = isStr(g.page_key) && isObj(pages[g.page_key]) ? (pages[g.page_key] as Record<string, unknown>) : null;
    if (!page) out.push(`${label}: page_key must name a page in pages`);
    else if (g.image_sha256 !== page.sha256) out.push(`${label}: image_sha256 differs from its page's`);
    if (!Number.isInteger(g.i) || (g.i as number) < 0) out.push(`${label}: i must be a line index`);
    else if (page && at.has(`${g.page_key}#${g.i}`)) out.push(`${label}: two gold lines at the same line of a page`);
    else if (page) at.add(`${g.page_key}#${g.i}`);
    if (!isBox(g.box) || g.box[0] >= g.box[2] || g.box[1] >= g.box[3]) out.push(`${label}: box must be [x0, y0, x1, y1] with x0 < x1 and y0 < y1`);
    else if (page && (g.box[0] < 0 || g.box[1] < 0 || g.box[2] > (page.width as number) || g.box[3] > (page.height as number))) out.push(`${label}: box must lie on the page`);
    if (g.kind === "verify" && !isStr(g.prefill_shown)) out.push(`${label}: a verify line needs prefill_shown`);
    if (g.kind === "type" && g.prefill_shown !== null) out.push(`${label}: a type line has no prefill_shown`);
    const answer = isObj(g.answer) ? g.answer : null;
    if (!answer || answer.action !== "text" || !isStr(answer.text) || !lineFoldV1(answer.text as string)) out.push(`${label}: answer must be { action: "text", text } with letters`);
  }
  return out;
}

/** The line's context box by the P-hist bundles' rule: the line box widened by 1.5 line heights above and below. */
export function contextBoxOf(box: PixelBox, page: { width: number; height: number }): PixelBox {
  const h = box[3] - box[1];
  return [box[0], Math.max(0, Math.round(box[1] - 1.5 * h)), box[2], Math.min(page.height, Math.round(box[3] + 1.5 * h))];
}

const fraction = (box: PixelBox, page: { width: number; height: number }): Box => {
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return [r(box[0] / page.width), r(box[1] / page.height), r(box[2] / page.width), r(box[3] / page.height)];
};

/** Hebrew Wikisource is labelled as the P-hist bundles label it, so a gold line looks like any other. */
const SOURCE_AS = (s: string) => (s === "wikisource_proofread" ? "wikisource_he" : s);
/** Gold lines sit after every normal line; the normal queue never serves them (src/worker/queue.ts). */
export const GOLD_RANK_BASE = 1_000_000;

/** A gold line's proposal external id: like a normal line's (page id and line), never naming it gold. */
export const goldExternalId = (page: GoldPage, g: GoldLine) => `${page.page_id}#L${String(g.i).padStart(3, "0")}`;

/** The items (pages) and proposals (lines) a gold file adds to a batch. */
export function goldImport(file: GoldFile): { items: ImportItem[]; proposals: ImportProposal[] } {
  const used = new Set(file.gold.map((g) => g.page_key));
  const items: ImportItem[] = [...used].sort().map((key) => {
    const p = file.pages[key]!;
    return {
      externalId: p.page_id,
      title: [p.book_title, p.page_label].filter(Boolean).join(" · ") || p.page_id,
      payload: {
        image_sha256: p.sha256,
        width: p.width,
        height: p.height,
        source: SOURCE_AS(p.source),
        book_id: p.book_id,
        book_title: p.book_title,
        page_label: p.page_label,
        text_license: p.text_license,
        attribution: p.attribution,
        release_split: p.release_split,
        script: p.script,
        book_group: p.book_group,
      },
      imageStem: null,
      bundleImage: { path: p.image, sha256: p.sha256, width: p.width, height: p.height },
    };
  });
  const proposals: ImportProposal[] = file.gold.map((g, k) => {
    const page = file.pages[g.page_key]!;
    const id = goldExternalId(page, g);
    const context = contextBoxOf(g.box, page);
    const candidate = g.kind === "verify" ? g.prefill_shown! : "";
    const gold: GoldMark = { gold_id: g.gold_id, answer: g.answer, planted_error: g.planted_error };
    const payload: LineVerifyPayload & { gold: GoldMark } = {
      page_id: page.page_id,
      line_index: g.i,
      box: g.box,
      context_box: context,
      candidate_text: candidate,
      candidate_provenance: g.kind === "verify" ? "wikisource_quality4_validated" : "none",
      alignment_score: 0,
      attention_spans: [],
      difficulty: 0,
      stratum: "hard",
      bundle_rank: GOLD_RANK_BASE + k,
      order: GOLD_RANK_BASE + k,
      item_id: id,
      pass: 1,
      kind: g.kind,
      blind: false,
      precheck: null,
      page: {
        source: SOURCE_AS(page.source) as LineVerifyPayload["page"]["source"],
        book_id: page.book_id,
        book_title: page.book_title,
        page_label: page.page_label,
        text_license: page.text_license,
        attribution: page.attribution,
        // Dev pages: eval's file gives no split (null), as a bundle's page may.
        release_split: null,
        script: (page.script as LineVerifyPayload["page"]["script"]) ?? null,
        ...(page.book_group ? { book_group: page.book_group } : {}),
        width: page.width,
        height: page.height,
        sha256: page.sha256,
      },
      gold,
    };
    return {
      externalId: id,
      itemExternalId: page.page_id,
      category: "hard",
      confidence: g.kind === "type" ? "typed_line" : "wikisource_quality4_validated",
      rank: GOLD_RANK_BASE + k,
      payload: payload as unknown as Record<string, unknown>,
      pageBox: fraction(g.box, page),
      contextBox: fraction(context, page),
      contentKey: { gold_id: g.gold_id, page_sha256: page.sha256, box: g.box, context_box: context, candidate_text: candidate, kind: g.kind, answer: g.answer },
    };
  });
  return { items, proposals };
}

// ---------------------------------------------------------------------------------------------------------------
// Serving, grading and standing

/** The reviewer's schedule seed in [0, 1): the first 32 bits of sha256("phist_gold|" + reviewer_id). */
export const scheduleSeed = (reviewerId: string) => parseInt(sha256Hex(`phist_gold|${reviewerId}`).slice(0, 8), 16) / 2 ** 32;

/**
 * Whether the reviewer's n-th line (0-based; n counts their decisions in all volunteer_v1_1 batches, gold included)
 * is a gold line: one at a seeded offset in each block of FRONT_BLOCK while n < FRONT_LINES, then in each BLOCK.
 */
export function goldDue(n: number, seed: number): boolean {
  if (n < FRONT_LINES) return n % FRONT_BLOCK === Math.floor(seed * FRONT_BLOCK);
  return (n - FRONT_LINES) % BLOCK === Math.floor(seed * BLOCK);
}

/** The order in which a reviewer meets the gold lines: by sha256("phist_gold|" + reviewer_id + "|" + gold_id). */
export function goldOrder(reviewerId: string, goldIds: string[]): string[] {
  return goldIds
    .map((g) => [sha256Hex(`phist_gold|${reviewerId}|${g}`), g] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, g]) => g);
}

/** A gold decision is a hit when its v1 agreement value equals the answer's (line_fold_v1); non-text answers miss. */
export function goldHit(d: { value: string; text: string | null }, candidate: string, kind: "verify" | "type", answer: GoldMark["answer"]): boolean {
  let value: string;
  try {
    value = decisionValue(d, candidate, kind);
  } catch {
    return false;
  }
  return value === `text\u0000${lineFoldV1(answer.text ?? "")}`;
}

export type PhistReason = "fewer_than_15_phist_gold" | "below_phist_floor";

/** The second gate's verdict from a reviewer's graded, unpulled gold decisions: null when they count. */
export function phistReason(graded: number, hits: number): PhistReason | null {
  if (graded < PHIST_GOLD_MIN) return "fewer_than_15_phist_gold";
  return hits / graded >= PHIST_GOLD_FLOOR ? null : "below_phist_floor";
}
