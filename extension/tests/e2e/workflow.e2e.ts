import { spawn, type ChildProcessByStdio } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

import { expect, test } from "@playwright/test";
import { chromium, type BrowserContext, type Page, type Response } from "playwright";

import { resolveApiCommand } from "./api-command.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(extensionRoot, "..");
const apiOrigin = "http://127.0.0.1:8765";
const syntheticPostUrl = "https://blog.naver.com/synthetic/1001";
type ApiProcess = ChildProcessByStdio<null, Readable, Readable>;

interface StagedExtension {
  directory: string;
  dispose(): Promise<void>;
}

interface RunningApi {
  dispose(): Promise<void>;
}

interface CapturedRecommendationPost {
  idempotencyKey: string | undefined;
  payload: Record<string, unknown>;
}

test("built production Side Panel completes, replays, and restores the reviewed workflow", async () => {
  const staged = await stageExtension();
  const profile = await mkdtemp(join(tmpdir(), "naver-blog-assistant-profile-"));
  let context: BrowserContext | null = null;
  let api: RunningApi | null = null;
  try {
    context = await chromium.launchPersistentContext(profile, {
      args: [
        `--disable-extensions-except=${staged.directory}`,
        "--enable-unsafe-extension-debugging",
        `--load-extension=${staged.directory}`,
      ],
      channel: "chromium",
      headless: true,
    });
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 10_000 }));
    const extensionId = new URL(serviceWorker.url()).hostname;
    expect(extensionId).toMatch(/^[a-p]{32}$/u);
    const extensionOrigin = `chrome-extension://${extensionId}`;

    api = await startApi(extensionOrigin);
    const fixture = await readFile(
      resolve(extensionRoot, "tests/fixtures/naver-modern.html"),
      "utf8",
    );
    await context.route(`${syntheticPostUrl}*`, (route) =>
      route.fulfill({ body: fixture, contentType: "text/html; charset=utf-8", status: 200 }),
    );
    const blogPage = context.pages()[0] ?? (await context.newPage());
    await blogPage.goto(syntheticPostUrl);
    await expect(blogPage.locator(".se-main-container")).toContainText("관람 동선");

    await blogPage.bringToFront();
    await triggerExtensionAction(context, blogPage, extensionId);
    const panel = await context.newPage();
    await panel.goto(`${extensionOrigin}/sidepanel.html`);
    const apiRequests: string[] = [];
    const recommendationPosts: CapturedRecommendationPost[] = [];
    const apiResponses: Response[] = [];
    const browserMessages: string[] = [];
    const failedRequests: string[] = [];
    panel.on("console", (message) => browserMessages.push(`${message.type()}: ${message.text()}`));
    panel.on("request", (request) => {
      if (request.url().startsWith(apiOrigin)) {
        apiRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/v1/recommendations"
        ) {
          recommendationPosts.push({
            idempotencyKey: request.headers()["idempotency-key"],
            payload: request.postDataJSON() as Record<string, unknown>,
          });
        }
      }
    });
    panel.on("response", (response) => {
      if (response.url().startsWith(apiOrigin)) {
        apiResponses.push(response);
      }
    });
    panel.on("requestfailed", (request) => {
      if (request.url().startsWith(apiOrigin)) {
        failedRequests.push(
          `${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? "unknown"}`,
        );
      }
    });
    expect(await browserHealth(panel, browserMessages)).toEqual({
      status: 200,
      text: '{"status":"ok"}',
    });
    await blogPage.bringToFront();
    if (await panel.locator("#error-panel").isVisible()) {
      await panel.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>("#retry-button");
        if (button === null) {
          throw new Error("Side Panel retry control is unavailable");
        }
        button.click();
      });
    }
    await expectPreviewState(panel);
    await expect(panel.locator("#post-title")).toHaveText("합성 전시 후기");
    await expect(panel.locator("#body-preview")).toContainText("관람 동선");
    await panel.locator(".advanced-preferences > summary").click();
    await panel.locator('input[name="relationship"][value="close"]').check();
    await panel.locator('input[name="speech-style"][value="banmal"]').check();
    await panel.locator('input[name="comment-length"][value="long"]').check();
    await panel.locator('input[name="comment-mood"][value="lively"]').check();
    const closingPhrase = "오늘도 좋은 하루 보내세요!";
    await panel.locator("#closing-phrase").fill(closingPhrase);
    await panel.locator("#save-preferences-button").click();
    await expect(panel.locator("#preference-notice")).toContainText("기본값으로 저장");

    let activeRegistry: Record<string, unknown> | null = null;
    await panel.route(`${apiOrigin}/api/v1/recommendations`, async (route) => {
      if (route.request().method() === "POST" && activeRegistry === null) {
        activeRegistry = await readExtensionStorage(panel);
      }
      await route.continue();
    });
    await panel.locator("#generate-button").click();
    await expectReviewState(panel, apiRequests, failedRequests);
    const shortResponse = latestRecommendationPost(apiResponses);
    expect(shortResponse?.status()).toBe(201);
    const shortRecommendationId = await recommendationId(shortResponse);
    expect(recommendationPosts[0]).toMatchObject({
      payload: {
        comment_length: "long",
        comment_mood: "lively",
        relationship_level: "close",
        speech_style: "banmal",
      },
    });
    expect(JSON.stringify(recommendationPosts[0]?.payload)).not.toContain(closingPhrase);
    expect(recommendationPosts[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/iu);
    await expect(panel.locator("#generated-relationship")).toHaveText("가까운 사이");
    await expect(panel.locator("#generated-speech-style")).toHaveText("반말");
    await expect(panel.locator("#generated-comment-length")).toHaveText("길게 (200–320자)");
    await expect(panel.locator("#generated-comment-mood")).toHaveText("활기차게");
    await expect(panel.locator("#candidate-list input")).toHaveCount(3);
    for (const comment of await panel
      .locator(".candidate > :is(span, label) > span")
      .allTextContents()) {
      expect(Array.from(comment).length).toBeGreaterThanOrEqual(200);
      expect(Array.from(comment).length).toBeLessThanOrEqual(320);
    }
    expect(activeRegistry).not.toBeNull();

    await writeExtensionStorage(panel, activeRegistry ?? {});
    await panel.reload();
    await expect(panel.locator("#preview-panel")).toBeVisible();
    await expect(panel.locator('input[name="comment-length"][value="long"]')).toBeChecked();
    await expect(panel.locator('input[name="comment-mood"][value="lively"]')).toBeChecked();
    await expect(panel.locator('input[name="relationship"][value="close"]')).toBeChecked();
    await expect(panel.locator('input[name="speech-style"][value="banmal"]')).toBeChecked();
    await expect(panel.locator("#closing-phrase")).toHaveValue(closingPhrase);
    await panel.locator("#generate-button").click();
    await expectReviewState(panel, apiRequests, failedRequests);
    const replayResponse = latestRecommendationPost(apiResponses);
    expect(replayResponse).toBeDefined();
    if (replayResponse === undefined) {
      throw new Error("Replay response is unavailable");
    }
    expect(replayResponse.status()).toBe(200);
    expect(replayResponse.headers()["idempotency-replayed"]).toBe("true");
    expect(recommendationPosts[1]?.payload).toEqual(recommendationPosts[0]?.payload);
    expect(recommendationPosts[1]?.idempotencyKey).toBe(recommendationPosts[0]?.idempotencyKey);
    await expect(panel.locator("#review-panel")).toBeVisible();

    const replayedId = await recommendationId(replayResponse);
    await panel.locator("#regenerate-button").click();
    await expectReviewState(panel, apiRequests, failedRequests);
    const regenerationResponse = latestRecommendationPost(apiResponses);
    expect(regenerationResponse?.status()).toBe(201);
    expect(recommendationPosts[2]?.payload).toEqual(recommendationPosts[0]?.payload);
    expect(recommendationPosts[2]?.idempotencyKey).not.toBe(recommendationPosts[0]?.idempotencyKey);
    expect(await recommendationId(regenerationResponse)).not.toBe(replayedId);

    const reusableCandidate =
      (await panel.locator(".candidate > :is(span, label) > span").first().textContent()) ?? "";
    await blogPage.bringToFront();
    await panel.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>("button[data-use-candidate]");
      if (button === null) throw new Error("Candidate use control is unavailable");
      button.click();
    });
    await expect(panel.locator("#review-status")).toHaveText("승인됨");
    await expect(blogPage.locator(".u_cbox_text")).toHaveText(
      `${reusableCandidate} ${closingPhrase}`,
    );
    await blogPage.locator(".u_cbox_text").fill("");

    await panel.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>("#change-options-button");
      if (button === null) throw new Error("Change options control is unavailable");
      button.click();
    });
    await expectPreviewState(panel);
    await panel.locator(".advanced-preferences > summary").click();
    await panel.locator('input[name="comment-length"][value="short"]').check();
    await panel.locator("#save-preferences-button").click();
    await expect(panel.locator("#preference-notice")).toContainText("기본값으로 저장");
    await panel.locator("#generate-button").click();
    await expectReviewState(panel, apiRequests, failedRequests);
    expect(latestRecommendationPost(apiResponses)?.status()).toBe(201);
    expect(recommendationPosts[3]).toMatchObject({
      payload: {
        comment_length: "short",
        comment_mood: "lively",
        relationship_level: "close",
        speech_style: "banmal",
      },
    });
    expect(recommendationPosts[3]?.idempotencyKey).not.toBe(recommendationPosts[2]?.idempotencyKey);

    const candidate = panel.locator('#candidate-list input[name="candidate"]').nth(1);
    await candidate.check();
    const editedComment = "합성 본문의 전시 동선이 잘 드러나는 댓글로 직접 다듬었습니다.";
    await panel.locator("#edited-comment").fill(editedComment);
    await blogPage.bringToFront();
    await panel.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>("#edited-use-button");
      if (button === null) {
        throw new Error("Edited comment use control is unavailable");
      }
      button.click();
    });
    await expect(panel.locator("#review-status")).toHaveText("승인됨");
    await expect(blogPage.locator(".u_cbox_text")).toHaveText(editedComment);
    await expect(panel.locator("#review-notice")).toContainText("입력란에 초안을");

    await panel.locator("#copy-button").click();
    await expect(panel.locator("#review-notice")).toContainText(/복사/u);
    await expect(panel.locator("#review-status")).toHaveText("승인됨");
    await expect(panel.locator("#complete-button")).toBeVisible();

    await panel.locator("#complete-button").click();
    await expect(panel.locator("#review-status")).toHaveText("수동 workflow 완료");
    const storedValue = await readExtensionStorage(panel);
    expect(storedValue.commentLengthPreferenceV1).toEqual({
      closingPhrase,
      commentLength: "short",
      commentMood: "lively",
      personalizationMode: "completed_examples",
      relationshipLevel: "close",
      schemaVersion: 5,
      speechStyle: "banmal",
    });
    const stored = JSON.stringify(storedValue);
    expect(stored).not.toContain("빛과 그림자");
    expect(stored).not.toContain("합성 전시 후기");
    expect(stored).not.toContain(syntheticPostUrl);
    expect(stored).not.toContain(editedComment);

    const postCountBeforeRestore = countRequests(apiRequests, "POST");
    await panel.reload();
    await expect(panel.locator("#preview-panel")).toBeVisible();
    await expect(panel.locator('input[name="relationship"][value="close"]')).toBeChecked();
    await expect(panel.locator('input[name="speech-style"][value="banmal"]')).toBeChecked();
    await expect(panel.locator("#closing-phrase")).toHaveValue(closingPhrase);
    const restoreGet = panel.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname.startsWith("/api/v1/recommendations/"),
    );
    await panel.locator("#generate-button").click();
    expect((await restoreGet).status()).toBe(200);
    await expect(panel.locator("#review-status")).toHaveText("수동 workflow 완료");
    await expect(panel.locator("#edited-comment")).toHaveValue(editedComment);
    expect(countRequests(apiRequests, "POST")).toBe(postCountBeforeRestore);

    await panel.locator("#history-refresh-button").click();
    await expect(panel.locator("#history-list .history-item")).toHaveCount(3);
    await panel.locator("#history-title").click();
    await expect(panel.locator("#history-list .history-item").first()).toContainText(
      "합성 전시 후기",
    );
    await panel.locator('[data-history-action="copy"]').first().click();
    await expect(panel.locator("#history-notice")).toContainText("복사");
    panel.once("dialog", (dialog) => dialog.accept());
    await panel.locator('[data-history-action="delete"]').first().click();
    await expect(panel.locator("#history-list .history-item")).toHaveCount(2);
    await expect(panel.locator("#history-notice")).toContainText("삭제");
    expect(JSON.stringify(await readExtensionStorage(panel))).not.toContain(shortRecommendationId);
  } finally {
    await api?.dispose();
    await context?.close();
    await staged.dispose();
    await rm(profile, { force: true, recursive: true });
  }
});

async function stageExtension(): Promise<StagedExtension> {
  const directory = await mkdtemp(join(tmpdir(), "naver-blog-assistant-extension-"));
  await cp(resolve(extensionRoot, "dist"), directory, { recursive: true });
  const productionManifestText = await readFile(
    resolve(extensionRoot, "dist/manifest.json"),
    "utf8",
  );
  const productionManifest = JSON.parse(productionManifestText) as Record<string, unknown>;
  expect(productionManifest.permissions).toEqual([
    "activeTab",
    "alarms",
    "notifications",
    "scripting",
    "sidePanel",
    "storage",
  ]);
  expect(productionManifest.host_permissions).toEqual(["http://127.0.0.1:8765/*"]);
  return {
    directory,
    dispose: () => rm(directory, { force: true, recursive: true }),
  };
}

async function recommendationId(response: Response | undefined): Promise<string> {
  if (response === undefined) throw new Error("Recommendation response is unavailable");
  const body = (await response.json()) as { id?: unknown };
  if (typeof body.id !== "string") throw new Error("Recommendation response ID is unavailable");
  return body.id;
}

async function triggerExtensionAction(
  context: BrowserContext,
  page: Page,
  extensionId: string,
): Promise<void> {
  const browser = context.browser();
  if (browser === null) {
    throw new Error("Persistent Chromium browser is unavailable");
  }
  const session = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await session.send("Target.getTargets", {
      filter: [{ type: "tab" }, { exclude: true }],
    });
    const tab = targetInfos.find((target) => target.url === page.url());
    if (tab === undefined) {
      throw new Error("Synthetic blog tab target is unavailable");
    }
    await session.send("Extensions.triggerAction", { id: extensionId, targetId: tab.targetId });
  } finally {
    await session.detach();
  }
}

async function startApi(extensionOrigin: string): Promise<RunningApi> {
  const directory = await mkdtemp(join(tmpdir(), "naver-blog-assistant-api-"));
  const databasePath = resolve(directory, "e2e.sqlite3");
  const command = resolveApiCommand(process.env);
  const apiProcess = spawn(command.executable, command.args, {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: safeApiEnvironment(extensionOrigin, databasePath),
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

function safeApiEnvironment(extensionOrigin: string, databasePath: string): NodeJS.ProcessEnv {
  const allowed = ["HOME", "LANG", "LC_ALL", "PATH", "SYSTEMROOT", "TEMP", "TMP", "UV_CACHE_DIR"];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return {
    ...environment,
    API_HOST: "127.0.0.1",
    API_PORT: "8765",
    APP_ENV: "test",
    CHROME_EXTENSION_ORIGIN: extensionOrigin,
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
      if (response.status === 200 && (await response.text()) === '{"status":"ok"}') {
        return;
      }
    } catch {
      // The installed application may still be preparing migrations or opening its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Local API did not become healthy within 15 seconds.\n${output()}`);
}

async function terminate(apiProcess: ApiProcess): Promise<void> {
  if (apiProcess.exitCode !== null) {
    return;
  }
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
  if (apiProcess.pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      apiProcess.kill(signal);
    } else {
      process.kill(-apiProcess.pid, signal);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

function boundedOutput(current: string, next: string): string {
  return `${current}${next}`.slice(-4_000);
}

function latestRecommendationPost(responses: readonly Response[]): Response | undefined {
  return responses.findLast(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/recommendations",
  );
}

async function readExtensionStorage(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => chrome.storage.local.get());
}

async function writeExtensionStorage(page: Page, value: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (stored) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(stored);
  }, value);
}

function countRequests(requests: readonly string[], method: string): number {
  return requests.filter((request) => request.startsWith(`${method} `)).length;
}

async function browserHealth(
  page: Page,
  messages: readonly string[],
): Promise<{ error: string; messages: readonly string[] } | { status: number; text: string }> {
  const result = await page.evaluate(async (origin) => {
    try {
      const response = await fetch(`${origin}/health`, {
        cache: "no-store",
        credentials: "omit",
      });
      return { status: response.status, text: await response.text() };
    } catch (error) {
      return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
  }, apiOrigin);
  return "error" in result ? { ...result, messages } : result;
}

async function expectReviewState(
  page: Page,
  requests: readonly string[],
  failures: readonly string[],
): Promise<void> {
  await expect
    .poll(
      async () => {
        if (await page.locator("#review-panel").isVisible()) {
          return "review";
        }
        if (await page.locator("#error-panel").isVisible()) {
          return `error: ${await page.locator("#error-message").textContent()}; requests=${requests.join(",")}; failures=${failures.join(",")}`;
        }
        return `pending: ${await page.locator("#status").textContent()}`;
      },
      { timeout: 10_000 },
    )
    .toBe("review");
}

async function expectPreviewState(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        if (await page.locator("#preview-panel").isVisible()) {
          return "preview";
        }
        if (await page.locator("#error-panel").isVisible()) {
          const windows = await page.evaluate(async () => {
            const values = await chrome.windows.getAll({ populate: true });
            return values.map((window) => ({
              focused: window.focused,
              id: window.id,
              tabs: window.tabs?.map((tab) => ({ active: tab.active, id: tab.id, url: tab.url })),
            }));
          });
          return `error: ${await page.locator("#error-message").textContent()}; windows=${JSON.stringify(windows)}`;
        }
        return `pending: ${await page.locator("#status").textContent()}`;
      },
      { timeout: 10_000 },
    )
    .toBe("preview");
}
