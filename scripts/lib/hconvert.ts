/**
 * HASH's registered H line boxes (h_line_items.v2, eval amendment 3) → a line_verify_items.v1.2 bundle of "type" items:
 * every line typed from scratch on the line screen, single reviewer, no candidate. Pure and deterministic: the same
 * inputs give a byte-identical items.json (eval re-runs it to ratify the bundle). Nothing is added to the boxes.
 */
export const H_V2_SHA256 = "abb35fe7aac52b87a9caa30f0c3a792f29086d13e93de7062e1ca83869191301";
export const H_EVAL_V1_MANIFEST_SHA256 = "63e9f31cfdd1987c17f02dbb5028ed9427a2e1d0993ac53625adb91226cbb642";
export const H_BATCH_ID = "h_eval_v1_lines";
/** Fixed, so the output never depends on the day it runs. */
export const H_CREATED_AT = "2026-11-20";

type Box = [number, number, number, number];
interface V2Line {
  id: string;
  i: number;
  box: Box;
}
interface V2Page {
  page_key: string;
  image: string;
  image_sha256: string;
  image_size: [number, number];
  segmenter: string;
  stratum: string;
  page_flag: string | null;
  lines: V2Line[];
}
interface ManifestRow {
  entry_id: string;
  title: string;
  holding_institution: string | null;
  holding_shelfmark: string | null;
  provider: string;
  source_id: string;
  source_url: string | null;
  license_expression: string;
  rights_basis: string;
  attribution: string | null;
  sequence: { label: string };
}

/** The line among its neighbours: the same width, about one and a half line heights above and below, in pixels. */
export function contextBox(box: Box, height: number): Box {
  const lh = box[3] - box[1];
  return [box[0], Math.max(0, Math.round(box[1] - 1.5 * lh)), box[2], Math.min(height, Math.round(box[3] + 1.5 * lh))];
}

const ext = (path: string) => (/\.(jpe?g|png|webp)$/i.exec(path)?.[0] ?? ".jpg").toLowerCase();

/** The bundle file name of a page's image (copied unchanged from HASH, so its sha256 is v2's). */
export const pageImageName = (p: { page_key: string; image: string }) => `pages/${p.page_key}${ext(p.image)}`;

export function convertH(v2: { schema: string; pages: V2Page[] }, manifest: ManifestRow[]): Record<string, unknown> {
  if (v2.schema !== "h_line_items.v2") throw new Error(`schema must be h_line_items.v2, not ${v2.schema}`);
  const rows = new Map(manifest.map((r) => [r.entry_id, r]));
  let rank = 0;
  const pages: Record<string, unknown>[] = [];
  const items: Record<string, unknown>[] = [];
  for (const p of v2.pages) {
    const m = rows.get(p.page_key);
    if (!m) throw new Error(`${p.page_key} is not in the h_eval_v1 manifest`);
    if (m.rights_basis !== "public_domain") throw new Error(`${p.page_key}: rights_basis ${m.rights_basis}, expected public_domain`);
    const lines = [...p.lines].sort((a, b) => a.i - b.i);
    lines.forEach((l, k) => {
      if (l.i !== k) throw new Error(`${p.page_key}: line order must run 0..n-1 (found ${l.i} at ${k})`);
    });
    const [width, height] = p.image_size;
    pages.push({
      page_id: p.page_key,
      image: pageImageName(p),
      sha256: p.image_sha256,
      width,
      height,
      source: "hash_eval",
      book_id: m.source_id,
      book_title: m.title,
      page_label: m.sequence.label,
      text_license: `Public domain (${m.license_expression})`,
      attribution: m.attribution ?? [m.title, [m.holding_institution, m.holding_shelfmark].filter(Boolean).join(", "), `via ${m.provider}`, m.source_url].filter(Boolean).join(". "),
      release_split: "test",
      script: "handwriting",
      segmenter: `h_line_items.v2 (${p.segmenter})`,
      kraken_lines: lines.length,
      book_group: p.stratum,
    });
    for (const l of lines) {
      items.push({
        item_id: `${p.page_key}#${l.id}`,
        page_id: p.page_key,
        line_index: l.i,
        box: l.box,
        context_box: contextBox(l.box, height),
        kind: "type",
        candidate_text: null,
        candidate_provenance: null,
        alignment_score: null,
        attention_spans: [],
        difficulty: 1,
        stratum: "random",
        rank: rank++,
      });
    }
  }
  return {
    schema_version: "line_verify_items.v1.2",
    batch_id: H_BATCH_ID,
    description: `h_eval_v1 handwriting, typed from scratch by one expert reviewer (single pass). Converted from HASH data/eval/h_line_items.v2 (sha256 ${H_V2_SHA256}, eval amendment 3) by heocr-review scripts/convert-h-line-items.ts: one type item per v2 line, item_id = page_key#v2 id, box = v2 box, line_index = v2 i. Box problems are answered per line (not_one_line, no_text, continued) and go to the next registered box version.`,
    created_at: H_CREATED_AT,
    generator: { tool: "heocr-review scripts/convert-h-line-items.ts", ref: "contrib" },
    blind_second_pass: [],
    pages,
    items,
  };
}
