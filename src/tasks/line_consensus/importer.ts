/**
 * Import the volunteer line batch: eval's registered line_items_v1.json (the bundle file) with its pages/, the
 * exclusions, the maintainer-decided record, Claude's hints (ai_flags.json) and, once registered, gold_v1.json.
 *
 * Queued: every line with a box (matched or fuzzy) on a page that is neither excluded nor decided by the maintainer;
 * a no_match line of those pages is imported for the maintainer only. Blank lines are not reviewed. Gold lines come
 * from pages volunteers are never given, each a proposal of its own page.
 */
import type { Box } from "../../shared/media";
import type { ImportBundle, ImportItem, ImportProposal, TaskImporter } from "../import";
import { SERIES_LABELS } from "../page_review/index";
import { BIDI_RISK } from "../page_review/schema";
import { TASK_TYPE_ID, type LineConsensusPayload, type LineConsensusSource } from "./index";
import {
  AI_FILE,
  BATCH_MANIFEST_SHA256,
  EXCLUSIONS_FILE,
  GOLD_FILE,
  LINE_ITEMS_FILE,
  MAINTAINER_FILE,
  REGISTERED_SHA256,
  VOLUNTEER_BATCH_ID,
  aiFlagsProblems,
  exclusionKeys,
  exclusionsProblems,
  goldPages,
  goldProblems,
  lineItemsProblems,
  maintainerDecidedProblems,
  type AiFlagsFile,
  type ExclusionsFile,
  type GoldFile,
  type LineItem,
  type LineItemsFile,
  type LinePage,
  type MaintainerDecidedFile,
  type PixelBox,
} from "./schema";

/** The SQL that gives every real line of a batch its first state (run with the import; existing rows are kept). */
export function initialStateSql(batchId: string, importedAt: string): string {
  const b = `'${batchId.replace(/'/g, "''")}'`;
  return `INSERT OR IGNORE INTO line_state (proposal_id, batch_id, state, needed, updated_at)
  SELECT id, batch_id,
    CASE WHEN json_extract(payload_json, '$.box_status') IN ('matched', 'fuzzy') THEN 'open' ELSE 'no_box' END,
    CASE WHEN json_extract(payload_json, '$.box_status') IN ('matched', 'fuzzy') THEN 2 ELSE 0 END,
    '${importedAt}'
  FROM proposals WHERE batch_id = ${b} AND json_extract(payload_json, '$.gold') IS NULL;`;
}

const imageName = (p: LinePage) => `pages/${p.image.split("/").pop()!}`;

/** The series of a page key: plenary:K10_125#p10 -> plenary; reshumot_scanned:kovetz_hatakanot_311#p6 -> kovetz_hatakanot. */
export function seriesOf(pageKey: string): string {
  const unit = pageKey.split("#")[0]!.split(":")[1] ?? "";
  if (pageKey.startsWith("plenary:")) return "plenary";
  return unit.replace(/_\d+$/, "");
}

function title(pageKey: string): string {
  const series = seriesOf(pageKey);
  const label = SERIES_LABELS[series]?.he ?? series;
  const [unit, page] = pageKey.split("#p");
  const id = (unit!.split(":")[1] ?? unit!).replace(`${series}_`, "");
  return `${label} ${id} · עמ' ${page}`;
}

/** The line's box as page fractions, and a context box a little more than a line above and below, clamped. */
export function boxes(box: PixelBox, size: [number, number]): { pageBox: Box; contextBox: Box } {
  const [w, h] = size;
  const [x0, y0, x1, y1] = box;
  const lineH = y1 - y0;
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  const r = (v: number) => Math.round(v * 10000) / 10000;
  const pageBox: Box = [r(x0 / w), r(y0 / h), r(x1 / w), r(y1 / h)];
  const padX = 0.02 * w;
  const contextBox: Box = [r(clamp(x0 - padX, w) / w), r(clamp(y0 - 1.2 * lineH, h) / h), r(clamp(x1 + padX, w) / w), r(clamp(y1 + 1.2 * lineH, h) / h)];
  return { pageBox, contextBox };
}

function aiIndex(ai: AiFlagsFile | undefined): Map<string, { flagged: Set<number>; missing: Set<number> }> {
  return new Map((ai?.pages ?? []).map((f) => [`${f.unit_id}#p${f.page}`, { flagged: new Set(f.flagged_i), missing: new Set(f.missing_near_i) }]));
}

export const lineConsensusImporter: TaskImporter = {
  taskType: TASK_TYPE_ID,
  bundleFile: LINE_ITEMS_FILE,
  sidecars: [EXCLUSIONS_FILE, MAINTAINER_FILE, AI_FILE, GOLD_FILE],
  registeredSha256: REGISTERED_SHA256,
  mustBeRegistered: [LINE_ITEMS_FILE, EXCLUSIONS_FILE, GOLD_FILE],
  // One reading-resolution image per page; the browser cuts each line from it (no file per line: 18,000 crops
  // would pass the static-asset file limit).
  fullPages: true,
  manifestSha256: BATCH_MANIFEST_SHA256,
  afterImportSql: (batchId: string, importedAt: string) => [initialStateSql(batchId, importedAt)],

  problems(raw: unknown, sidecars?: Record<string, unknown>): string[] {
    const out = lineItemsProblems(raw);
    const ex = sidecars?.[EXCLUSIONS_FILE];
    const md = sidecars?.[MAINTAINER_FILE];
    const ai = sidecars?.[AI_FILE];
    if (ex === undefined) out.push(`${EXCLUSIONS_FILE} is required: the pages never shown to volunteers`);
    else out.push(...exclusionsProblems(ex));
    if (md === undefined) out.push(`${MAINTAINER_FILE} is required: the pages the maintainer had decided at import (npm run maintainer-decided)`);
    else out.push(...maintainerDecidedProblems(md));
    if (ai === undefined) out.push(`${AI_FILE} is required: the registered hints, shown as on pass 1`);
    else out.push(...aiFlagsProblems(ai));
    if (out.length) return out;
    const file = raw as LineItemsFile;
    const pages = new Map(file.pages.map((p) => [p.page_key, p]));
    const excluded = new Set([...exclusionKeys(ex as ExclusionsFile), ...(md as MaintainerDecidedFile).pages]);
    for (const k of excluded) if (!pages.has(k)) out.push(`excluded page ${k} is not in ${LINE_ITEMS_FILE}`);
    const queued = new Set([...pages.keys()].filter((k) => !excluded.has(k)));
    if (queued.size === 0) out.push("no page is left for volunteers");
    const gold = sidecars?.[GOLD_FILE];
    if (gold !== undefined) out.push(...goldProblems(gold, pages, queued, goldPages(ex as ExclusionsFile)));
    return out;
  },

  bundle(raw: unknown, sidecars?: Record<string, unknown>, fileSha256?: Record<string, string>): ImportBundle {
    const file = raw as LineItemsFile;
    const ex = sidecars![EXCLUSIONS_FILE] as ExclusionsFile;
    const md = sidecars![MAINTAINER_FILE] as MaintainerDecidedFile;
    const ai = aiIndex(sidecars![AI_FILE] as AiFlagsFile);
    const gold = sidecars?.[GOLD_FILE] as GoldFile | undefined;
    const pages = new Map(file.pages.map((p) => [p.page_key, p]));
    const excluded = new Set([...exclusionKeys(ex), ...md.pages]);
    const queued = file.pages.filter((p) => !excluded.has(p.page_key));
    const items = new Map<string, ImportItem>();
    const item = (p: LinePage): void => {
      if (items.has(p.page_key)) return;
      items.set(p.page_key, {
        externalId: p.page_key,
        title: title(p.page_key),
        payload: { page_key: p.page_key, series: seriesOf(p.page_key), image_sha256: p.image_sha256 },
        imageStem: null,
        bundleImage: { path: imageName(p), sha256: p.image_sha256, width: p.image_size[0], height: p.image_size[1] },
      });
    };
    const proposals: ImportProposal[] = [];
    const add = (p: LinePage, line: LineItem, shown: { prefill: string; box: PixelBox | null }, g: LineConsensusPayload["gold"]): void => {
      item(p);
      const hints = ai.get(p.page_key);
      const payload: LineConsensusPayload = {
        page_key: p.page_key,
        i: line.i,
        prefill: shown.prefill,
        box_status: g ? "matched" : line.box_status,
        // A line with no flags entry (fewer than 4 Hebrew letters: page numbers, short headers) is tier A when it has a
        // digit or a bracket, as on the page review (page_review/schema.ts prefillLines, eval 2026-11-12).
        tier_a: line.tier_a ?? BIDI_RISK.test(shown.prefill),
        bidi_risk: line.bidi_risk ?? BIDI_RISK.test(shown.prefill),
        match: line.match,
        ai_flagged: hints ? hints.flagged.has(line.i) : null,
        ai_missing_near: hints ? hints.missing.has(line.i) : null,
        series: seriesOf(p.page_key),
        prefill_source: p.prefill_source,
        prefill_from_stock: p.prefill_from_stock,
        image_sha256: p.image_sha256,
        order: proposals.length,
        page_box: null,
        context_box: null,
        gold: g,
      };
      const externalId = `${p.page_key}#l${line.i}`;
      const b = shown.box ? boxes(shown.box, p.image_size) : null;
      payload.page_box = b?.pageBox ?? null;
      payload.context_box = b?.contextBox ?? null;
      proposals.push({
        externalId,
        itemExternalId: p.page_key,
        category: payload.series,
        confidence: g ? "matched" : line.box_status,
        rank: payload.order,
        payload: payload as unknown as Record<string, unknown>,
        pageBox: b?.pageBox ?? null,
        ...(b ? { contextBox: b.contextBox } : {}),
        // A decision is on this scan, this line's box, this pre-fill and these hints; the gold answer is kept out.
        contentKey: { external_id: externalId, image_sha256: p.image_sha256, box: shown.box, prefill: shown.prefill, tier_a: payload.tier_a, ai_flagged: payload.ai_flagged, ai_missing_near: payload.ai_missing_near },
      });
    };
    for (const p of queued) for (const line of p.lines) if (line.box_status !== "blank") add(p, line, { prefill: line.prefill, box: line.box }, null);
    for (const g of gold?.lines ?? []) {
      const p = pages.get(g.page_key)!;
      const line = p.lines.find((l) => l.i === g.i) ?? { i: g.i, prefill: g.prefill_shown, box: g.box, box_status: "matched" as const, match: null, tier_a: false, bidi_risk: false };
      add(p, line, { prefill: g.prefill_shown, box: g.box }, { gold_id: g.gold_id, answer: { action: g.answer.action, text: g.answer.text ?? null }, planted_error: g.planted_error });
    }
    const source: LineConsensusSource = {
      schema_version: file.schema,
      batch_id: VOLUNTEER_BATCH_ID,
      // Each input's sha256 as read (the import refuses unregistered ones); null for a file not given.
      sources: Object.fromEntries([LINE_ITEMS_FILE, EXCLUSIONS_FILE, MAINTAINER_FILE, AI_FILE, GOLD_FILE].map((n) => [n, fileSha256?.[n] ?? null])),
      maintainer_decided_excluded: { exported_at: md.exported_at, pages: [...md.pages].sort() },
    };
    return {
      batch: { id: VOLUNTEER_BATCH_ID, taskType: TASK_TYPE_ID, title: "בדיקת שורות: דפוס חדש, אמצע המאה / Line review: mid-century new print", source: source as unknown as Record<string, unknown> },
      items: [...items.values()],
      proposals,
    };
  },
};
