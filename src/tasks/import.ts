/** What a task-type importer turns a source file into, before media and SQL. Pure: no I/O. */
import type { Box } from "../shared/media";

export interface ImportItem {
  externalId: string;
  title: string;
  payload: Record<string, unknown>;
  /** The page image's file stem in the pages directory, if the item has one. */
  imageStem: string | null;
  /**
   * The page image shipped inside the bundle itself, with its checksum and declared pixel size (line_verify), or
   * without a declared size (page_review, whose pages are shown whole and at reading resolution).
   */
  bundleImage?: { path: string; sha256: string; width?: number; height?: number };
}

export interface ImportProposal {
  externalId: string;
  itemExternalId: string;
  category: string;
  confidence: string;
  rank: number;
  payload: Record<string, unknown>;
  /** The region in page coordinates (fractions), for the crop. */
  pageBox: Box | null;
  /** A wider region (fractions) to cut around pageBox, when the source defines one (line_verify's context_box). */
  contextBox?: Box;
  /** The fields a decision depends on; their hash pins every decision to the content the reviewer saw. */
  contentKey: unknown;
  /** Served only once a condition holds (migrations/0002_proposal_gates.sql); absent: always open. */
  gate?: ProposalGate;
}

export type ProposalGate = { kind: "reserve"; ref: null } | { kind: "after_confirm"; ref: string };

export interface ImportBundle {
  batch: { id: string; taskType: string; title: string; source: Record<string, unknown> };
  items: ImportItem[];
  proposals: ImportProposal[];
}

export interface TaskImporter {
  taskType: string;
  /** The source file's name inside a bundle directory (--bundle). */
  bundleFile: string;
  /** Problems with the source file (empty when valid). */
  problems(raw: unknown, sidecars?: Record<string, unknown>): string[];
  bundle(raw: unknown, sidecars?: Record<string, unknown>): ImportBundle;
  /** Further files the bundle may hold next to bundleFile, parsed and passed in by name (absent ones are left out). */
  sidecars?: string[];
  /** Show each page whole at reading resolution, with no line crops (page_review). */
  fullPages?: boolean;
}

/** Deterministic JSON (sorted keys) for hashing. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
