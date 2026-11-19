/**
 * The account's daily D1 write budget (docs/runbooks/testing-and-imports.md). On 2026-11-19 repeated large imports to
 * a test database used up the account's free daily row writes and took production down; every import to production
 * is now counted against the budget before it runs.
 *
 * D1 counts every row an INSERT or UPDATE writes, plus one per index the write touches. The budget is
 * D1_DAILY_WRITE_BUDGET from ~/.config/heocr/cloudflare.env (default 100,000, the free plan's daily limit; set it to
 * the plan's figure after an upgrade), and an import may bring the day's total to at most SAFE_SHARE of it.
 */
import { LARGE_BATCH } from "./importsql";

export const FREE_DAILY_WRITES = 100_000;
export const SAFE_SHARE = 0.8;
/** proposals: the row, proposals_queue, the (batch_id, external_id) key, proposals_item. items: the row, its key, items_external_id. */
const PER_PROPOSAL = 4;
const PER_ITEM = 3;

/** A conservative estimate of the rows an import writes. */
export function estimateImportWrites(x: { items: number; proposals: number; existingProposals: number; afterRowsPerProposal?: number }): number {
  // A large batch is deactivated whole first (each row and its queue index entry), then every proposal upserted.
  const deactivate = x.proposals > LARGE_BATCH ? 2 * x.existingProposals : x.existingProposals;
  return x.items * PER_ITEM + x.proposals * PER_PROPOSAL + deactivate + x.proposals * (x.afterRowsPerProposal ?? 0) + 1;
}

export function budgetProblem(today: number, estimate: number, budget: number): string | null {
  const cap = Math.floor(budget * SAFE_SHARE);
  if (today + estimate <= cap) return null;
  return `this import would write about ${estimate.toLocaleString("en")} rows; the account has written ${today.toLocaleString("en")} today, and the cap is ${cap.toLocaleString("en")} (${SAFE_SHARE * 100}% of the daily budget ${budget.toLocaleString("en")}). Wait for 00:00 UTC, split the import, or pass --over-budget if the maintainer agrees.`;
}

/** Rows written today (UTC) across every D1 database of the account, from Cloudflare's GraphQL analytics. */
export async function todayRowsWritten(accountId: string, token: string, nowMs = Date.now()): Promise<number> {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "query($a:String!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:100,filter:{date_geq:$d}){sum{rowsWritten}}}}}",
      variables: { a: accountId, d: date },
    }),
  });
  const body = (await res.json()) as { errors?: { message: string }[]; data?: { viewer: { accounts: { d1AnalyticsAdaptiveGroups: { sum: { rowsWritten: number } }[] }[] } } };
  if (!res.ok || body.errors?.length || !body.data) throw new Error(`D1 analytics unavailable: ${body.errors?.[0]?.message ?? res.status}`);
  return body.data.viewer.accounts[0]?.d1AnalyticsAdaptiveGroups.reduce((n, g) => n + g.sum.rowsWritten, 0) ?? 0;
}

/** Refuse a production import over the budget (local imports are free). Prints the numbers either way. */
export async function checkWriteBudget(target: string, estimate: number, flags: Record<string, string | true>): Promise<void> {
  if (target !== "production") return;
  const budget = Number(process.env.D1_DAILY_WRITE_BUDGET ?? FREE_DAILY_WRITES);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  let today: number;
  try {
    if (!accountId || !token) throw new Error("no Cloudflare credentials in the environment");
    today = await todayRowsWritten(accountId, token);
  } catch (err) {
    if (flags["budget-unknown"] === true) {
      console.warn(`write budget not checked (${err instanceof Error ? err.message : err}); --budget-unknown given`);
      return;
    }
    throw new Error(`cannot check the D1 write budget: ${err instanceof Error ? err.message : err}. Pass --budget-unknown to import anyway.`, { cause: err });
  }
  console.log(JSON.stringify({ write_budget: { today, estimate, budget, cap: Math.floor(budget * SAFE_SHARE) } }));
  const problem = budgetProblem(today, estimate, budget);
  if (problem && flags["over-budget"] !== true) throw new Error(problem);
  if (problem) console.warn(`over the write budget, --over-budget given: ${problem}`);
}
