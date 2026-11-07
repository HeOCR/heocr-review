/**
 * Deploy HeOCR Review with the credentials in ~/.config/heocr/cloudflare.env.
 *
 *   npm run deploy:preview                       -> Worker heocr-review-preview, D1 heocr-review-preview
 *   tsx scripts/deploy.ts production --yes-production   (only when the maintainer says so)
 *
 * It creates the D1 database if needed (and records its id in wrangler.jsonc), applies migrations, builds the
 * frontend, and deploys with GOOGLE_CLIENT_ID as a var and the secrets from
 * ~/.config/heocr/heocr-review-<env>.secrets.json (generated on first deploy, mode 0600; keep it:
 * REVIEWER_ID_SECRET must never change, or every reviewer gets a new pseudonym).
 * ADMIN_REVIEWER_IDS is read from that file too; add the maintainer's rv_... id there and redeploy.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "./lib/args";
import { loadCredentials, wrangler } from "./lib/wrangler";

const ROOT = resolve(import.meta.dirname, "..");
const CONFIG = join(ROOT, "wrangler.jsonc");

export function assertNoDevAuth(configText: string): void {
  if (/DEV_AUTH_BYPASS/.test(configText.replace(/\/\/.*$/gm, ""))) throw new Error("wrangler.jsonc must never set DEV_AUTH_BYPASS");
  if (/"ENVIRONMENT"\s*:\s*"development"/.test(configText)) throw new Error("wrangler.jsonc must never set ENVIRONMENT=development");
}

function setDatabaseId(configText: string, dbName: string, id: string): string {
  const pattern = new RegExp(`("database_name":\\s*"${dbName}",\\s*"database_id":\\s*")([0-9a-f-]{36})(")`);
  if (!pattern.test(configText)) throw new Error(`cannot find database ${dbName} in wrangler.jsonc`);
  return configText.replace(pattern, `$1${id}$3`);
}

function main(): void {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const envName = positional[0] ?? "preview";
  if (envName !== "preview" && envName !== "production") throw new Error("deploy preview or production");
  if (envName === "production" && flags["yes-production"] !== true) throw new Error("production needs --yes-production");
  const envFlags = envName === "preview" ? ["--env", "preview"] : [];
  const workerName = envName === "preview" ? "heocr-review-preview" : "heocr-review";
  const dbName = workerName;

  const creds = loadCredentials();
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
    if (!creds[key]) throw new Error(`${key} is missing from the credentials file`);
  }
  const clientId = creds.GOOGLE_OAUTH_CLIENT_ID ?? "";
  if (!clientId) {
    if (envName === "production") throw new Error("GOOGLE_OAUTH_CLIENT_ID is missing from the credentials file");
    console.warn("GOOGLE_OAUTH_CLIENT_ID is not set yet: the preview deploys without sign-in (the page says so)");
  }
  let configText = readFileSync(CONFIG, "utf8");
  assertNoDevAuth(configText);

  // D1 database
  const list = JSON.parse(wrangler(["d1", "list", "--json"], { remote: true, quiet: true })) as { name: string; uuid: string }[];
  let db = list.find((d) => d.name === dbName);
  if (!db) {
    wrangler(["d1", "create", dbName], { remote: true, quiet: true });
    const again = JSON.parse(wrangler(["d1", "list", "--json"], { remote: true, quiet: true })) as { name: string; uuid: string }[];
    db = again.find((d) => d.name === dbName);
    if (!db) throw new Error(`created ${dbName} but cannot find it`);
    console.log(`created D1 database ${dbName}`);
  }
  if (!configText.includes(db.uuid)) {
    configText = setDatabaseId(configText, dbName, db.uuid);
    writeFileSync(CONFIG, configText);
    console.log(`recorded ${dbName} id in wrangler.jsonc (commit it)`);
  }

  wrangler(["d1", "migrations", "apply", "DB", "--remote", ...envFlags], { remote: true, input: "y\n" });

  // Secrets: generated once, kept outside the repo.
  const secretsPath = join(homedir(), ".config", "heocr", `heocr-review-${envName}.secrets.json`);
  const secrets: Record<string, string> = existsSync(secretsPath) ? (JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, string>) : {};
  let changed = false;
  for (const key of ["SESSION_SECRET", "REVIEWER_ID_SECRET"]) {
    if (!secrets[key]) {
      secrets[key] = randomBytes(32).toString("hex");
      changed = true;
    }
  }
  if (secrets.ADMIN_REVIEWER_IDS === undefined) {
    secrets.ADMIN_REVIEWER_IDS = "";
    changed = true;
  }
  if (changed) {
    writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
    console.log(`wrote ${secretsPath} (mode 0600; back it up, never commit it)`);
  }
  chmodSync(secretsPath, 0o600);

  const build = spawnSync("node", ["scripts/build-web.mjs"], { cwd: ROOT, stdio: "inherit" });
  if (build.status !== 0) throw new Error("frontend build failed");

  wrangler(["deploy", ...envFlags, ...(clientId ? ["--var", `GOOGLE_CLIENT_ID:${clientId}`] : []), "--secrets-file", secretsPath], {
    remote: true,
  });
  const sub = creds.CLOUDFLARE_WORKERS_SUBDOMAIN;
  console.log(sub ? `deployed: https://${workerName}.${sub}.workers.dev` : `deployed ${workerName}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
