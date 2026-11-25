/**
 * The daily ops health report: read-only and counts only (docs/runbooks/ops-health.md).
 *
 *   npm run ops-health -- [--target local|production --yes-production] [--json]
 *
 * It never writes: one batch of SELECT COUNT(*) statements on D1, signed-out GETs on the canonical host, the account's
 * D1 analytics, and (production, PH1 on) the operator export, of which it keeps only the photo and recompressed counts.
 * It prints no names, no text, no hashes of uploads and no credential.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, target, type Target } from "./lib/args";
import { todayRowsWritten } from "./lib/d1budget";
import { d1Query, loadCredentials } from "./lib/wrangler";

const HOST = "https://review.heocr.org";
const LOCAL = "http://127.0.0.1:8787";
const PH1_TOKEN = join(homedir(), ".config", "heocr", "heocr-review-ph1-operator.token");

/** Every contributor / handwriting table, by name, with its row count. */
export const CONTRIBUTOR_TABLES_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'contributor%' OR name LIKE 'handwriting%') AND name NOT LIKE '%\\_new' ESCAPE '\\' ORDER BY name";

/** Per triage batch: lines, answered, waiting for the desktop ("different", or any triage answer on a plant), plants. */
export const TRIAGE_SQL = `SELECT b.id, b.status,
  (SELECT COUNT(*) FROM proposals p WHERE p.batch_id = b.id AND p.active = 1 AND COALESCE(json_extract(p.payload_json, '$.pass'), 1) = 1) AS lines,
  (SELECT COUNT(DISTINCT d.proposal_id) FROM decisions d JOIN proposals p ON p.id = d.proposal_id
    WHERE p.batch_id = b.id AND p.active = 1 AND d.superseded_at IS NULL AND d.value <> 'different'
      AND NOT (d.value IN ('correct', 'niqqud_mismatch') AND EXISTS (SELECT 1 FROM triage_plants tp WHERE tp.proposal_id = d.proposal_id))) AS answered,
  (SELECT COUNT(DISTINCT d.proposal_id) FROM decisions d JOIN proposals p ON p.id = d.proposal_id
    WHERE p.batch_id = b.id AND p.active = 1 AND d.superseded_at IS NULL AND (d.value = 'different'
      OR (d.value IN ('correct', 'niqqud_mismatch') AND EXISTS (SELECT 1 FROM triage_plants tp WHERE tp.proposal_id = d.proposal_id)))) AS to_desktop,
  (SELECT COUNT(*) FROM triage_plants tp WHERE tp.batch_id = b.id) AS plants
  FROM batches b JOIN batch_settings s ON s.batch_id = b.id WHERE s.mode = 'triage' ORDER BY b.id`;

export interface Health {
  at: string;
  target: Target;
  contributor_app: "on" | "off" | "unknown";
  ph1: "on" | "off" | "unknown";
  ph1_photos: number | null;
  ph1_recompressed: number | null;
  handwriting: Record<string, number>;
  triage: { batch: string; status: string; lines: number; answered: number; to_desktop: number; plants: number }[];
  decisions: number;
  d1_rows_written_today: number | null;
}

/** 401 signed out = the contributor app answers (on); 404 = off (src/worker/contributor/index.ts). */
export const appState = (status: number): "on" | "off" | "unknown" => (status === 401 ? "on" : status === 404 ? "off" : "unknown");
export const ph1State = (status: number): "on" | "off" | "unknown" => (status === 200 ? "on" : status === 404 || status === 403 ? "off" : "unknown");

/** The one-liner for the lead. */
export function oneLine(h: Health): string {
  const hw = h.handwriting;
  const tri = h.triage.map((t) => `${t.batch} ${t.answered}/${t.lines} (desk ${t.to_desktop})`).join("; ");
  const ph1 = h.ph1 === "on" ? `PH1 ON ${h.ph1_photos ?? "?"}/420 photos (${h.ph1_recompressed ?? "?"} recompressed)` : `PH1 ${h.ph1.toUpperCase()}`;
  return [
    `${h.at.slice(0, 16)}Z ${h.target}`,
    `contributor ${h.contributor_app}`,
    `hw enrol ${hw.contributor_enrolments ?? 0} / sub ${hw.contributor_submissions ?? 0} / roster ${hw.contributor_handwriting_roster ?? 0}`,
    ph1,
    `triage: ${tri || "none"}`,
    `decisions ${h.decisions}`,
    `D1 writes today ${h.d1_rows_written_today ?? "n/a"}`,
  ].join(" | ");
}

async function status(url: string): Promise<number> {
  try {
    return (await fetch(url, { redirect: "manual" })).status;
  } catch {
    return 0;
  }
}

/** PH1 counts from the operator export; the bearer stays in memory and the photos' fields are dropped at once. */
async function ph1Counts(base: string): Promise<{ photos: number; recompressed: number } | null> {
  if (!existsSync(PH1_TOKEN)) return null;
  const token = readFileSync(PH1_TOKEN, "utf8").trim();
  const res = await fetch(`${base}/api/ph1/operator/export`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status !== 200) return null;
  const body = (await res.json()) as { count?: number; photos?: { transfer?: string }[] };
  return { photos: body.count ?? 0, recompressed: (body.photos ?? []).filter((p) => p.transfer === "recompressed").length };
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const t = target(flags);
  const base = t === "production" ? HOST : LOCAL;
  const tables = d1Query<{ name: string }>(t, CONTRIBUTOR_TABLES_SQL)[0]!.map((r) => r.name);
  const rows = d1Query<Record<string, number | string>>(t, [...tables.map((n) => `SELECT COUNT(*) AS n FROM "${n}"`), TRIAGE_SQL, "SELECT COUNT(*) AS n FROM decisions WHERE superseded_at IS NULL"].join("; "));
  const handwriting = Object.fromEntries(tables.map((n, i) => [n, Number(rows[i]![0]!.n)]));
  const triage = (rows[tables.length] as { id: string; status: string; lines: number; answered: number; to_desktop: number; plants: number }[]).map((r) => ({
    batch: r.id,
    status: r.status,
    lines: r.lines,
    answered: r.answered,
    to_desktop: r.to_desktop,
    plants: r.plants,
  }));
  const [app, ph1] = await Promise.all([status(`${base}/api/contributor/v1/enrolments`), status(`${base}/ph1`)]);
  const ph1Now = ph1State(ph1);
  const counts = ph1Now === "on" ? await ph1Counts(base) : null;
  let written: number | null = null;
  if (t === "production") {
    try {
      const creds = loadCredentials();
      written = await todayRowsWritten(creds.CLOUDFLARE_ACCOUNT_ID!, creds.CLOUDFLARE_API_TOKEN!);
    } catch {
      written = null;
    }
  }
  const health: Health = {
    at: new Date().toISOString(),
    target: t,
    contributor_app: appState(app),
    ph1: ph1Now,
    ph1_photos: counts?.photos ?? null,
    ph1_recompressed: counts?.recompressed ?? null,
    handwriting,
    triage,
    decisions: Number(rows[tables.length + 1]![0]!.n),
    d1_rows_written_today: written,
  };
  console.log(flags.json === true ? JSON.stringify(health, null, 1) : oneLine(health));
}

if (process.argv[1]?.endsWith("ops-health.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
