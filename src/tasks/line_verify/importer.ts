/** Import hocrgen's line_verify_items.v1 bundle (items.json and pages/) into the generic model. */
import type { Box } from "../../shared/media";
import type { ImportBundle, TaskImporter } from "../import";
import { TASK_TYPE_ID, type LineVerifyPayload, type LineVerifySource } from "./index";
import { itemsFileProblems, type LvItem, type LvItemsFile, type LvPage, type PixelBox } from "./schema";

const fraction = (box: PixelBox, page: LvPage): Box => {
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return [r(box[0] / page.width), r(box[1] / page.height), r(box[2] / page.width), r(box[3] / page.height)];
};

/** Queue order: the bundle's rank (lower first), ties by item_id so the order is deterministic. */
function byRank(a: LvItem, b: LvItem): number {
  return a.rank - b.rank || (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0);
}

export const lineVerifyImporter: TaskImporter = {
  taskType: TASK_TYPE_ID,
  bundleFile: "items.json",

  problems(raw: unknown): string[] {
    return itemsFileProblems(raw);
  },

  bundle(raw: unknown): ImportBundle {
    const file = raw as LvItemsFile;
    const pages = new Map(file.pages.map((p) => [p.page_id, p]));
    const order = new Map(file.items.map((it, i) => [it.item_id, i]));
    const source: LineVerifySource = {
      schema_version: file.schema_version,
      batch_id: file.batch_id,
      description: file.description ?? "",
      created_at: file.created_at,
      generator: file.generator,
    };
    const used = new Set(file.items.map((it) => it.page_id));
    return {
      batch: {
        id: file.batch_id,
        taskType: TASK_TYPE_ID,
        title: "אימות שורות מול הסריקה / Line verification",
        source: source as unknown as Record<string, unknown>,
      },
      items: file.pages
        .filter((p) => used.has(p.page_id))
        .map((p) => ({
          externalId: p.page_id,
          title: [p.book_title, p.page_label].filter(Boolean).join(" · ") || p.page_id,
          payload: {
            image_sha256: p.sha256,
            width: p.width,
            height: p.height,
            source: p.source,
            book_id: p.book_id,
            book_title: p.book_title,
            page_label: p.page_label,
            text_license: p.text_license,
            attribution: p.attribution,
            release_split: p.release_split,
          },
          imageStem: null,
          bundleImage: { path: p.image, sha256: p.sha256, width: p.width, height: p.height },
        })),
      proposals: [...file.items].sort(byRank).map((it, rank) => {
        const page = pages.get(it.page_id)!;
        const payload: LineVerifyPayload = {
          page_id: it.page_id,
          line_index: it.line_index,
          box: it.box,
          context_box: it.context_box,
          candidate_text: it.candidate_text,
          candidate_provenance: it.candidate_provenance,
          alignment_score: it.alignment_score,
          attention_spans: it.attention_spans,
          difficulty: it.difficulty,
          stratum: it.stratum,
          bundle_rank: it.rank,
          order: order.get(it.item_id)!,
          page: {
            source: page.source,
            book_id: page.book_id,
            book_title: page.book_title,
            page_label: page.page_label,
            text_license: page.text_license,
            attribution: page.attribution,
            release_split: page.release_split,
            width: page.width,
            height: page.height,
            sha256: page.sha256,
          },
        };
        return {
          externalId: it.item_id,
          itemExternalId: it.page_id,
          category: it.stratum,
          confidence: it.candidate_provenance,
          rank,
          payload: payload as unknown as Record<string, unknown>,
          pageBox: fraction(it.box, page),
          contextBox: fraction(it.context_box, page),
          // A decision is on this text, this box and this scan: if any changes, earlier decisions become stale.
          contentKey: {
            item_id: it.item_id,
            page_id: it.page_id,
            page_sha256: page.sha256,
            box: it.box,
            context_box: it.context_box,
            candidate_text: it.candidate_text,
          },
        };
      }),
    };
  },
};
