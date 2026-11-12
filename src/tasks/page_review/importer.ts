/** Import eval's page review batch (batch_manifest.json, pages/, optional blind_prefill.json) into the generic model. */
import { sha256Hex } from "../../shared/sha256";
import type { ImportBundle, ImportProposal, TaskImporter } from "../import";
import { TASK_TYPE_ID, SERIES_LABELS, type PageReviewPayload, type PageReviewSource } from "./index";
import { manifestProblems, pageKey, prefillLines, type BlindFile, type Manifest, type ManifestPage } from "./schema";

/** The manifest schema is this batch's own; its id is the spec's (REVIEW_BATCH_SPEC.md). */
export const MIDCENTURY_BATCH_ID = "newprinted_midcentury_v0";
const BLIND_FILE = "blind_prefill.json";
const imageName = (p: ManifestPage) => `pages/${p.image.split("/").pop()!}`;

function title(p: ManifestPage): string {
  const series = SERIES_LABELS[p.series]?.he ?? p.series;
  const unit = (p.unit_id.split(":")[1] ?? p.unit_id).replace(`${p.series}_`, "");
  return `${series} ${unit} · עמ' ${p.page}`;
}

export const pageReviewImporter: TaskImporter = {
  taskType: TASK_TYPE_ID,
  bundleFile: "batch_manifest.json",
  sidecars: [BLIND_FILE],
  fullPages: true,

  problems(raw: unknown, sidecars?: Record<string, unknown>): string[] {
    const blind = sidecars?.[BLIND_FILE];
    const out = manifestProblems(raw, blind);
    if (blind && (blind as BlindFile).batch_id !== MIDCENTURY_BATCH_ID) out.push(`${BLIND_FILE}: batch_id must be ${MIDCENTURY_BATCH_ID}`);
    return out;
  },

  bundle(raw: unknown, sidecars?: Record<string, unknown>): ImportBundle {
    const file = raw as Manifest;
    const blind = sidecars?.[BLIND_FILE] as BlindFile | undefined;
    const blindByKey = new Map((blind?.pages ?? []).map((b) => [pageKey(b.unit_id, b.page), b]));
    const source: PageReviewSource = {
      schema_version: file.schema_version,
      batch_id: MIDCENTURY_BATCH_ID,
      split_sha256: file.split_sha256,
      fetch_manifest_sha256: file.fetch_manifest_sha256,
      manifest_sha256: blind?.manifest_sha256 ?? null,
      blind_rule: blind ? ((blind as unknown as Record<string, unknown>).rule as string | undefined) ?? null : null,
    };
    // Queue: test pages in the manifest's order (eval's hardest-first), then the reserves, then pass 2.
    const tests = file.pages.filter((p) => p.role === "test");
    const reserves = file.pages.filter((p) => p.role === "reserve");
    const passes: { page: ManifestPage; pass: 1 | 2 }[] = [
      ...tests.map((page) => ({ page, pass: 1 as const })),
      ...reserves.map((page) => ({ page, pass: 1 as const })),
      ...tests.filter((p) => p.blind_second_pass && blindByKey.has(pageKey(p.unit_id, p.page))).map((page) => ({ page, pass: 2 as const })),
    ];
    const proposals: ImportProposal[] = passes.map(({ page: p, pass }, order) => {
      const key = pageKey(p.unit_id, p.page);
      const b = pass === 2 ? blindByKey.get(key)! : null;
      const prefill = b ? b.blind_prefill : p.prefill;
      const lines = prefillLines(prefill, b ? [] : p.lines);
      const payload: PageReviewPayload = {
        unit_id: p.unit_id,
        page: p.page,
        stratum: p.stratum,
        series: p.series,
        role: p.role,
        pass,
        blind_second_pass: p.blind_second_pass,
        prefill_source: b ? b.blind_prefill_source : p.prefill_source,
        prefill_from_stock: b ? /stock/i.test(b.blind_prefill_source) : p.prefill_from_stock,
        prefill_sha256: sha256Hex(prefill),
        lines,
        reading_order_check: p.reading_order_check,
        difficulty: p.difficulty,
        node: p.node,
        image_sha256: p.image_sha256,
        source_pdf_sha256: p.source_pdf_sha256,
        order,
      };
      const externalId = pass === 2 ? `${key}@pass2` : key;
      return {
        externalId,
        itemExternalId: key,
        category: p.stratum,
        confidence: pass === 2 ? "blind_second_pass" : p.role,
        rank: order,
        payload: payload as unknown as Record<string, unknown>,
        pageBox: null,
        // A decision is on this scan, this pre-fill and these flags: if any changes, earlier decisions become stale.
        contentKey: { external_id: externalId, image_sha256: p.image_sha256, prefill_sha256: payload.prefill_sha256, lines, reading_order_check: p.reading_order_check },
        ...(pass === 2 ? { gate: { kind: "after_confirm" as const, ref: key } } : p.role === "reserve" ? { gate: { kind: "reserve" as const, ref: null } } : {}),
      };
    });
    return {
      batch: { id: MIDCENTURY_BATCH_ID, taskType: TASK_TYPE_ID, title: "תיקון עמודים: דפוס חדש, אמצע המאה / Page review: mid-century new print", source: source as unknown as Record<string, unknown> },
      items: file.pages.map((p) => ({
        externalId: pageKey(p.unit_id, p.page),
        title: title(p),
        payload: { unit_id: p.unit_id, page: p.page, stratum: p.stratum, series: p.series, role: p.role, image_sha256: p.image_sha256, node: p.node },
        imageStem: null,
        bundleImage: { path: imageName(p), sha256: p.image_sha256 },
      })),
      proposals,
    };
  },
};
