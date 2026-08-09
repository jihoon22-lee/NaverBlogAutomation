/** Packaged web-app journey without loading the legacy extension. */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

import { expect, test } from "@playwright/test";
import { chromium, type Browser, type Page } from "playwright";

import { resolveApiCommand } from "./api-command.js";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(extensionRoot, "..");
const apiOrigin = "http://127.0.0.1:8765";
type ApiProcess = ChildProcessByStdio<null, Readable, Readable>;

interface RunningApi {
  dispose(): Promise<void>;
}

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet portrait", width: 768, height: 1024 },
  { name: "tablet landscape", width: 1024, height: 768 },
  { name: "phone", width: 320, height: 720 },
] as const;

async function assertAccessibleViewport(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        "#workspace button, #workspace select, #workspace textarea, #workspace input:not([type='checkbox']):not([type='radio']):not([type='file']), #workspace summary, #workspace label:has(> input[type='checkbox']), #workspace label:has(> input[type='radio'])",
      ),
    ].filter((element) => !element.hidden && element.getClientRects().length > 0);
    return {
      documentWidth: document.documentElement.scrollWidth,
      undersized: controls.flatMap((element) => {
        const rect = element.getBoundingClientRect();
        return rect.height < 44 || rect.width < 44
          ? [`${element.tagName.toLowerCase()}#${element.id || "(no-id)"}`]
          : [];
      }),
      viewportWidth: window.innerWidth,
    };
  });
  expect(layout.documentWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.undersized, JSON.stringify(layout)).toEqual([]);
}

for (const viewport of VIEWPORTS) {
  test(`packaged web app resumes the workbench at ${viewport.name}`, async () => {
    let api: RunningApi | null = null;
    let browser: Browser | null = null;
    try {
      api = await startApi();
      const postId = await seedQueuedPost();
      const draftId = await seedDraft();
      browser = await chromium.launch({ channel: "chromium", headless: true });
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      await page.route("**/api/v1/app/readiness*", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            access_mode: "local",
            web_app_assets_ready: true,
            lan_addresses: [],
            browser_state: "ready",
            browser_login: "authenticated",
            own_blog_configured: true,
            generation_available: false,
            automation_consent: true,
            safety_policy_configured: true,
            blockers: ["llm_provider_missing"],
          }),
        });
      });
      await page.goto(`${apiOrigin}/app/`);
      await expect(page.locator("#workspace-status")).toContainText("오늘의 블로그 작업");
      await expect(page.locator("#skip-link")).toHaveAttribute("href", "#workspace");
      await expect(page.locator("#workspace")).not.toHaveAttribute("aria-live");
      await expect(page.locator("#workspace-nav button[data-section]")).toHaveCount(4);
      for (const [section, label] of [
        ["home", "홈"],
        ["workbench", "작업함"],
        ["writing", "글쓰기"],
        ["more", "관리"],
      ] as const) {
        const button = page.locator(`[data-section="${section}"]`);
        await expect(button).toHaveAccessibleName(label);
        await expect(button.locator("svg.nav-icon")).toHaveCount(1);
        await expect(button.locator("svg.nav-icon")).toHaveAttribute("aria-hidden", "true");
        await expect(button.locator("span.nav-label")).toHaveText(label);
      }
      await expect(page.locator(".home-hero")).toBeVisible();
      await expect(page.locator('[data-metric="total"]')).toHaveCount(1);
      await expect(page.locator(".home-primary-action")).toBeVisible();
      await expect(page.locator("#home-open-onboarding")).toHaveText("초기 설정 계속");
      await expect(page.locator("#home-start-writing")).toBeVisible();
      await assertAccessibleViewport(page);

      await page.locator("#skip-link").focus();
      await expect(page.locator("#skip-link")).toBeFocused();
      await page.locator("#skip-link").press("Enter");
      await expect
        .poll(async () => page.evaluate(() => document.activeElement?.id ?? ""))
        .toMatch(/^workspace(?:-status)?$/u);

      await page.locator("#home-open-onboarding").click();
      await expect(page).toHaveURL(/#setup$/);
      await expect(page.locator(".onboarding-shell")).toBeVisible();
      await expect(page.locator('.onboarding-step[data-state="current"]')).toHaveAttribute(
        "data-step",
        "ai",
      );
      await expect(page.locator(".onboarding-primary-action")).toHaveCount(1);
      await expect(page.locator('[data-section="home"]')).toHaveAttribute("aria-current", "page");
      await page.locator('[data-section="home"]').click();
      await page.unroute("**/api/v1/app/readiness*");

      await page.locator("#home-start-writing").click();
      await expect(page).toHaveURL(/#writing$/);
      await expect(page.locator("#writing-status")).toContainText("본문");
      await expect(page.locator('[data-section="writing"]')).toHaveAttribute(
        "aria-current",
        "page",
      );
      await page.locator('[data-section="home"]').click();
      await expect(page.locator(".home-hero")).toBeVisible();
      await page.goto(`${apiOrigin}/app/#today`);
      await expect(page.locator('[data-section="home"]')).toHaveAttribute("aria-current", "page");

      await page.locator('[data-section="workbench"]').click();
      await expect(page.locator(".queue-panel")).toBeVisible();
      await expect(page.locator(".workbench-header")).toBeVisible();
      await expect(page.locator(".workbench-header-summary")).toHaveAttribute(
        "aria-label",
        "작업함 요약",
      );
      await expect(page.locator('.workbench-header-metric[data-metric="active"]')).toContainText(
        "1",
      );
      const serviceDetails = page.locator(".workbench-service-details");
      await expect(serviceDetails.locator("summary")).toHaveText("연결 상태 상세");
      await serviceDetails.locator("summary").press("Enter");
      await expect(serviceDetails.locator(".workbench-service-details-content")).toContainText(
        "서비스",
      );
      const advancedFilters = page.locator(".queue-advanced-filters");
      await expect(advancedFilters.locator("summary")).toHaveText("고급 필터");
      await advancedFilters.locator("summary").press("Enter");
      await expect(page.locator('label[for="queue-source-filter"]')).toHaveText("출처");
      await expect(page.locator('label[for="queue-state-filter"]')).toHaveText("상태");
      await expect(page.locator('label[for="queue-sort"]')).toHaveText("정렬");
      await expect(page.locator(`#queue-batch-${postId}`)).toBeVisible();
      const queueItem = page.locator(`.queue-item[data-post-id="${postId}"]`);
      await expect(queueItem.locator(".queue-item-topline")).toBeVisible();
      await expect(queueItem.locator(".queue-item-source")).toHaveText("이웃 새 글");
      await expect(queueItem.locator(".queue-item-state")).toContainText("대기");
      await expect(queueItem.locator(".queue-item-title")).toHaveText("웹앱 배치 합성 글");
      await expect(queueItem.locator(".queue-item-meta")).toContainText("합성 이웃");
      await expect(queueItem.locator("time.queue-item-date")).toHaveAttribute("datetime");
      await page.locator("#queue-query").fill("일치하지 않는 검색어");
      await page.locator("#queue-query").press("Enter");
      await expect(page.locator(".queue-empty")).toContainText(
        "검색 또는 필터 조건에 맞는 글이 없습니다.",
      );
      await expect(page.locator("#queue-query")).toBeFocused();
      await expect(page.locator("#queue-clear-filters")).toBeVisible();
      await page.locator("#queue-clear-filters").click();
      await expect(page.locator("#queue-query")).toHaveValue("");
      await expect(queueItem).toBeVisible();
      if (viewport.width === 320) {
        expect(
          await page
            .locator(".workbench-readiness-banner")
            .evaluate((element) => element.getBoundingClientRect().height),
        ).toBeLessThan(240);
      }
      expect(await page.locator("#load-more-queue-button").count()).toBeLessThanOrEqual(1);
      await page.locator(`#queue-batch-${postId}`).check();
      await expect(page.locator(".queue-batch-preview")).toContainText("선택 순서대로 1건");
      await expect(page.locator("#open-batch-preview")).toBeEnabled();
      await page.locator("#open-batch-preview").click();
      await expect(page.locator("#session-queue-selection")).toBeVisible();
      await assertAccessibleViewport(page);

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
      await page.locator("#back-to-workbench-button").click();
      if (viewport.width <= 768) {
        await page.locator(`.queue-item[data-post-id="${postId}"]`).click();
        await expect(page.locator("#close-detail-sheet")).toBeFocused();
      }
      await expect(page.locator("#detail-title")).toHaveText("웹앱 배치 합성 글");
      await expect(page.locator("#open-post-button")).toBeDisabled();
      await expect(page.locator("#skip-post-button")).toBeVisible();
      await assertAccessibleViewport(page);
      if (viewport.width <= 768) {
        await expect(page.locator("#close-detail-sheet")).toBeVisible();
        await page.locator("#close-detail-sheet").click();
        await expect(page.locator(".detail-panel")).toBeHidden();
        await page.locator(`.queue-item[data-post-id="${postId}"]`).click();
        await expect(page.locator(".detail-panel")).toBeVisible();
      }
      await page.locator("#skip-post-button").click();
      await expect(page.locator("#skip-post-button")).toHaveText("다시 대기");
      if (viewport.width <= 768) {
        await page.locator("#close-detail-sheet").click();
        await expect(page.locator(".detail-panel")).toBeHidden();
      }
      await page.locator('[data-segment="skipped"]').click();
      await expect(page.locator(`.queue-item[data-post-id="${postId}"]`)).toBeVisible();
      if (viewport.width <= 768) {
        await page.locator(`.queue-item[data-post-id="${postId}"]`).click();
        await expect(page.locator(".detail-panel")).toBeVisible();
      }
      await page.locator("#skip-post-button").click();
      await expect(page.locator("#skip-post-button")).toHaveText("이 글 건너뛰기");
      expect(errors).toEqual([]);
      const overflow = await page.evaluate(() => {
        const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            id: element.id,
            className: element.className,
            left: Math.round(element.getBoundingClientRect().left),
            right: Math.round(element.getBoundingClientRect().right),
          }))
          .filter(({ left, right }) => left < 0 || right > window.innerWidth)
          .slice(0, 10);
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          offenders,
        };
      });
      expect(overflow.documentWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(
        overflow.viewportWidth,
      );
      const gridColumnCount = await page.evaluate(() => {
        const layout = document.querySelector<HTMLElement>(".today-layout");
        return layout === null
          ? null
          : getComputedStyle(layout).gridTemplateColumns.trim().split(/\s+/).length;
      });
      expect(gridColumnCount).not.toBeNull();
      if (viewport.width <= 768) expect(gridColumnCount).toBe(1);
      else expect(gridColumnCount).toBeGreaterThan(1);

      await page.locator('[data-section="more"]').click();
      await expect(page.locator(".more-menu-panel")).toBeVisible();
      await expect(page.locator("#more-settings")).toBeVisible();

      await page.locator('[data-section="writing"]').click();
      await expect(page.locator("#writing-status")).toContainText("본문");
      await page.locator(`[data-draft-id="${draftId}"]`).click();
      await expect(page.locator("#draft-title")).toHaveValue("웹앱 편집 합성 초안");
      await expect(page.locator(".block-canvas .editor-block")).toHaveCount(2);
      await assertAccessibleViewport(page);
      if (viewport.width === 1440 || viewport.width === 320) {
        await expect(page.locator(".writing-editor-main")).toBeVisible();
        await expect(page.locator(".writing-editor-sidebar")).toBeVisible();
        const editorOrder = await page
          .locator(".writing-editor-layout")
          .evaluate((layout) => Array.from(layout.children).map((child) => child.className));
        expect(editorOrder).toEqual(["writing-editor-main", "writing-editor-sidebar"]);
      }
      if (viewport.width === 1440) {
        const block = page.locator('[data-block-index="0"]');
        const bodyTextarea = block.locator("textarea");
        const blockTools = block.locator(".block-tools");
        await bodyTextarea.focus();
        await expect
          .poll(
            async () =>
              blockTools.evaluate((element) => {
                const styles = getComputedStyle(element);
                return { opacity: styles.opacity, pointerEvents: styles.pointerEvents };
              }),
            { timeout: 2_000 },
          )
          .toEqual({ opacity: "1", pointerEvents: "auto" });
      }
      const autosave = page.waitForRequest(
        (request) =>
          request.method() === "PUT" &&
          new URL(request.url()).pathname === `/api/v1/drafts/${draftId}/body`,
      );
      await page.locator('[data-block-index="0"] textarea').fill("수정된 첫 문단");
      const autosaveRequest = await autosave;
      expect(autosaveRequest.postDataJSON()).toMatchObject({
        blocks: [
          { type: "paragraph", text: "수정된 첫 문단" },
          { type: "heading", text: "확인할 소제목" },
        ],
      });
      await page.locator(".editor-preview summary").click();
      await expect(page.locator(".block-preview-content")).toContainText("수정된 첫 문단");
      await expect(page.locator(".autosave-status")).toHaveText("자동 저장되었습니다.");
      await page.locator("#start-new-draft-button").click();
      await expect(page).toHaveURL(/#writing$/);
      await expect(page.locator('.writing-shell[data-mode="start"]')).toBeVisible();
      await expect(page.locator("#seed-title")).toBeFocused();
      await expect(page.locator(`[data-draft-id="${draftId}"]`)).toBeVisible();
      await assertAccessibleViewport(page);
      if (viewport.width === 1440 || viewport.width === 320) {
        const writingOverflow = await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        }));
        expect(writingOverflow.documentWidth, JSON.stringify(writingOverflow)).toBeLessThanOrEqual(
          writingOverflow.viewportWidth,
        );
      }

      await page.locator('[data-section="more"]').click();
      await expect(page.locator("#more-settings")).toBeVisible();
      await page.locator("#more-settings").click();
      await expect(page.locator(".settings-navigation")).toBeVisible();
      await assertAccessibleViewport(page);
      await expect(page.locator("#runtime-openai-key")).toHaveAttribute("type", "password");
      await page.locator('.settings-navigation-item[data-settings-section="connections"]').click();
      await expect(page.locator(".runtime-data-panel")).toBeVisible();
      await assertAccessibleViewport(page);
      const download = page.waitForEvent("download");
      await page.locator("#export-runtime-data-button").click();
      await expect((await download).suggestedFilename()).toBe("naver-blog-assistant-data.zip");
      await page.locator(".runtime-data-reset summary").press("Enter");
      await expect(page.locator("#runtime-data-reset-confirmation")).toBeVisible();
      await expect(page.locator("#reset-runtime-data-button")).toBeDisabled();
      await page.locator("#runtime-data-reset-confirmation").fill("RESET LOCAL DATA");
      await expect(page.locator("#reset-runtime-data-button")).toBeEnabled();
      await page.locator("#runtime-data-reset-confirmation").fill("");
      await assertAccessibleViewport(page);

      const shellCache = await page.evaluate(async () => {
        if (!("serviceWorker" in navigator)) return { registered: false, apiCached: false };
        await navigator.serviceWorker.ready;
        const entries = (await caches.keys()).flatMap(async (name) => {
          const cache = await caches.open(name);
          return (await cache.keys()).map((request) => new URL(request.url).pathname);
        });
        const paths = (await Promise.all(entries)).flat();
        return {
          registered: true,
          apiCached: paths.some((path) => path.startsWith("/api/")),
          shellCached: paths.includes("/app/app.js"),
        };
      });
      expect(shellCache).toMatchObject({ registered: true, apiCached: false, shellCached: true });
    } finally {
      await browser?.close();
      await api?.dispose();
    }
  });
}

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

async function seedDraft(): Promise<string> {
  const draft = await apiJson<{ id: string }>("/api/v1/drafts", {
    method: "POST",
    body: { title: "웹앱 편집 합성 초안", seed_text: "작업함과 글쓰기 흐름을 확인합니다." },
  });
  await apiJson(`/api/v1/drafts/${draft.id}/body`, {
    method: "PUT",
    body: {
      title: "웹앱 편집 합성 초안",
      blocks: [
        { type: "paragraph", text: "첫 문단" },
        { type: "heading", text: "확인할 소제목" },
      ],
      summary: "웹앱 E2E working copy",
    },
  });
  return draft.id;
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
    NBA_RUNTIME_CONFIG_FILE: join(dirname(databasePath), "runtime.env"),
    NBA_SUPERVISOR_RESTART_FILE: join(dirname(databasePath), "restart.marker"),
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
  if (apiProcess.exitCode !== null) {
    // `uv run` can exit before its API child; the detached process group still belongs to this
    // test, so close that group before checking the listening socket.
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
