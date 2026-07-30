import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(clientRoot, "..");
const appOutput = resolve(clientRoot, "dist");
const pageOutput = resolve(
  repositoryRoot,
  "src/naver_blog_assistant/infrastructure/browser/bundles",
);
const pageOnly = process.argv.includes("--page-only");

/**
 * The page bundle is evaluated inside an isolated browser context, so it is an IIFE with no imports
 * and no module scope. It is written into the Python package because the wheel force-includes it.
 */
await mkdir(pageOutput, { recursive: true });
await build({
  bundle: true,
  entryPoints: { page: resolve(clientRoot, "src/page/index.ts") },
  format: "iife",
  legalComments: "none",
  logLevel: "info",
  minify: false,
  outdir: pageOutput,
  platform: "browser",
  sourcemap: false,
  target: "chrome120",
});

const bundle = await stat(resolve(pageOutput, "page.js"));
if (bundle.size < 1_000) {
  throw new Error("the page bundle looks truncated");
}

if (pageOnly) {
  process.exit(0);
}

await rm(appOutput, { force: true, recursive: true });
await mkdir(appOutput, { recursive: true });
await cp(resolve(clientRoot, "public"), appOutput, { recursive: true });

await build({
  bundle: true,
  entryPoints: { app: resolve(clientRoot, "src/app/main.ts") },
  format: "esm",
  logLevel: "info",
  outdir: appOutput,
  platform: "browser",
  sourcemap: true,
  target: "chrome120",
});
