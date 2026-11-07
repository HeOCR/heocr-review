/** Import hocrgen's reference_audit_proposals.v1 into the generic model. */
import type { ImportBundle, TaskImporter } from "../import";
import { CATEGORY_EASE, CONFIDENCE_EASE, DECISIONS_DESCRIPTION, TASK_TYPE_ID, type ReferenceAuditPayload, type ReferenceAuditSource } from "./index";
import { proposalsFileProblems, type RaProposalsFile } from "./schema";

/** Only openly licensed text may be imported (Wikisource is CC BY-SA 4.0). */
const OPEN_LICENSE = /\b(CC BY-SA|CC BY|CC0|public domain)\b/i;

function ease(p: RaProposalsFile["proposals"][number]): (string | number)[] {
  const size = Math.max([...p.current].length, [...p.proposed].length);
  return [CONFIDENCE_EASE[p.confidence] ?? 9, CATEGORY_EASE[p.category] ?? 9, size > 12 ? 1 : 0, p.item_id, p.start];
}

function compare(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export const referenceAuditImporter: TaskImporter = {
  taskType: TASK_TYPE_ID,

  problems(raw: unknown): string[] {
    const problems = proposalsFileProblems(raw);
    if (problems.length) return problems;
    const file = raw as RaProposalsFile;
    if (!file.text_license || !OPEN_LICENSE.test(file.text_license)) {
      problems.push("text_license must name an open licence (CC BY-SA, CC BY, CC0 or public domain)");
    }
    return problems;
  },

  bundle(raw: unknown): ImportBundle {
    const file = raw as RaProposalsFile;
    const order = new Map(file.proposals.map((p, i) => [p.proposal_id, i]));
    const ranked = [...file.proposals].sort((a, b) => compare(ease(a), ease(b)));
    const source: ReferenceAuditSource = {
      schema_version: file.schema_version,
      audit_id: file.audit_id,
      decisions_description: DECISIONS_DESCRIPTION,
      text_license: file.text_license ?? null,
      checker: file.checker,
      proposed_at: file.proposed_at,
    };
    return {
      batch: {
        id: file.audit_id,
        taskType: TASK_TYPE_ID,
        title: "בדיקת טקסט ייחוס מול הסריקה (E2d4)",
        source: source as unknown as Record<string, unknown>,
      },
      items: file.pages
        .filter((page) => page.audit_status === "audited_with_findings")
        .map((page) => ({
          externalId: page.item_id,
          title: page.page_title ?? page.item_id,
          payload: {
            base_revision_id: page.base_revision_id,
            base_text_sha256: page.base_text_sha256,
            image_sha256: page.image_sha256 ?? null,
            audit_status: page.audit_status,
          },
          imageStem: page.item_id.includes(":") ? page.item_id.slice(page.item_id.indexOf(":") + 1) : page.item_id,
        })),
      proposals: ranked.map((p, rank) => {
        const payload: ReferenceAuditPayload = {
          start: p.start,
          end: p.end,
          current: p.current,
          proposed: p.proposed,
          context_before: p.context_before,
          context_after: p.context_after,
          note: p.note,
          page_box: p.region.box_normalized,
          order: order.get(p.proposal_id)!,
        };
        return {
          externalId: p.proposal_id,
          itemExternalId: p.item_id,
          category: p.category,
          confidence: p.confidence,
          rank,
          payload: payload as unknown as Record<string, unknown>,
          pageBox: p.region.box_normalized,
          contentKey: {
            item_id: p.item_id,
            start: p.start,
            end: p.end,
            current: p.current,
            proposed: p.proposed,
            context_before: p.context_before,
            context_after: p.context_after,
          },
        };
      }),
    };
  },
};
