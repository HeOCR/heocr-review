/**
 * Run wrangler with the Cloudflare credentials from ~/.config/heocr/cloudflare.env (remote targets only).
 * The token is passed through the child's environment and never printed or logged.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Target } from "./args";

export const CREDENTIALS_FILE = join(homedir(), ".config", "heocr", "cloudflare.env");

export function loadCredentials(): Record<string, string> {
  if (!existsSync(CREDENTIALS_FILE)) throw new Error(`${CREDENTIALS_FILE} does not exist`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(CREDENTIALS_FILE, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function targetFlags(t: Target): string[] {
  if (t === "local") return ["--local"];
  if (t === "preview") return ["--remote", "--env", "preview"];
  return ["--remote"];
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out;
}

export function wrangler(args: string[], opts: { remote: boolean; input?: string; quiet?: boolean } = { remote: false }): string {
  const creds = opts.remote ? loadCredentials() : {};
  const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  if (opts.remote) {
    env.CLOUDFLARE_ACCOUNT_ID = creds.CLOUDFLARE_ACCOUNT_ID;
    env.CLOUDFLARE_API_TOKEN = creds.CLOUDFLARE_API_TOKEN;
  }
  const res = spawnSync("npx", ["wrangler", ...args], { env, input: opts.input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const secrets = [creds.CLOUDFLARE_API_TOKEN ?? ""];
  if (res.status !== 0) {
    throw new Error(`wrangler ${args[0]} ${args[1] ?? ""} failed:\n${redact((res.stderr || "") + (res.stdout || ""), secrets).slice(-4000)}`);
  }
  if (!opts.quiet && res.stderr) process.stderr.write(redact(res.stderr, secrets));
  return redact(res.stdout, secrets);
}

/** `wrangler d1 execute --json --command`: the rows of each statement. */
export function d1Query<T>(t: Target, sql: string): T[][] {
  const out = wrangler(["d1", "execute", "DB", ...targetFlags(t), "--json", "--command", sql], { remote: t !== "local", quiet: true });
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as { results: T[] }[];
  return parsed.map((r) => r.results);
}

export function d1File(t: Target, file: string): void {
  wrangler(["d1", "execute", "DB", ...targetFlags(t), "--yes", "--file", file], { remote: t !== "local", quiet: true });
}

export function d1Migrate(t: Target): void {
  wrangler(["d1", "migrations", "apply", "DB", ...targetFlags(t)], { remote: t !== "local", input: "y\n" });
}
