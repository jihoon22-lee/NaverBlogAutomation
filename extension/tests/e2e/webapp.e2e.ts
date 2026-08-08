/** Packaged web-app journey without loading the legacy extension. */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

import { expect, test } from "@playwright/test";
import { chromium, type Browser } from "playwright";

import { resolveApiCommand } from "./api-command.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(extensionRoot, "..");
const apiOrigin = "http://127.0.0.1:8765";
type ApiProcess = ChildProcessByStdio<null, Readable, Readable>;

interface RunningApi {
  dispose(): Promise<void>;
}

test("packaged web app opens the workbench and selects an ordered batch without the legacy extension", async () => {
  let api: RunningApi | null = null;
  let browser: Browser | null = null;
  try {
    api = await startApi();
    const postId = await seedQueuedPost();
    browser = await chromium.launch({ channel: "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 768, height: 1024 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`${apiOrigin}/app/`);
    await expect(page.locator("#workspace-status")).toContainText("오늘의 블로그 작업");
    await page.locator('[data-section="workbench"]').click();
    await expect(page.locator("#workspace-status")).toContainText("대기 중인 글");
    await page.locator(`input#queue-batch-${postId}`).check();
    await page.locator("#open-batch-preview").click();
    await expect(page.locator("#session-queue-selection")).toBeVisible();

    const choice = page.locator(`input[data-post-id="${postId}"]`);
    await choice.check();
    await expect(page.locator("#start-session-button")).toBeEnabled();
    const approval = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/v1/automation/sessions",
    );
    await page.locator("#start-session-button").click();
    const request = await approval;

    expect(request.postDataJSON()).toMatchObject({
      approved_steps: ["like", "comment"],
      max_posts: 1,
      post_ids: [postId],
      sources: ["neighbor"],
    });
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await browser?.close();
    await api?.dispose();
  }
});

async function seedQueuedPost(): Promise<string> {
  await apiJson("/api/v1/settings/automation_consent", {
    method: "PUT",
    body: { payload: { accepted: true, consent_version: 1 } },
  });
  const policy = await apiJson<{ payload: Record<string, unknown> }>(
    "/api/v1/settings/safety_policy",
  );
  await apiJson("/api/v1/settings/safety_policy", {
    method: "PUT",
    body: {
      payload: { ...policy.payload, allowed_hours: Array.from({ length: 24 }, (_, hour) => hour) },
    },
  });
  const neighbor = await apiJson<{ id: string }>("/api/v1/discovery/neighbors", {
    method: "POST",
    body: {
      name: "합성 이웃",
      blog_id: "webapp-e2e-neighbor",
      blog_url: "https://blog.naver.com/webapp-e2e-neighbor",
    },
  });
  await apiJson("/api/v1/discovery/import", {
    method: "POST",
    body: {
      source: "neighbor",
      neighbor_id: neighbor.id,
      posts: [
        {
          source_url: "https://blog.naver.com/webapp-e2e-neighbor/1",
          title: "웹앱 배치 합성 글",
        },
      ],
    },
  });
  const queue = await apiJson<{ items: { id: string }[] }>(
    "/api/v1/app/discovery/queue?source=neighbor",
  );
  const postId = queue.items[0]?.id;
  if (postId === undefined) throw new Error("The synthetic post was not imported");
  return postId;
}

async function apiJson<T = unknown>(
  path: string,
  options: { body?: object; method?: "GET" | "POST" | "PUT" } = {},
): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, {
    method: options.method ?? "GET",
    ...(options.body === undefined
      ? {}
      : {
          body: JSON.stringify(options.body),
          headers: { "Content-Type": "application/json" },
        }),
  });
  if (!response.ok)
    throw new Error(`${path} failed with ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function startApi(): Promise<RunningApi> {
  const directory = await mkdtemp(join(tmpdir(), "naver-blog-assistant-webapp-"));
  const command = resolveApiCommand(process.env);
  const apiProcess = spawn(command.executable, command.args, {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: safeApiEnvironment(resolve(directory, "e2e.sqlite3")),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  apiProcess.stdout.on("data", (chunk: Buffer) => {
    output = boundedOutput(output, chunk.toString());
  });
  apiProcess.stderr.on("data", (chunk: Buffer) => {
    output = boundedOutput(output, chunk.toString());
  });
  try {
    await waitForHealth(apiProcess, () => output);
  } catch (error) {
    await terminate(apiProcess);
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
  return {
    async dispose(): Promise<void> {
      await terminate(apiProcess);
      await rm(directory, { force: true, recursive: true });
    },
  };
}

function safeApiEnvironment(databasePath: string): NodeJS.ProcessEnv {
  const allowed = ["HOME", "LANG", "LC_ALL", "PATH", "SYSTEMROOT", "TEMP", "TMP", "UV_CACHE_DIR"];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    API_HOST: "127.0.0.1",
    API_PORT: "8765",
    APP_ENV: "test",
    COMMENT_GENERATOR_MODE: "fake",
    DATABASE_URL: `sqlite:///${databasePath}`,
    OPENAI_API_KEY: "",
  };
}

async function waitForHealth(apiProcess: ApiProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null) {
      throw new Error(`Local API exited before health check passed.\n${output()}`);
    }
    try {
      const response = await fetch(`${apiOrigin}/health`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200 && (await response.text()) === '{"status":"ok"}') return;
    } catch {
      // The installed application may still be applying migrations.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Local API did not become healthy within 15 seconds.\n${output()}`);
}

async function terminate(apiProcess: ApiProcess): Promise<void> {
  if (apiProcess.exitCode !== null) return;
  signalProcessGroup(apiProcess, "SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => apiProcess.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!exited) {
    signalProcessGroup(apiProcess, "SIGKILL");
    if (apiProcess.exitCode === null) {
      await new Promise<void>((resolve) => apiProcess.once("exit", () => resolve()));
    }
  }
}

function signalProcessGroup(apiProcess: ApiProcess, signal: NodeJS.Signals): void {
  if (apiProcess.pid === undefined) return;
  try {
    if (process.platform === "win32") apiProcess.kill(signal);
    else process.kill(-apiProcess.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function boundedOutput(previous: string, next: string): string {
  return `${previous}${next}`.slice(-10_000);
}
