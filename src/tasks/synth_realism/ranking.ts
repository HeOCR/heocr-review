import type { BatchRecord } from "../types";
import { clearanceReferences, isSha, object, token, validImage, type ImageFile } from "./schema";

export const RANKING_SCHEMA = "realism_ranking_manifest.v1";
export const RANKING_MODALITIES_SCHEMA = "realism_ranking_modalities.v1";
export const RANKING_LIMIT = 200;
export const RANKING_MODALITIES = ["scan", "phone"] as const;
export type RankingModality = (typeof RANKING_MODALITIES)[number];

export function isRankingModality(value: unknown): value is RankingModality {
  return value === "scan" || value === "phone";
}

export const isRealismRanking = (batch: BatchRecord) => batch.source.realism_mode === "ranking";

interface RankingImage extends ImageFile {
  item_id: string;
  arm_id: string | null;
  real_ref_id?: string;
}

export interface RankingManifest {
  schema: typeof RANKING_SCHEMA;
  batch_id: string;
  title: string;
  images: RankingImage[];
  pairs: { pair_id: string; item_a: string; item_b: string }[];
}

export function connectedArms(edges: readonly (readonly [string, string])[]): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const [a, b] of edges) {
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a)!.add(b);
    graph.get(b)!.add(a);
  }
  const components: string[][] = [];
  const checked = new Set<string>();
  for (const arm of [...graph.keys()].sort()) {
    if (checked.has(arm)) continue;
    const component = [arm];
    checked.add(arm);
    for (const member of component) {
      for (const neighbor of graph.get(member)!) {
        if (!checked.has(neighbor)) {
          component.push(neighbor);
          checked.add(neighbor);
        }
      }
    }
    components.push(component.sort());
  }
  return components;
}

export function parseRankingManifest(raw: unknown, clearance: unknown): RankingManifest {
  if (!object(raw) || raw.schema !== RANKING_SCHEMA || !token(raw.batch_id) ||
    typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > 160 ||
    !Array.isArray(raw.images) || raw.images.length > 2 * RANKING_LIMIT ||
    !Array.isArray(raw.pairs) || raw.pairs.length < 2 || raw.pairs.length > RANKING_LIMIT) {
    throw new Error("invalid ranking manifest header or session size");
  }
  const refs = clearanceReferences(clearance);
  const realAssets = new Set([...refs.values()].flatMap(ref => [ref.page_sha256, ref.line_sha256]));
  const images = new Map<string, RankingImage>();
  const hashes = new Set<string>();
  for (const image of raw.images as unknown[]) {
    if (!object(image) || !token(image.item_id) || images.has(image.item_id) ||
      (image.arm_id !== null && !token(image.arm_id)) || !validImage(image) || hashes.has(image.sha256)) {
      throw new Error("invalid or duplicate ranking image");
    }
    const row = image as unknown as RankingImage;
    if (row.arm_id === null) {
      const ref = token(row.real_ref_id) && refs.get(row.real_ref_id);
      if (!ref || ref.split !== "train" || ref.page_sha256 !== row.sha256) {
        throw new Error("ranking real control requires a hash-matched cleared TRAIN page");
      }
    } else if (row.real_ref_id !== undefined || realAssets.has(row.sha256)) {
      throw new Error("a synthetic ranking image contains a genuine reference");
    }
    images.set(row.item_id, row);
    hashes.add(row.sha256);
  }
  const pairs = new Set<string>();
  const pairIds = new Set<string>();
  const used = new Set<string>();
  const edges: [string, string][] = [];
  let scoredControls = 0;
  for (const pair of raw.pairs as unknown[]) {
    if (!object(pair) || !token(pair.pair_id) || pairIds.has(pair.pair_id) || !token(pair.item_a) ||
      !token(pair.item_b) || pair.item_a === pair.item_b) throw new Error("invalid ranking pair");
    const a = images.get(pair.item_a), b = images.get(pair.item_b);
    const key = [pair.item_a, pair.item_b].sort().join(":");
    if (!a || !b || pairs.has(key)) throw new Error("missing or repeated ranking pair");
    pairs.add(key);
    pairIds.add(pair.pair_id);
    used.add(pair.item_a);
    used.add(pair.item_b);
    if (a.arm_id !== null && b.arm_id !== null) {
      if (a.arm_id === b.arm_id) throw new Error("synthetic pairs must compare different arms");
      edges.push([a.arm_id, b.arm_id]);
    } else if (a.arm_id !== b.arm_id) scoredControls++;
  }
  const components = connectedArms(edges);
  const arms = new Set([...images.values()].flatMap(image => image.arm_id === null ? [] : [image.arm_id]));
  const compared = components.reduce((sum, component) => sum + component.length, 0);
  if (!compared || compared !== arms.size || used.size !== images.size || !scoredControls) {
    throw new Error("ranking requires cross-arm comparisons for every arm, no unused images and at least one scored control");
  }
  return raw as unknown as RankingManifest;
}

/** The private sidecar attests to the modality of each exact image in the pinned manifest. */
export function validateRankingModalities(manifest: RankingManifest, manifestPin: string, raw: unknown) {
  if (!object(raw) || raw.schema !== RANKING_MODALITIES_SCHEMA || !isSha(manifestPin) ||
    raw.manifest_sha256 !== manifestPin || !object(raw.items) || Object.keys(raw.items).length !== manifest.images.length) {
    throw new Error("invalid ranking modality sidecar or manifest pin");
  }
  const items = new Map<string, RankingModality>();
  const arms = new Map<string, RankingModality>();
  const imageArms = new Map<string, string | null>();
  for (const { item_id, arm_id } of manifest.images) {
    const modality = Object.hasOwn(raw.items, item_id) ? raw.items[item_id] : undefined;
    if (!isRankingModality(modality)) throw new Error("ranking modality sidecar must label every image");
    items.set(item_id, modality);
    imageArms.set(item_id, arm_id);
    if (arm_id !== null) {
      const prior = arms.get(arm_id);
      if (prior && prior !== modality) throw new Error("ranking arm spans multiple modalities");
      arms.set(arm_id, modality);
    }
  }
  const edges: Record<RankingModality, [string, string][]> = { scan: [], phone: [] };
  const pairCounts = { scan: 0, phone: 0 };
  for (const { item_a, item_b } of manifest.pairs) {
    const modality = items.get(item_a)!;
    if (modality !== items.get(item_b)) throw new Error("ranking pair mixes scan and phone");
    pairCounts[modality]++;
    const a = imageArms.get(item_a), b = imageArms.get(item_b);
    if (a != null && b != null) edges[modality].push([a, b]);
  }
  const counts = RANKING_MODALITIES.flatMap(modality => {
    if (!pairCounts[modality]) return [];
    const components = connectedArms(edges[modality]);
    if (components.length !== 1) throw new Error("ranking requires one connected synthetic graph per modality");
    return [{ modality, arms: components[0]!.length, pairs: pairCounts[modality], standard: edges[modality].length }];
  });
  return { armModalities: Object.fromEntries(arms), counts };
}
