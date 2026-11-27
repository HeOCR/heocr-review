import { assertAnonymousR2Denial, disabledR2FixtureUrl, type ObjectReadback } from "./restricted-reference-stage";

const bucket = "heocr-review-protected";
export const accessFixture = { key: "access-check.txt", text: "HeOCR private object access fixture\n" };

interface CloudflareResponse<T> {
  success: boolean;
  result: T;
  result_info?: { cursor?: string; is_truncated?: boolean };
}

export async function readPrivateObjects(batch: string, credentials: Record<string, string>) {
  const account = credentials.CLOUDFLARE_ACCOUNT_ID;
  const token = credentials.CLOUDFLARE_API_TOKEN;
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !token || credentials.CLOUDFLARE_WORKERS_SUBDOMAIN !== "heocr") {
    throw new Error("expected HeOCR Cloudflare configuration");
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}`;
  const request = (suffix: string) => fetch(base + suffix, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30000),
  });
  async function get<T>(suffix: string): Promise<CloudflareResponse<T>> {
    const response = await request(suffix);
    if (!response.ok) throw new Error(`private R2 readback returned HTTP ${response.status}`);
    const envelope = await response.json() as CloudflareResponse<T>;
    if (envelope.success !== true) throw new Error("private R2 readback failed");
    return envelope;
  }
  const [{ result: managed }, { result: custom }] = await Promise.all([
    get<{ enabled: boolean; domain: string }>("/domains/managed"), get<{ domains: unknown[] }>("/domains/custom"),
  ]);
  if (!Array.isArray(custom?.domains) || custom.domains.length !== 0) {
    throw new Error("private R2 public-access settings did not pass");
  }
  const managedUrl = disabledR2FixtureUrl(managed, accessFixture.key);
  const s3Url = new URL(`https://${account}.r2.cloudflarestorage.com/${bucket}/${encodeURIComponent(accessFixture.key)}`);
  const fixture = await request(`/objects/${accessFixture.key}`);
  if (!fixture.ok || await fixture.text() !== accessFixture.text) throw new Error("private R2 access fixture could not be read");
  const anonymousProbes = await assertAnonymousR2Denial(managedUrl, s3Url);

  const objects: ObjectReadback[] = [];
  const cursors = new Set<string>();
  const query = new URLSearchParams({ prefix: batch + "/", per_page: "1000" });
  for (;;) {
    const { result, result_info: page } = await get<ObjectReadback[]>(`/objects?${query}`);
    if (!Array.isArray(result)) throw new Error("private R2 object listing was malformed");
    objects.push(...result);
    if (!page?.is_truncated) break;
    if (!page.cursor || cursors.has(page.cursor)) throw new Error("private R2 object listing pagination failed");
    cursors.add(page.cursor);
    query.set("cursor", page.cursor);
  }
  return { objects, anonymousProbes };
}
