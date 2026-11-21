import { wilson } from "../../src/tasks/synth_realism/export";
import { connectedArms, isRankingModality, type RankingModality } from "../../src/tasks/synth_realism/ranking";
import { RANKING_EXPORT_SCHEMA } from "../../src/tasks/synth_realism/ranking-export";
import { object, token } from "../../src/tasks/synth_realism/schema";

type Outcome = "left" | "right" | "tie";
type Match = { left: string; right: string; choice: Outcome; tieAvailable: boolean };
type MatchIndex = { left: number; right: number; outcome: number; tieAvailable: boolean };

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

function outcomeWeights(beta: Float64Array, { left, right, tieAvailable }: MatchIndex, tieIndex: number | null) {
  // Divide Davidson's weights by the geometric mean of the two arm strengths.
  const halfDifference = (beta[left]! - beta[right]!) / 2;
  const logits = [halfDifference, -halfDifference, tieIndex !== null && tieAvailable ? beta[tieIndex]! : -Infinity];
  const offset = Math.max(...logits);
  const weights = logits.map(logit => Math.exp(logit - offset));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return { logits, offset, weights, total };
}

function logPosterior(beta: Float64Array, matches: MatchIndex[], tieIndex: number | null) {
  let total = beta.reduce((sum, b) => sum - precision * b * b / 2, 0);
  for (const match of matches) {
    const weights = outcomeWeights(beta, match, tieIndex);
    total += weights.logits[match.outcome]! - weights.offset - Math.log(weights.total);
  }
  return total;
}

function derivatives(beta: Float64Array, matches: MatchIndex[], tieIndex: number | null) {
  const gradient = beta.map(b => -precision * b);
  const information = matrix(beta.length);
  for (let i = 0; i < beta.length; i++) information[i]![i] = precision;
  for (const match of matches) {
    const { left, right, outcome } = match;
    const { weights, total } = outcomeWeights(beta, match, tieIndex);
    const pLeft = weights[0]! / total, pRight = weights[1]! / total, pTie = weights[2]! / total;
    // The arm-difference features for left, right and tie are +1/2, -1/2 and 0.
    const mean = (pLeft - pRight) / 2;
    const residual = (outcome === 0 ? 0.5 : outcome === 1 ? -0.5 : 0) - mean;
    const weight = (pLeft + pRight) / 4 - mean ** 2;
    gradient[left] = gradient[left]! + residual;
    gradient[right] = gradient[right]! - residual;
    information[left]![left] = information[left]![left]! + weight;
    information[right]![right] = information[right]![right]! + weight;
    information[left]![right] = information[left]![right]! - weight;
    information[right]![left] = information[right]![left]! - weight;
    if (tieIndex !== null && match.tieAvailable) {
      gradient[tieIndex] = gradient[tieIndex]! + Number(outcome === 2) - pTie;
      information[tieIndex]![tieIndex] = information[tieIndex]![tieIndex]! + pTie * (1 - pTie);
      const covariance = -mean * pTie;
      information[left]![tieIndex] = information[left]![tieIndex]! + covariance;
      information[tieIndex]![left] = information[tieIndex]![left]! + covariance;
      information[right]![tieIndex] = information[right]![tieIndex]! - covariance;
      information[tieIndex]![right] = information[tieIndex]![right]! - covariance;
    }
  }
  return { gradient, information };
}

function fitComponent(arms: string[], matches: Match[]) {
  const indices = new Map(arms.map((arm, i) => [arm, i]));
  const used = matches.flatMap(({ left, right, choice, tieAvailable }) => {
    const i = indices.get(left), j = indices.get(right);
    return i === undefined || j === undefined ? [] : [
      { left: i, right: j, outcome: choice === "left" ? 0 : choice === "right" ? 1 : 2, tieAvailable },
    ];
  });
  const ties = used.filter(m => m.outcome === 2).length;
  const tieIndex = ties ? arms.length : null;
  let beta = vector(arms.length + Number(tieIndex !== null));
  for (let iteration = 0; iteration < 100; iteration++) {
    const { gradient, information } = derivatives(beta, used, tieIndex);
    const lower = cholesky(information);
    if (gradient.every(g => Math.abs(g) < 1e-7)) {
      const mean = beta.subarray(0, arms.length).reduce((sum, b) => sum + b, 0) / arms.length;
      const estimates = arms.map((arm, i) => {
        const unit = vector(beta.length);
        unit[i] = 1;
        const point = beta[i]! - mean;
        // The centered log-strength excludes the independent common-mean direction.
        const variance = solve(lower, unit)[i]! - 1 / (arms.length * precision);
        const margin = z95 * Math.sqrt(Math.max(0, variance));
        return { arm_id: arm, centered_log_strength: point, laplace_95: [point - margin, point + margin] };
      }).sort((a, b) => b.centered_log_strength - a.centered_log_strength || a.arm_id.localeCompare(b.arm_id));
      return { model: tieIndex === null ? "bradley_terry" : "davidson", comparisons: used.length, ties,
        tie_log_propensity: tieIndex === null ? null : beta[tieIndex]!, arms: estimates };
    }
    const direction = solve(lower, gradient);
    const current = logPosterior(beta, used, tieIndex);
    let accepted = false;
    for (let step = 1; step >= 2 ** -24; step /= 2) {
      const proposed = beta.map((b, i) => b + step * direction[i]!);
      if (logPosterior(proposed, used, tieIndex) >= current - 1e-12) {
        beta = proposed;
        accepted = true;
        break;
      }
    }
    if (!accepted) break;
  }
  throw new Error("Ranking model did not converge");
}

function tieCounts(answered: number, eligible: number, ties: number) {
  return { answered, tie_eligible: eligible, ties, tie_rate: eligible ? ties / eligible : null };
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
  const pairTies = new Map<string, { arm_a: string; arm_b: string; answered: number; eligible: number; ties: number }>();
  const seen = new Set<string>();
  let correct = 0, realSynth = 0, realSynthEligible = 0, realSynthTies = 0;
  let bothReal = 0, bothRealEligible = 0, bothRealLeft = 0, bothRealTies = 0;
  for (const row of raw.decisions as unknown[]) {
    if (!object(row) || !token(row.pair_id) || !token(row.reviewer) ||
      (row.choice !== "left" && row.choice !== "right" && row.choice !== "tie") ||
      (row.tie_available !== undefined && typeof row.tie_available !== "boolean") ||
      (row.choice === "tie" && row.tie_available !== true) ||
      (row.left_arm_id !== null && !token(row.left_arm_id)) || (row.right_arm_id !== null && !token(row.right_arm_id))) {
      throw new Error("invalid comparison row");
    }
    const key = JSON.stringify([row.reviewer, row.pair_id]);
    if (seen.has(key)) throw new Error("duplicate reviewer comparison");
    seen.add(key);
    const left = row.left_arm_id, right = row.right_arm_id, choice = row.choice;
    const tie = choice === "tie";
    const tieAvailable = row.tie_available === true;
    if ((left !== null && !modalities.has(left)) || (right !== null && !modalities.has(right))) {
      throw new Error("missing modality for comparison arm");
    }
    if (left !== null && right !== null) {
      if (left === right || row.control !== "standard" || row.correct !== null) throw new Error("invalid standard pair");
      if (modalities.get(left) !== modalities.get(right)) throw new Error("ranking export contains a mixed-modality comparison");
      matches.push({ left, right, choice, tieAvailable });
      const [a, b] = [left, right].sort() as [string, string];
      const pair = JSON.stringify([a, b]);
      const counts = pairTies.get(pair) ?? { arm_a: a, arm_b: b, answered: 0, eligible: 0, ties: 0 };
      counts.answered++;
      counts.eligible += Number(tieAvailable);
      counts.ties += Number(tie);
      pairTies.set(pair, counts);
    } else if (left === null && right === null) {
      if (row.control !== "real_real" || row.correct !== null) throw new Error("invalid real/real control");
      bothReal++;
      bothRealEligible += Number(tieAvailable);
      bothRealLeft += Number(choice === "left");
      bothRealTies += Number(tie);
    } else {
      const hit = tie ? null : (choice === "left" ? left : right) === null;
      if (row.control !== "real_synth" || row.correct !== hit) throw new Error("invalid scored control");
      realSynth++;
      realSynthEligible += Number(tieAvailable);
      correct += Number(hit);
      realSynthTies += Number(tie);
    }
  }
  const groups = connectedArms(matches.map(m => [m.left, m.right] as const));
  const decisive = realSynth - realSynthTies;
  return {
    schema: "realism_ranking_bradley_terry.v1", batch_id: raw.batch_id, purpose: "generator_development_only",
    fixture: raw.fixture === true, model: "Bradley–Terry and Davidson with independent Gaussian parameter priors",
    prior_sd: priorSd, intervals: "Approximate model-based 95% Laplace intervals conditional on the reviewed roster",
    standard_pairs: matches.length,
    cross_component_ranks_identifiable: groups.length === 1 && groups[0]!.length === modalities.size,
    components: groups.map(group => ({ modality: modalities.get(group[0]!)!, ...fitComponent(group, matches) })),
    arm_pair_ties: [...pairTies.values()].sort((a, b) => a.arm_a.localeCompare(b.arm_a) || a.arm_b.localeCompare(b.arm_b))
      .map(({ arm_a, arm_b, answered, eligible, ties }) =>
        ({ modality: modalities.get(arm_a)!, arm_a, arm_b, ...tieCounts(answered, eligible, ties) })),
    controls: {
      overall: tieCounts(realSynth + bothReal, realSynthEligible + bothRealEligible, realSynthTies + bothRealTies),
      real_synth: { ...tieCounts(realSynth, realSynthEligible, realSynthTies), decisive, correct, accuracy: decisive ? correct / decisive : null,
        wilson_95: decisive ? wilson(correct, decisive) : null },
      real_real: { ...tieCounts(bothReal, bothRealEligible, bothRealTies),
        chose_left: bothRealLeft, chose_right: bothReal - bothRealLeft - bothRealTies },
    },
  };
}
