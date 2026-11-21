import type { Side } from "../../shared/synth_realism";

export const RANKING_EXPORT_FILE = "realism_ranking_cc0.json";
export const RANKING_EXPORT_SCHEMA = "realism_ranking_contributions.v1";
export const RANKING_EXPORT_SQL = `SELECT p.pair_id, p.item_a, p.arm_a, p.item_b, p.arm_b,
  a.reviewer_id AS reviewer, a.swapped, a.choice, a.latency_ms, a.chosen_at
  FROM synth_ranking_answers a JOIN synth_ranking_pairs p ON p.batch_id=a.batch_id AND p.position=a.position
  WHERE a.batch_id=?1 AND a.choice IS NOT NULL ORDER BY a.reviewer_id, a.position`;

export interface RankingRow {
  pair_id: string;
  item_a: string;
  arm_a: string | null;
  item_b: string;
  arm_b: string | null;
  reviewer: string;
  swapped: Side;
  choice: Side;
  latency_ms: number;
  chosen_at: number;
}

export function rankingExport(batchId: string, rows: RankingRow[], exportedAt: string, fixture: boolean, armModalities: unknown) {
  return {
    schema: RANKING_EXPORT_SCHEMA, purpose: "generator_development_only", fixture, batch_id: batchId, exported_at: exportedAt,
    license: "CC0-1.0", license_scope: "reviewer_contributions_only",
    modality_by_arm: armModalities ?? null,
    decisions: rows.map(row => {
      const [leftItem, rightItem] = row.swapped ? [row.item_b, row.item_a] : [row.item_a, row.item_b];
      const [leftArm, rightArm] = row.swapped ? [row.arm_b, row.arm_a] : [row.arm_a, row.arm_b];
      const control = leftArm !== null && rightArm !== null ? "standard" : leftArm === rightArm ? "real_real" : "real_synth";
      const choice = row.choice === 0 ? "left" : "right";
      return {
        pair_id: row.pair_id, left_item_id: leftItem, right_item_id: rightItem, left_arm_id: leftArm, right_arm_id: rightArm,
        choice, reviewer: row.reviewer, latency_ms: row.latency_ms, chosen_at: new Date(row.chosen_at).toISOString(),
        control, correct: control === "real_synth" ? (row.choice === 0 ? leftArm : rightArm) === null : null,
      };
    }),
  };
}
