/** Refuse private sources: nothing from HeOCR/heocr-restricted-eval (or any path or repo named like it). */
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

const FORBIDDEN = /heocr-restricted-eval|restricted[-_]eval/i;

export function assertOpenSource(path: string): void {
  const real = realpathSync(path);
  if (FORBIDDEN.test(real)) throw new Error(`refusing ${path}: restricted sources are never imported`);
  const dir = statSync(real).isDirectory() ? real : dirname(real);
  const res = spawnSync("git", ["-C", dir, "remote", "-v"], { encoding: "utf8" });
  if (res.status === 0 && FORBIDDEN.test(res.stdout)) throw new Error(`refusing ${path}: it is in a restricted repository`);
}
