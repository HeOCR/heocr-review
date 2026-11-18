/**
 * Import a line_verify_items.v1 or .v1.1 bundle (items.json and pages/) into the generic model. A v1.1 line listed in
 * `blind_second_pass` also gets a second proposal, `<item_id>@pass2`, gated like page_review's blind pass: it opens to
 * a reviewer 24 hours after a settled pass-1 answer (their own, or by the batch's pass2_reviewer setting another
 * reviewer's), is typed from a blank box (the candidate is never sent, nor the pre-check or attention spans), and
 * while it is open and undecided the reviewer's pass-1 line is closed to them.
 */
import type { Box } from "../../shared/media";
import type { ImportBundle, TaskImporter } from "../import";
import { TASK_TYPE_ID, blindListSha256, type LineVerifyPayload, type LineVerifySource } from "./index";
import { ITEMS_SCHEMA_V11, PASS2_SUFFIX, itemsFileProblems, type LvItem, type LvItemsFile, type LvPage, type PixelBox } from "./schema";

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
      ...(file.schema_version === ITEMS_SCHEMA_V11
        ? { blind_second_pass: { count: (file.blind_second_pass ?? []).length, sha256: blindListSha256(file.blind_second_pass ?? []) } }
        : {}),
    };
    const used = new Set(file.items.map((it) => it.page_id));
    const v11 = file.schema_version === ITEMS_SCHEMA_V11;
    const blind = new Set(file.blind_second_pass ?? []);
    // Pass 2 comes after every pass-1 line, in the same order; its gate decides when it opens.
    const sorted = [...file.items].sort(byRank);
    const passes = [...sorted.map((it) => ({ it, pass: 1 as const })), ...sorted.filter((it) => blind.has(it.item_id)).map((it) => ({ it, pass: 2 as const }))];
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
            ...(v11 ? { script: p.script } : {}),
          },
          imageStem: null,
          bundleImage: { path: p.image, sha256: p.sha256, width: p.width, height: p.height },
        })),
      proposals: passes.map(({ it, pass }, rank) => {
        const page = pages.get(it.page_id)!;
        const payload: LineVerifyPayload = {
          page_id: it.page_id,
          line_index: it.line_index,
          box: it.box,
          context_box: it.context_box,
          candidate_text: it.candidate_text,
          candidate_provenance: it.candidate_provenance,
          alignment_score: it.alignment_score,
          // The blind pass is unaided: no attention spans and no pre-check.
          attention_spans: pass === 2 ? [] : it.attention_spans,
          difficulty: it.difficulty,
          stratum: it.stratum,
          bundle_rank: it.rank,
          order: order.get(it.item_id)!,
          item_id: it.item_id,
          pass,
          blind: blind.has(it.item_id),
          precheck: pass === 1 && it.precheck?.likely_wrong ? { reasons: it.precheck.reasons } : null,
          page: {
            source: page.source,
            book_id: page.book_id,
            book_title: page.book_title,
            page_label: page.page_label,
            text_license: page.text_license,
            attribution: page.attribution,
            release_split: page.release_split,
            script: page.script ?? null,
            width: page.width,
            height: page.height,
            sha256: page.sha256,
          },
        };
        return {
          externalId: pass === 2 ? `${it.item_id}${PASS2_SUFFIX}` : it.item_id,
          itemExternalId: it.page_id,
          category: it.stratum,
          confidence: pass === 2 ? "blind_second_pass" : it.candidate_provenance,
          rank,
          payload: payload as unknown as Record<string, unknown>,
          pageBox: fraction(it.box, page),
          contextBox: fraction(it.context_box, page),
          ...(pass === 2 ? { gate: { kind: "after_confirm" as const, ref: it.item_id } } : {}),
          // A decision is on this text, this box and this scan: if any changes, earlier decisions become stale.
          contentKey: {
            item_id: it.item_id,
            page_id: it.page_id,
            page_sha256: page.sha256,
            box: it.box,
            context_box: it.context_box,
            candidate_text: it.candidate_text,
            // v1 lines keep their key (and so their decisions); a v1.1 line's key also says its pass and pre-check.
            ...(v11 ? { pass, precheck: pass === 1 ? (it.precheck ?? null) : null } : {}),
          },
        };
      }),
    };
  },
};
