import { wilson } from "../../src/tasks/synth_realism/export";
import { connectedArms, isRankingModality, type RankingModality } from "../../src/tasks/synth_realism/ranking";
import { RANKING_EXPORT_SCHEMA } from "../../src/tasks/synth_realism/ranking-export";
import { object, token } from "../../src/tasks/synth_realism/schema";

type Match = { left: string; right: string; pickedLeft: boolean };
type MatchIndex = { left: number; right: number; pickedLeft: boolean };

const priorSd = 2;
const precision = 1 / priorSd ** 2;
const z95 = 1.959963984540054;
const vector = (n: number) => new Float64Array(n);
const matrix = (n: number) => Array.from({ length: n }, () => vector(n));

function cholesky(input: Float64Array[]) {
  const lower = matrix(input.length);
  for (let i = 0; i < lower.length; i++) {
    for (let j = 0; j <= i; j++) {
      let value = input[i]![j]!;
      for (let k = 0; k < j; k++) value -= lower[i]![k]! * lower[j]![k]!;
      lower[i]![j] = i === j ? Math.sqrt(value) : value / lower[j]![j]!;
    }
  }
  return lower;
}

function solve(lower: Float64Array[], rhs: Float64Array) {
  const result = rhs.slice();
  for (let i = 0; i < result.length; i++) {
    let value = result[i]!;
    for (let j = 0; j < i; j++) value -= lower[i]![j]! * result[j]!;
    result[i] = value / lower[i]![i]!;
  }
  for (let i = result.length - 1; i >= 0; i--) {
    let value = result[i]!;
    for (let j = i + 1; j < result.length; j++) value -= lower[j]![i]! * result[j]!;
    result[i] = value / lower[i]![i]!;
  }
  return result;
}

function logPosterior(beta: Float64Array, matches: MatchIndex[]) {
  let total = beta.reduce((sum, b) => sum - precision * b * b / 2, 0);
  for (const { left, right, pickedLeft } of matches) {
    const d = beta[left]! - beta[right]!;
    const x = pickedLeft ? -d : d;
    total -= Math.max(0, x) + Math.log1p(Math.exp(-Math.abs(x)));
  }
  return total;
}

function derivatives(beta: Float64Array, matches: MatchIndex[]) {
  const gradient = beta.map(b => -precision * b);
  const information = matrix(beta.length);
  for (let i = 0; i < beta.length; i++) information[i]![i] = precision;
  for (const { left, right, pickedLeft } of matches) {
    const probability = 1 / (1 + Math.exp(beta[right]! - beta[left]!));
    const residual = Number(pickedLeft) - probability;
    const weight = probability * (1 - probability);
    gradient[left] = gradient[left]! + residual;
    gradient[right] = gradient[right]! - residual;
    information[left]![left] = information[left]![left]! + weight;
    information[right]![right] = information[right]![right]! + weight;
    information[left]![right] = information[left]![right]! - weight;
    information[right]![left] = information[right]![left]! - weight;
  }
  return { gradient, information };
}

function fitComponent(arms: string[], matches: Match[]) {
  const indices = new Map(arms.map((arm, i) => [arm, i]));
  const used = matches.flatMap(({ left, right, pickedLeft }) => {
    const i = indices.get(left), j = indices.get(right);
    return i === undefined || j === undefined ? [] : [{ left: i, right: j, pickedLeft }];
  });
  let beta = vector(arms.length);
  for (let iteration = 0; iteration < 100; iteration++) {
    const { gradient, information } = derivatives(beta, used);
    const lower = cholesky(information);
    if (gradient.every(g => Math.abs(g) < 1e-7)) {
      const mean = beta.reduce((sum, b) => sum + b, 0) / arms.length;
      const estimates = arms.map((arm, i) => {
        const unit = vector(arms.length);
        unit[i] = 1;
        const point = beta[i]! - mean;
        // The centered log-strength excludes the independent common-mean direction.
        const variance = solve(lower, unit)[i]! - 1 / (arms.length * precision);
        const margin = z95 * Math.sqrt(Math.max(0, variance));
        return { arm_id: arm, centered_log_strength: point, laplace_95: [point - margin, point + margin] };
      }).sort((a, b) => b.centered_log_strength - a.centered_log_strength || a.arm_id.localeCompare(b.arm_id));
      return { comparisons: used.length, arms: estimates };
    }
    const direction = solve(lower, gradient);
    const current = logPosterior(beta, used);
    let accepted = false;
    for (let step = 1; step >= 2 ** -24; step /= 2) {
      const proposed = beta.map((b, i) => b + step * direction[i]!);
      if (logPosterior(proposed, used) >= current - 1e-12) {
        beta = proposed;
        accepted = true;
        break;
      }
    }
    if (!accepted) break;
  }
  throw new Error("Bradley–Terry model did not converge");
}

export function fitRanking(raw: unknown) {
  if (!object(raw) || raw.schema !== RANKING_EXPORT_SCHEMA || !token(raw.batch_id) || !Array.isArray(raw.decisions)) {
    throw new Error("expected an authenticated ranking contribution export");
  }
  if (!object(raw.modality_by_arm) || !Object.keys(raw.modality_by_arm).length) {
    throw new Error("ranking export requires the pinned modality map");
  }
  const modalities = new Map<string, RankingModality>();
  for (const [arm, modality] of Object.entries(raw.modality_by_arm)) {
    if (!token(arm) || !isRankingModality(modality)) throw new Error("invalid arm modality");
    modalities.set(arm, modality);
  }
  const matches: Match[] = [];
  const seen = new Set<string>();
  let correct = 0, scored = 0, bothReal = 0, bothRealLeft = 0;
  for (const row of raw.decisions as unknown[]) {
    if (!object(row) || !token(row.pair_id) || !token(row.reviewer) ||
      (row.choice !== "left" && row.choice !== "right") ||
      (row.left_arm_id !== null && !token(row.left_arm_id)) || (row.right_arm_id !== null && !token(row.right_arm_id))) {
      throw new Error("invalid comparison row");
    }
    const key = JSON.stringify([row.reviewer, row.pair_id]);
    if (seen.has(key)) throw new Error("duplicate reviewer comparison");
    seen.add(key);
    const left = row.left_arm_id, right = row.right_arm_id, pickedLeft = row.choice === "left";
    if ((left !== null && !modalities.has(left)) || (right !== null && !modalities.has(right))) {
      throw new Error("missing modality for comparison arm");
    }
    if (left !== null && right !== null) {
      if (left === right || row.control !== "standard" || row.correct !== null) throw new Error("invalid standard pair");
      if (modalities.get(left) !== modalities.get(right)) throw new Error("ranking export contains a mixed-modality comparison");
      matches.push({ left, right, pickedLeft });
    } else if (left === null && right === null) {
      if (row.control !== "real_real" || row.correct !== null) throw new Error("invalid real/real control");
      bothReal++;
      bothRealLeft += Number(pickedLeft);
    } else {
      const hit = (pickedLeft ? left : right) === null;
      if (row.control !== "real_synth" || row.correct !== hit) throw new Error("invalid scored control");
      scored++;
      correct += Number(hit);
    }
  }
  const groups = connectedArms(matches.map(m => [m.left, m.right] as const));
  return {
    schema: "realism_ranking_bradley_terry.v1", batch_id: raw.batch_id, purpose: "generator_development_only",
    fixture: raw.fixture === true, model: "Bradley–Terry with independent Gaussian log-strength priors",
    prior_sd: priorSd, intervals: "Approximate model-based 95% Laplace intervals conditional on the reviewed roster",
    standard_pairs: matches.length,
    cross_component_ranks_identifiable: groups.length === 1 && groups[0]!.length === modalities.size,
    components: groups.map(group => ({ modality: modalities.get(group[0]!)!, ...fitComponent(group, matches) })),
    controls: {
      real_synth: { answered: scored, correct, accuracy: scored ? correct / scored : null, wilson_95: scored ? wilson(correct, scored) : null },
      real_real: { answered: bothReal, chose_left: bothRealLeft, chose_right: bothReal - bothRealLeft },
    },
  };
}
