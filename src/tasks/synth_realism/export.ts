import type { RealismTag, Side } from "../../shared/synth_realism";
import type { RealismItem } from "./schema";

export const EXPORT_FILE = "synth_realism_dev.json";
export const REALISM_EXPORT_SQL = `SELECT i.external_id AS item_id, i.generator_id, i.generator_version, i.params_hash,
  i.control_kind, t.reviewer_id AS reviewer, t.swapped, t.choice, t.chosen_at, t.latency_ms,
  t.score, t.tags_json, t.comment, t.completed_at
  FROM synth_realism_trials t JOIN synth_realism_items i ON i.id = t.item_id
  WHERE t.batch_id = ?1 AND t.choice IS NOT NULL ORDER BY t.chosen_at, t.id`;
export interface RealismRow {
  item_id: string; generator_id: string; generator_version: string; params_hash: string;
  control_kind: RealismItem["control_kind"]; reviewer: string; swapped: Side; choice: Side;
  chosen_at: number; latency_ms: number; score: number | null; tags_json: string | null;
  comment: string | null; completed_at: number | null;
}

/** Two-sided 95% Wilson score interval. */
export function wilson(successes: number, n: number): [number, number] {
  const z = 1.959963984540054;
  const p = successes / n;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom;
  return [successes === 0 ? 0 : Math.max(0, center - margin), successes === n ? 1 : Math.min(1, center + margin)];
}

export function realismExport(batchId: string, rows: RealismRow[], exportedAt: string, fixture: boolean) {
  const decisions = rows.map(({ swapped, tags_json, chosen_at, completed_at, ...row }) => ({
    ...row,
    real_side: row.control_kind === "real_real" ? null : swapped === 1 ? 0 : 1,
    correct: row.control_kind === "real_real" ? null : row.choice !== swapped,
    tags: tags_json ? JSON.parse(tags_json) as RealismTag[] : [],
    chosen_at: new Date(chosen_at).toISOString(),
    completed_at: completed_at === null ? null : new Date(completed_at).toISOString(),
  }));
  const groups = new Map<string, typeof decisions>();
  for (const d of decisions) {
    if (d.control_kind !== "standard") continue;
    const key = JSON.stringify([d.generator_id, d.generator_version]);
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }
  const generators = [...groups.values()].map((group) => {
    const { generator_id, generator_version } = group[0]!;
    const fooled = group.filter((d) => d.correct === false).length;
    const scores = group.flatMap((d) => d.score === null ? [] : [d.score]);
    const tag_counts: Partial<Record<RealismTag, number>> = {};
    for (const d of group) for (const tag of d.tags) tag_counts[tag] = (tag_counts[tag] ?? 0) + 1;
    return {
      generator_id, generator_version, choices: group.length, fooled, fooling_rate: fooled / group.length,
      wilson_95: wilson(fooled, group.length), scored: scores.length,
      mean_score: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
      tag_counts,
    };
  });
  const real = decisions.filter((d) => d.control_kind === "real_real");
  const attention = decisions.filter((d) => d.control_kind === "attention");
  return {
    schema: "synth_realism_dev.v1", purpose: "generator_development_only", fixture, batch_id: batchId, exported_at: exportedAt,
    decisions, generators: fixture ? [] : generators,
    controls: { real_real: {
      choices: real.length,
      rejected_left: real.filter((d) => d.choice === 1).length,
      rejected_right: real.filter((d) => d.choice === 0).length,
    },
      attention: { choices: attention.length, correct: attention.filter((d) => d.correct).length } },
  };
}
