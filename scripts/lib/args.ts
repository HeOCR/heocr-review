export function parseArgs(argv: string[]): { flags: Record<string, string | true>; positional: string[] } {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) flags[key] = argv[++i]!;
      else flags[key] = true;
    } else positional.push(arg);
  }
  return { flags, positional };
}

export function str(flags: Record<string, string | true>, key: string, fallback?: string): string {
  const v = flags[key];
  if (typeof v === "string") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`--${key} is required`);
}

export type Target = "local" | "preview" | "production";

export function target(flags: Record<string, string | true>): Target {
  const t = str(flags, "target", "local");
  if (t !== "local" && t !== "preview" && t !== "production") throw new Error("--target must be local, preview or production");
  if (t === "production" && flags["yes-production"] !== true) throw new Error("--target production also needs --yes-production");
  return t;
}
