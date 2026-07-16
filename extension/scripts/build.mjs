import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(extensionRoot, "dist");

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });
await cp(resolve(extensionRoot, "public"), outputDirectory, { recursive: true });

await build({
  bundle: true,
  entryPoints: {
    background: resolve(extensionRoot, "src/background.ts"),
    popup: resolve(extensionRoot, "src/popup.ts"),
  },
  format: "esm",
  logLevel: "info",
  outdir: outputDirectory,
  platform: "browser",
  sourcemap: true,
  target: "chrome120",
});
