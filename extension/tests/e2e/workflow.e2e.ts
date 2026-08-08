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
const neighborEngagementUrl = "https://blog.naver.com/neighborcase/2001";
const searchEngagementUrl = "https://blog.naver.com/searchcase/2002";
const unconfirmedEngagementUrl = "https://blog.naver.com/neighborcase/2003?mode=unconfirmed";
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
    await panel.setViewportSize({ width: 360, height: 800 });
    await expect(panel.locator("#workspace-today")).toBeVisible();
    await expect(panel.locator("#workspace-comment")).toBeHidden();
    expect(
      await panel.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await openCommentWorkspace(panel);
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
    await panel.locator("#preview-panel .advanced-preferences > summary").click();
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
    await openCommentWorkspace(panel);
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

    await panel.locator('#candidate-list input[name="candidate"]').first().check();
    await panel.locator("#edited-use-button").click();
    await expect(panel.locator("#review-status")).toHaveText("승인됨");

    await panel.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>("#change-options-button");
      if (button === null) throw new Error("Change options control is unavailable");
      button.click();
    });
    await expectPreviewState(panel);
    await panel.locator("#preview-panel .advanced-preferences > summary").click();
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
    await panel.locator("#edited-use-button").click();
    await expect(panel.locator("#review-status")).toHaveText("승인됨");
    await expect(panel.locator("#review-notice")).toContainText("직접 붙여넣어");

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
    await openCommentWorkspace(panel);
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

    await panel.locator("#workspace-history-button").click();
    await expect(panel.locator("#workspace-history")).toBeVisible();
    await panel.locator("#history-refresh-button").click();
    await expect(panel.locator("#history-list .history-item")).toHaveCount(3);
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

test("built production Side Panel completes neighbor and search engagement and restores unconfirmed history", async () => {
  const staged = await stageExtension();
  const profile = await mkdtemp(join(tmpdir(), "naver-blog-assistant-engagement-profile-"));
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
    const extensionOrigin = `chrome-extension://${extensionId}`;
    api = await startApi(extensionOrigin);
    await seedEngagementPosts();

    const fixture = await readFile(
      resolve(extensionRoot, "tests/fixtures/naver-engagement.html"),
      "utf8",
    );
    for (const url of [neighborEngagementUrl, searchEngagementUrl, unconfirmedEngagementUrl]) {
      await context.route(`${url.split("?")[0]}*`, (route) =>
        route.fulfill({ body: fixture, contentType: "text/html; charset=utf-8", status: 200 }),
      );
    }
    const blogPage = context.pages()[0] ?? (await context.newPage());
    await blogPage.goto(neighborEngagementUrl);
    await blogPage.bringToFront();
    await triggerExtensionAction(context, blogPage, extensionId);
    const panel = await context.newPage();
    await panel.goto(`${extensionOrigin}/sidepanel.html`);
    await panel.setViewportSize({ width: 360, height: 800 });
    await enableEngagementConsent(panel);

    await openQueuedPost(panel, blogPage, "neighbor", "합성 이웃 교류 글");
    await completeCurrentEngagement(panel, blogPage, "교류 완료");
    await expect(blogPage.locator(".u_likeit_list_btn")).toHaveAttribute("aria-pressed", "true");
    await expect(blogPage.locator(".u_cbox_comment")).toHaveCount(1);

    await panel.locator("#back-today-button").click();
    await openQueuedPost(panel, blogPage, "search", "합성 검색 교류 글");
    await completeCurrentEngagement(panel, blogPage, "교류 완료");
    await expect(blogPage.locator(".notice")).toContainText("서로이웃 신청이 완료");

    await panel.locator("#back-today-button").click();
    await openQueuedPost(panel, blogPage, "neighbor", "합성 미확인 교류 글");
    await completeCurrentEngagement(panel, blogPage, "확인 필요");
    await expect(panel.locator("#engagement-run-button")).toBeDisabled();

    await panel.reload();
    await panel.locator("#workspace-history-button").click();
    await expect(panel.locator("#history-list")).toContainText("댓글 · 확인 필요");
  } finally {
    await api?.dispose();
    await context?.close();
    await staged.dispose();
    await rm(profile, { force: true, recursive: true });
  }
});

async function enableEngagementConsent(panel: Page): Promise<void> {
  await panel.locator("#workspace-settings-button").click();
  await panel.locator("#engagement-consent-card summary").click();
  await expect(panel.locator("#engagement-consent-status")).toContainText("동의하지 않음");
  await panel.locator("#engagement-consent-checkbox").check();
  await panel.locator("#engagement-consent-agree").click();
  await expect(panel.locator("#engagement-consent-status")).toContainText("동의함");
  await panel.locator("#workspace-today-button").click();
}

async function openQueuedPost(
  panel: Page,
  blogPage: Page,
  source: "neighbor" | "search",
  title: string,
): Promise<void> {
  await panel.locator(`#discovery-${source}-tab`).click();
  const item = panel.locator("#discovery-queue li", { hasText: title });
  await expect(item).toBeVisible();
  const postId = await item.locator('button[data-action="open"]').getAttribute("data-post-id");
  await blogPage.bringToFront();
  await panel.evaluate((id) => {
    document
      .querySelector<HTMLButtonElement>(`button[data-post-id="${id}"][data-action="open"]`)
      ?.click();
  }, postId);
  await expect(panel.locator("#workspace-comment")).toBeVisible();
  await expect(panel.locator("#post-title")).toHaveText("합성 교류 글");
}

async function completeCurrentEngagement(
  panel: Page,
  _blogPage: Page,
  expectedResult: "교류 완료" | "확인 필요",
): Promise<void> {
  await panel.locator("#generate-button").click();
  await expect(panel.locator("#review-panel")).toBeVisible();
  await panel.locator('#candidate-list input[name="candidate"]').first().check();
  await panel.locator("#edited-use-button").click();
  if (expectedResult === "교류 완료") {
    await expect(panel.locator("#review-status")).toHaveText("교류 완료");
  } else {
    await expect(panel.locator("#engagement-step-results")).toContainText("확인 필요");
  }
}

async function seedEngagementPosts(): Promise<void> {
  const neighbor = await apiJson<{ id: string }>("/api/v1/discovery/neighbors", {
    blog_id: "neighborcase",
    blog_url: "https://blog.naver.com/neighborcase",
    enabled: true,
    name: "합성 이웃",
  });
  await apiJson("/api/v1/discovery/import", {
    neighbor_id: neighbor.id,
    posts: [
      {
        publisher_blog_id: "neighborcase",
        publisher_name: "합성 이웃",
        source_url: neighborEngagementUrl,
        title: "합성 이웃 교류 글",
      },
      {
        publisher_blog_id: "neighborcase",
        publisher_name: "합성 이웃",
        source_url: unconfirmedEngagementUrl,
        title: "합성 미확인 교류 글",
      },
    ],
    source: "neighbor",
  });
  const search = await apiJson<{ id: string }>("/api/v1/discovery/searches", {
    enabled: true,
    excluded_terms: [],
    freshness_days: 14,
    query: "합성",
  });
  await apiJson("/api/v1/discovery/import", {
    posts: [
      {
        published_at: new Date().toISOString(),
        publisher_blog_id: "searchcase",
        publisher_name: "합성 검색 후보",
        source_url: searchEngagementUrl,
        title: "합성 검색 교류 글",
      },
    ],
    search_id: search.id,
    source: "search",
  });
}

async function apiJson<T = unknown>(path: string, body: object): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

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
    "permissions",
    "scripting",
    "sidePanel",
    "storage",
  ]);
  expect(productionManifest.host_permissions).toEqual(["http://127.0.0.1:8765/*"]);
  expect(productionManifest.optional_host_permissions).toEqual([
    "https://blog.naver.com/*",
    "https://m.blog.naver.com/*",
  ]);
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
    await waitForHealth(apiProcess, () => output, extensionOrigin);
  } catch (error) {
    await terminate(apiProcess);
    await waitForPortClosed();
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
  return {
    async dispose(): Promise<void> {
      await terminate(apiProcess);
      await waitForPortClosed();
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

async function waitForHealth(
  apiProcess: ApiProcess,
  output: () => string,
  extensionOrigin: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null) {
      throw new Error(`Local API exited before health check passed.\n${output()}`);
    }
    try {
      const response = await fetch(`${apiOrigin}/health`, {
        headers: { Origin: extensionOrigin },
        signal: AbortSignal.timeout(500),
      });
      if (
        response.status === 200 &&
        (await response.text()) === '{"status":"ok"}' &&
        response.headers.get("access-control-allow-origin") === extensionOrigin
      ) {
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
    signalProcessGroup(apiProcess, "SIGKILL");
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
  signalProcessGroup(apiProcess, "SIGKILL");
}

/** Avoid handing the next E2E case a still-listening child after its process has exited. */
async function waitForPortClosed(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${apiOrigin}/health`, { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local API port 8765 remained open after the E2E child exited.");
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

async function openCommentWorkspace(page: Page): Promise<void> {
  await page.locator("#workspace-comment-button").click();
  await expect(page.locator("#workspace-comment")).toBeVisible();
  await expect(page.locator("#workspace-comment-button")).toHaveAttribute("aria-current", "page");
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
