import { exports } from "cloudflare:workers";

export const ORIGIN = "http://localhost";

/** A browser-like client: keeps the session cookie, sends Origin and JSON. */
export class Client {
  cookie = "";
  constructor(readonly origin = ORIGIN) {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const h: Record<string, string> = { origin: this.origin, ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (body !== undefined) h["content-type"] = "application/json";
    const res = await exports.default.fetch(
      new Request(this.origin + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
    );
    const set = res.headers.get("set-cookie");
    if (set) {
      const value = set.split(";")[0]!;
      this.cookie = value.endsWith("=") ? "" : value;
    }
    return res;
  }

  async json<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await this.req(method, path, body);
    return { status: res.status, body: (await res.json()) as T };
  }

  get<T = Record<string, unknown>>(path: string) {
    return this.json<T>("GET", path);
  }

  post<T = Record<string, unknown>>(path: string, body: unknown = {}) {
    return this.json<T>("POST", path, body);
  }

  async signIn(subject: string): Promise<string> {
    const res = await this.post<{ reviewerId: string }>("/api/auth/dev", { subject });
    if (res.status !== 200) throw new Error(`sign-in failed ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.reviewerId;
  }

  async acceptTerms(displayName: string | null = null) {
    const cfg = await this.get<{ termsVersion: string }>("/api/config");
    return this.post("/api/me/terms", { termsVersion: cfg.body.termsVersion, accept: true, displayName });
  }
}

export const BATCH = "fixture_reference_audit_v1";
