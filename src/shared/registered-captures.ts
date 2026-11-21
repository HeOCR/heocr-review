export const CAPTURE_BATCH_PREFIX = "private-ref-capture-";
export const CAPTURE_API = "/api/registered-captures/v1";
export const CAPTURE_FORM = "/registered-captures";
export const CAPTURE_ROSTER_SCHEMA = "registered_phone_captures.v1";
export const CAPTURE_DIGEST = /^[a-f0-9]{64}(?![\s\S])/;
const pageKey = /^[A-Z0-9][A-Z0-9-]{0,79}(?![\s\S])/;
const batchKey = /^private-ref-capture-[a-z0-9][a-z0-9._-]{0,78}(?![\s\S])/;
const allSlots = ["A", "B", "C"] as const;
export type CaptureSlot = typeof allSlots[number];
type Slot = { slot: CaptureSlot; condition: string };
export type CapturePage = {
  page_id: string;
  issuer_pdf_sha256: string;
  issuer_page_index: number;
  issue_key: string;
  slots: Slot[];
};
export type CaptureRoster = {
  schema: typeof CAPTURE_ROSTER_SCHEMA;
  registration: string;
  pack_sha256: string;
  batch_id: string;
  pages: CapturePage[];
};

const field = (x: unknown, max: number): x is string =>
  typeof x === "string" && x.trim().length > 0 && x.length <= max && !/[\p{Cc}\p{Cf}]/u.test(x);

/** Validate the private eval handoff. All capture names are derived from this roster. */
export function captureRoster(value: unknown): CaptureRoster {
  const roster = value as CaptureRoster | null;
  function requireScope(ok: unknown): asserts ok {
    if (!ok) throw new Error("invalid registered capture roster");
  }
  requireScope(roster?.schema === CAPTURE_ROSTER_SCHEMA && field(roster.registration, 200) &&
    typeof roster.pack_sha256 === "string" && CAPTURE_DIGEST.test(roster.pack_sha256) &&
    typeof roster.batch_id === "string" && batchKey.test(roster.batch_id) &&
    Array.isArray(roster.pages) && roster.pages.length > 0 && roster.pages.length <= 40);
  const ids = new Set<string>();
  const locators = new Set<string>();
  const issues = new Map<string, string>();
  for (const p of roster.pages) {
    requireScope(p && typeof p.page_id === "string" && pageKey.test(p.page_id) && !ids.has(p.page_id) &&
      typeof p.issuer_pdf_sha256 === "string" && CAPTURE_DIGEST.test(p.issuer_pdf_sha256) &&
      Number.isSafeInteger(p.issuer_page_index) && p.issuer_page_index >= 1 && field(p.issue_key, 160) &&
      Array.isArray(p.slots) && (p.slots.length === 2 || p.slots.length === 3) &&
      p.slots.every((s, i) => s && s.slot === allSlots[i] && field(s.condition, 160)));
    const locator = p.issuer_pdf_sha256 + "/" + p.issuer_page_index;
    requireScope(!locators.has(locator) && (!issues.has(p.issuer_pdf_sha256) || issues.get(p.issuer_pdf_sha256) === p.issue_key));
    ids.add(p.page_id);
    locators.add(locator);
    issues.set(p.issuer_pdf_sha256, p.issue_key);
  }
  return roster;
}

export function captureFile(roster: CaptureRoster, filename: string) {
  if (filename.length > 100) return null;
  const normalized = filename.replace(/\.[A-Za-z]+$/u, ext => ext.toLowerCase());
  const match = /^([A-Z0-9-]+)-([ABC])\.(jpg|jpeg|png|heic|heif)$/u.exec(normalized);
  if (!match || match[0] !== normalized) return null;
  const [, id, slot, ext] = match;
  const page = roster.pages.find(p => p.page_id === id);
  const assignment = page?.slots.find(s => s.slot === slot);
  return page && assignment ? { page, assignment, ext: ext as "jpg" | "jpeg" | "png" | "heic" | "heif" } : null;
}

export function captureRoot(sha256: string) {
  return "registered-captures/v1/" + sha256;
}

export const captureLogFields = ["phone", "camera_mode", "printer", "paper", "orientation", "angle", "lighting"] as const;
export type CaptureLog = Record<typeof captureLogFields[number], string> & { retake_reason?: string };

export function captureLog(value: unknown, retake: boolean): CaptureLog | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as CaptureLog;
  if (!captureLogFields.every(k => field(input[k], 160)) ||
    (retake ? !field(input.retake_reason, 240) : input.retake_reason !== undefined)) return null;
  return {
    phone: input.phone.trim(), camera_mode: input.camera_mode.trim(), printer: input.printer.trim(), paper: input.paper.trim(),
    orientation: input.orientation.trim(), angle: input.angle.trim(), lighting: input.lighting.trim(),
    ...(retake ? { retake_reason: input.retake_reason!.trim() } : {}),
  };
}
