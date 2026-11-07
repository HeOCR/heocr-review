// Bundle the frontend (src/web) into public/app.js.
import { build } from "esbuild";

await build({
  entryPoints: ["src/web/main.ts"],
  outfile: "public/app.js",
  bundle: true,
  minify: true,
  sourcemap: "linked",
  format: "iife",
  target: ["es2020", "safari15", "chrome100", "firefox100"],
  legalComments: "none",
  logLevel: "info",
});
