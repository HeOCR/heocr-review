/** SQL literals for generated import files (no bind parameters in `wrangler d1 execute --file`). */
export function lit(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** Replace ?1, ?2, ... in a query with literals (for wrangler --command, which takes no parameters). */
export function inline(sql: string, ...params: (string | number | null)[]): string {
  return sql.replace(/\?(\d+)/g, (_, n: string) => lit(params[Number(n) - 1]));
}
