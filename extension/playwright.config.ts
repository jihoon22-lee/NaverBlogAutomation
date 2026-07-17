import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  outputDir: join(tmpdir(), `naver-blog-assistant-playwright-${process.pid}`),
  reporter: "list",
  retries: 0,
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  workers: 1,
});
