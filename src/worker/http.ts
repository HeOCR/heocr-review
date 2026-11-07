export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message ?? code);
  }
}

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function errorResponse(err: HttpError): Response {
  return json({ error: err.code, ...(err.message !== err.code ? { message: err.message } : {}) }, err.status, err.headers);
}

export const MAX_BODY_BYTES = 16 * 1024;

/** Parse a small JSON body; refuse other content types (forces a CORS preflight for cross-site callers). */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw new HttpError(415, "json_required");
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_json");
  return value as Record<string, unknown>;
}

/** Writes must come from this origin (SameSite=Lax already keeps the cookie off cross-site POSTs). */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new HttpError(403, "bad_origin");
}
