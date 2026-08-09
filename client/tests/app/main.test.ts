import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_ROOT_ID,
  createWorkspace,
  mount,
  registerPwaShell,
  routeFromHash,
} from "../../src/app/main";

const EXTRACTION = {
  sourceUrl: "https://blog.naver.com/example/1",
  title: "합성 제목",
  selectorKind: "modern" as const,
  originalLength: 120,
  transmittedLength: 120,
  truncated: false,
  preview: "합성 본문",
};

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve));
}

function installWorkspaceApi(
  options: {
    accessMode?: "lan" | "local";
    lanAddressMissing?: boolean;
    pairFails?: boolean;
    revokeFails?: boolean;
    pairedDevices?: {
      id: string;
      device_name: string;
      last_seen_at: string;
      created_at: string;
      expires_at: string;
    }[];
  } = {},
) {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/remote/pairing-code")) {
      return response({ code: "123456", expires_at: "2026-08-01T01:00:00Z" });
    }
    if (url.includes("/remote/pair")) {
      if (options.pairFails === true) {
        return response(
          {
            type: "about:blank",
            title: "Pairing failed",
            status: 400,
            detail: "일회용 코드가 만료되었습니다.",
            code: "pairing_code_expired",
          },
          400,
        );
      }
      return response({
        device: {
          id: "11111111-1111-4111-8111-111111111111",
          device_name: "내 태블릿",
          last_seen_at: "2026-08-01T00:00:00Z",
          created_at: "2026-08-01T00:00:00Z",
          expires_at: "2026-08-01T01:00:00Z",
        },
      });
    }
    if (url.includes("/remote/devices")) {
      if (init?.method === "DELETE" && options.revokeFails === true) {
        return response(
          {
            type: "about:blank",
            title: "Revoke failed",
            status: 409,
            detail: "이미 해제된 기기입니다.",
            code: "remote_device_not_found",
          },
          409,
        );
      }
      return response({ items: options.pairedDevices ?? [] });
    }
    if (url.includes("/api/v1/status")) {
      return response({
        status: "ready",
        api_version: "v1",
        app_environment: "test",
        database: "ready",
        generator_mode: "fake",
        generator_model: "fake",
      });
    }
    if (url.includes("/app/discovery/queue")) {
      return response({
        items: [],
        counts: { neighbor: 0, search: 0, skipped: 0, total: 0 },
        next_cursor: null,
      });
    }
    if (url.includes("/app/readiness")) {
      return response({
        access_mode: options.accessMode ?? "local",
        web_app_assets_ready: true,
        lan_addresses:
          options.accessMode === "lan" && options.lanAddressMissing !== true
            ? ["192.168.0.10"]
            : [],
        browser_state: "ready",
        browser_login: "authenticated",
        own_blog_configured: true,
        generation_available: false,
        automation_consent: false,
        safety_policy_configured: false,
        blockers: ["llm_provider_missing"],
      });
    }
    if (url.includes("/automation/session")) {
      return response({
        state: "ready",
        login: "authenticated",
        driver: "fake",
        headless: true,
        profile_dir: "profile",
        open_pages: 1,
        detail: null,
      });
    }
    if (url.includes("/settings/") || url.includes("/app-settings/")) {
      return response({ kind: "test", schema_version: 1, payload: {}, updated_at: null });
    }
    if (url.includes("/digest-settings")) {
      return response({
        timezone: "Asia/Seoul",
        hour: 9,
        minute: 0,
        email_enabled: false,
        smtp_configured: false,
      });
    }
    if (url.includes("/automation/schedule")) {
      return response({
        mode: "manual",
        hour: 10,
        minute: 0,
        max_posts: 5,
        reason: "not_scheduled",
      });
    }
    return response({ items: [] });
  });
  vi.stubGlobal("fetch", handler);
  return handler;
}

describe("mount", () => {
  it("returns null when the workspace root is missing", () => {
    expect(mount()).toBeNull();
  });

  it("renders the Today view immediately and starts a load", () => {
    document.body.innerHTML = `<main id="${APP_ROOT_ID}"></main>`;

    const workspace = mount();

    expect(workspace).not.toBeNull();
    expect(document.getElementById("workspace-status")).not.toBeNull();
    expect(["idle", "loading"]).toContain(workspace?.today.state.phase);
  });

  it("uses the documented workspace root id", () => {
    expect(APP_ROOT_ID).toBe("workspace");
  });

  it("mounts each supported hash route and keeps legacy today compatible", async () => {
    installWorkspaceApi();
    for (const hash of [
      "#today",
      "#home",
      "#workbench",
      "#setup",
      "#more",
      "#activity",
      "#settings",
      "#writing/draft-one",
      "#session/session-one",
      "#post/post-one",
      "#comment/direct",
      "#comment/recommendation-one?post=post-one&source=neighbor",
    ]) {
      document.body.innerHTML = `<main id="${APP_ROOT_ID}"></main>`;
      if (document.defaultView !== null) document.defaultView.location.hash = hash;

      expect(mount()).not.toBeNull();
      await flush();
    }
  });

  it("renders the more workspace for the legacy menu alias", async () => {
    installWorkspaceApi();
    document.body.innerHTML = `
      <nav id="workspace-nav">
        <button type="button" data-section="home"></button>
        <button type="button" data-section="workbench"></button>
        <button type="button" data-section="writing"></button>
        <button type="button" data-section="more"></button>
      </nav>
      <main id="${APP_ROOT_ID}"></main>
    `;
    if (document.defaultView !== null) document.defaultView.location.hash = "#more";

    mount();
    await flush();

    expect(document.querySelector(".more-menu-panel")).not.toBeNull();
    expect(document.querySelector(".more-menu-panel h2")?.textContent).toBe("관리");
    expect(document.querySelector('[data-section="more"]')?.getAttribute("aria-current")).toBe(
      "page",
    );
  });
});

describe("registerPwaShell", () => {
  it("registers the static app shell without making API responses cacheable", () => {
    const register = vi.fn(() => Promise.resolve({}));
    vi.stubGlobal("navigator", { serviceWorker: { register } });

    registerPwaShell();

    expect(register).toHaveBeenCalledWith("./service-worker.js", { scope: "./" });
  });

  it("does nothing when service workers are unavailable", () => {
    vi.stubGlobal("navigator", {});

    expect(() => registerPwaShell()).not.toThrow();
  });
});

describe("createWorkspace", () => {
  it("switches to the comment view for an extraction", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const workspace = createWorkspace(root);

    workspace.openComment(EXTRACTION, "11111111-1111-4111-8111-111111111111");

    expect(document.getElementById("comment-status")).not.toBeNull();
    expect(document.getElementById("preview-title")?.textContent).toBe("합성 제목");
    expect(workspace.comment.state.phase).toBe("preview");
  });

  it("returns to the Today view from the comment view", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const workspace = createWorkspace(root);
    workspace.openComment(EXTRACTION, "11111111-1111-4111-8111-111111111111");

    (document.getElementById("comment-back-button") as HTMLButtonElement).click();

    expect(document.getElementById("workspace-status")).not.toBeNull();
    expect(document.getElementById("comment-status")).toBeNull();
  });

  it("keeps every workspace route and mobile-resume screen reachable with the local API", async () => {
    installWorkspaceApi();
    document.body.innerHTML = `
      <nav id="workspace-nav">
        <button type="button" data-section="home"></button>
        <button type="button" data-section="workbench"></button>
        <button type="button" data-section="writing"></button>
        <button type="button" data-section="more"></button>
        <button type="button" id="remote-pairing-code-button"></button>
      </nav>
      <main id="${APP_ROOT_ID}"></main>
    `;
    const root = document.getElementById(APP_ROOT_ID) as Element;
    const workspace = createWorkspace(root);

    workspace.showToday();
    await Promise.resolve();
    workspace.showWriting();
    await Promise.resolve();
    workspace.showSession();
    await Promise.resolve();
    workspace.showActivity();
    await Promise.resolve();
    workspace.showSettings();
    await Promise.resolve();
    document.defaultView?.dispatchEvent(new Event("pageshow"));
    document.defaultView?.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(root.querySelector(".discovery-settings-panel")).not.toBeNull();
    expect(document.defaultView?.location.hash).toBe("#settings");

    workspace.showSettings("connections");
    expect(document.defaultView?.location.hash).toBe("#settings?section=connections");
    expect(
      root.querySelector('[data-settings-section="connections"]')?.hasAttribute("hidden"),
    ).toBe(false);
  });

  it("follows shareable routes and refreshes their current screen after a tablet resumes", async () => {
    installWorkspaceApi();
    document.body.innerHTML = `<main id="${APP_ROOT_ID}"></main>`;
    const root = document.getElementById(APP_ROOT_ID) as Element;
    const workspace = createWorkspace(root);

    for (const hash of [
      "#writing/22222222-2222-4222-8222-222222222222",
      "#setup",
      "#session/33333333-3333-4333-8333-333333333333",
      "#activity",
      "#settings",
      "#post/44444444-4444-4444-8444-444444444444",
      "#comment/55555555-5555-4555-8555-555555555555?post=44444444-4444-4444-8444-444444444444&source=search",
    ]) {
      if (document.defaultView !== null) document.defaultView.location.hash = hash;
      document.defaultView?.dispatchEvent(new HashChangeEvent("hashchange"));
      await flush();
    }
    document.defaultView?.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(document.defaultView?.location.hash).toContain("#comment/");
    expect(workspace.comment.state.phase).not.toBe("generating");
  });

  it("routes hash changes across home, workbench, and more before refreshing each resumable view", async () => {
    installWorkspaceApi();
    document.body.innerHTML = `<main id="${APP_ROOT_ID}"></main>`;
    const root = document.getElementById(APP_ROOT_ID) as Element;
    const workspace = createWorkspace(root);

    for (const [hash, show] of [
      ["#home", () => workspace.showWriting()],
      ["#workbench", () => workspace.showHome()],
      ["#more", () => workspace.showWorkbench()],
      ["#home", () => workspace.showMore()],
      ["#session", () => workspace.showHome()],
      ["#writing", () => workspace.showHome()],
      ["#activity", () => workspace.showHome()],
      ["#settings", () => workspace.showHome()],
      ["#setup", () => workspace.showHome()],
    ] as const) {
      show();
      if (document.defaultView !== null) document.defaultView.location.hash = hash;
      document.defaultView?.dispatchEvent(new HashChangeEvent("hashchange"));
      document.defaultView?.dispatchEvent(new Event("pageshow"));
      await flush();
    }

    expect(document.getElementById("workspace-status")).not.toBeNull();
  });

  it("pairs a tablet, and explains a rejected one-time code without leaving the pairing screen", async () => {
    const handler = installWorkspaceApi({ pairFails: true });
    document.body.innerHTML = `
      <nav id="workspace-nav"></nav>
      <main id="${APP_ROOT_ID}"></main>
    `;
    const root = document.getElementById(APP_ROOT_ID) as Element;
    const workspace = createWorkspace(root);
    workspace.showRemotePairing();

    (document.getElementById("remote-device-name") as HTMLInputElement).value = "갤럭시 탭";
    (document.getElementById("remote-pairing-code") as HTMLInputElement).value = "123456";
    (document.getElementById("remote-pair-button") as HTMLButtonElement).click();
    await flush();

    expect(root.textContent).toContain("일회용 코드가 만료되었습니다.");
    expect(document.getElementById("remote-pair-button")?.hasAttribute("disabled")).toBe(false);
    expect(handler).toHaveBeenCalledWith(
      "/api/v1/remote/pair",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("explains local-only pairing and returns to Today after a successful tablet pairing", async () => {
    installWorkspaceApi();
    document.body.innerHTML = `
      <nav id="workspace-nav"><button type="button" id="remote-pairing-code-button"></button></nav>
      <main id="${APP_ROOT_ID}"></main>
    `;
    const root = document.getElementById(APP_ROOT_ID) as Element;
    const workspace = createWorkspace(root);

    workspace.showRemotePairingCode();
    await flush();
    expect(root.textContent).toContain("태블릿 연결은 아직 켜지지 않았습니다.");

    workspace.showRemotePairing();
    (document.getElementById("remote-pairing-code") as HTMLInputElement).value = "123456";
    (document.getElementById("remote-pair-button") as HTMLButtonElement).click();
    await flush();

    expect(root.querySelector(".remote-pairing-panel")).toBeNull();
    expect(document.getElementById("workspace-nav")?.hidden).toBe(false);
  });

  it("shows, copies, and revokes a LAN pairing code from the desktop workspace", async () => {
    const handler = installWorkspaceApi({
      accessMode: "lan",
      pairedDevices: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          device_name: "iPad",
          last_seen_at: "2026-08-01T00:00:00Z",
          created_at: "2026-08-01T00:00:00Z",
          expires_at: "2026-08-01T01:00:00Z",
        },
      ],
    });
    document.body.innerHTML = `
      <nav id="workspace-nav"><button type="button" id="remote-pairing-code-button"></button></nav>
      <main id="${APP_ROOT_ID}"></main>
    `;
    const root = document.getElementById(APP_ROOT_ID) as Element;
    createWorkspace(root);

    (document.getElementById("remote-pairing-code-button") as HTMLButtonElement).click();
    await flush();

    expect(root.textContent).toContain("192.168.0.10:8765/app/");
    expect((document.getElementById("remote-pairing-code-value") as HTMLInputElement).value).toBe(
      "123456",
    );
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    const copy = Array.from(root.querySelectorAll("button")).find(
      (button) => button.textContent === "코드 복사",
    ) as HTMLButtonElement;
    copy.click();
    await flush();
    expect(root.textContent).toContain("코드가 선택되었습니다");

    (
      Array.from(root.querySelectorAll("button")).find(
        (button) => button.textContent === "연결 해제",
      ) as HTMLButtonElement
    ).click();
    await flush();
    expect(handler).toHaveBeenCalledWith(
      "/api/v1/remote/devices/11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(root.textContent).toContain("아직 연결된 기기가 없습니다.");
  });

  it("keeps a paired device visible when revocation is rejected", async () => {
    installWorkspaceApi({
      accessMode: "lan",
      revokeFails: true,
      pairedDevices: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          device_name: "iPad",
          last_seen_at: "2026-08-01T00:00:00Z",
          created_at: "2026-08-01T00:00:00Z",
          expires_at: "2026-08-01T01:00:00Z",
        },
      ],
    });
    document.body.innerHTML = `<main id="${APP_ROOT_ID}"></main>`;
    const root = document.getElementById(APP_ROOT_ID) as Element;
    const workspace = createWorkspace(root);
    workspace.showRemotePairingCode();
    await flush();

    (root.querySelector("button:last-child") as HTMLButtonElement).click();
    await flush();

    expect(root.textContent).toContain("이미 해제된 기기입니다.");
    expect(root.textContent).toContain("연결 해제");
  });

  it("copies a LAN pairing code through the Clipboard API when the browser permits it", async () => {
    installWorkspaceApi({ accessMode: "lan" });
    document.body.innerHTML = `<main id="${APP_ROOT_ID}"></main>`;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const root = document.getElementById(APP_ROOT_ID) as Element;
    const workspace = createWorkspace(root);
    workspace.showRemotePairingCode();
    await flush();

    (
      Array.from(root.querySelectorAll("button")).find(
        (button) => button.textContent === "코드 복사",
      ) as HTMLButtonElement
    ).click();
    await flush();

    expect(writeText).toHaveBeenCalledWith("123456");
    expect(root.textContent).toContain("코드를 복사했습니다.");
  });

  it("gives a recoverable explanation when LAN mode has no usable address", async () => {
    installWorkspaceApi({ accessMode: "lan", lanAddressMissing: true });
    document.body.innerHTML = `<main id="${APP_ROOT_ID}"></main>`;
    const root = document.getElementById(APP_ROOT_ID) as Element;
    const workspace = createWorkspace(root);

    workspace.showRemotePairingCode();
    await flush();

    expect(root.textContent).toContain("태블릿 연결을 완료하지 못했습니다.");
  });
});

describe("navigation", () => {
  function shell(): Element {
    document.body.innerHTML = `
      <nav id="workspace-nav">
        <button type="button" data-section="home" aria-current="page"></button>
        <button type="button" data-section="workbench"></button>
        <button type="button" data-section="writing"></button>
        <button type="button" data-section="more"></button>
      </nav>
      <main id="${APP_ROOT_ID}"></main>
    `;
    const root = document.getElementById(APP_ROOT_ID);
    if (root === null) throw new Error("missing root");
    return root;
  }

  function tab(section: string): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(`[data-section="${section}"]`);
    if (button === null) throw new Error(`missing tab: ${section}`);
    return button;
  }

  it("reaches the writing workspace from the nav", () => {
    const root = shell();
    createWorkspace(root);

    tab("writing").click();

    expect(root.querySelector(".seed-panel")).not.toBeNull();
    expect(tab("writing").getAttribute("aria-current")).toBe("page");
  });

  it("opens writing from the home dashboard and updates the route and primary nav", () => {
    installWorkspaceApi();
    const root = shell();
    const workspace = createWorkspace(root);

    workspace.showHome();

    const action = document.getElementById("home-start-writing") as HTMLButtonElement | null;
    expect(action).not.toBeNull();
    action?.click();

    expect(document.defaultView?.location.hash).toBe("#writing");
    expect(tab("writing").getAttribute("aria-current")).toBe("page");
    expect(tab("home").hasAttribute("aria-current")).toBe(false);
    expect(root.querySelector(".seed-panel")).not.toBeNull();
    expect(workspace.writing.state.phase).toBe("seed");
  });

  it("opens setup from the home blocker action and keeps the home tab current", async () => {
    installWorkspaceApi();
    const root = shell();
    const workspace = createWorkspace(root);

    workspace.showHome();
    await flush();
    await flush();

    const action = document.getElementById("home-open-onboarding") as HTMLButtonElement | null;
    expect(action?.textContent).toBe("초기 설정 계속");
    action?.click();

    expect(document.defaultView?.location.hash).toBe("#setup");
    expect(tab("home").getAttribute("aria-current")).toBe("page");
    expect(document.getElementById("workspace-nav")?.hidden).toBe(false);
    expect(root.querySelector("#workspace-status")).not.toBeNull();
    expect(workspace.today.state.phase).toBe("loading");
    await flush();
    expect(workspace.today.state.phase).toBe("ready");
  });

  it("renders the independent setup route with home navigation ownership", () => {
    installWorkspaceApi();
    const root = shell();
    const workspace = createWorkspace(root);

    workspace.showOnboarding();

    expect(document.defaultView?.location.hash).toBe("#setup");
    expect(tab("home").getAttribute("aria-current")).toBe("page");
    expect(document.getElementById("workspace-nav")?.hidden).toBe(false);
    expect(root.querySelector("#workspace-status")).not.toBeNull();
    expect(root.contains(document.activeElement)).toBe(true);
  });

  it("returns to the workbench from the nav", () => {
    const root = shell();
    const workspace = createWorkspace(root);
    workspace.showWriting();

    tab("workbench").click();

    expect(tab("workbench").getAttribute("aria-current")).toBe("page");
    expect(tab("writing").hasAttribute("aria-current")).toBe(false);
  });

  it("moves focus into the workspace on a section change", () => {
    const root = shell();
    const workspace = createWorkspace(root);

    workspace.showWriting();

    expect(root.contains(document.activeElement)).toBe(true);
  });

  it("keeps the workbench tab current while the comment view is open", () => {
    const root = shell();
    const workspace = createWorkspace(root);
    workspace.showWriting();

    workspace.openComment(EXTRACTION, "11111111-1111-4111-8111-111111111111");

    expect(tab("workbench").getAttribute("aria-current")).toBe("page");
  });

  it("reaches the more menu from the nav", () => {
    const root = shell();
    createWorkspace(root);

    tab("more").click();

    expect(root.querySelector(".more-menu-panel")).not.toBeNull();
    expect(tab("more").getAttribute("aria-current")).toBe("page");
  });

  it("works without a nav in the shell", () => {
    document.body.innerHTML = `<main id="${APP_ROOT_ID}"></main>`;
    const root = document.getElementById(APP_ROOT_ID);
    if (root === null) throw new Error("missing root");

    const workspace = createWorkspace(root);
    workspace.showWriting();

    expect(root.querySelector(".seed-panel")).not.toBeNull();
  });

  it("maps documented hash routes to their owning workspace section", () => {
    expect(routeFromHash("#today")).toBe("home");
    expect(routeFromHash("#home")).toBe("home");
    expect(routeFromHash("#setup")).toBe("onboarding");
    expect(routeFromHash("#more")).toBe("more");
    expect(routeFromHash("#workbench")).toBe("workbench");
    expect(routeFromHash("#queue")).toBe("workbench");
    expect(routeFromHash("#batch")).toBe("workbench");
    expect(routeFromHash("#history")).toBe("activity");
    expect(routeFromHash("#logs")).toBe("activity");
    expect(routeFromHash("#config")).toBe("settings");
    expect(routeFromHash("#devices")).toBe("more");
    expect(routeFromHash("#pairing-code")).toBe("more");
    expect(routeFromHash("#post/a-post-id")).toBe("post");
    expect(routeFromHash("#writing/draft-id")).toBe("writing");
    expect(routeFromHash("#settings/comment")).toBe("settings");
    expect(routeFromHash("#unknown")).toBeNull();
  });

  it("shows the one-time-code form and hides normal navigation for an unpaired tablet", () => {
    const root = shell();
    const workspace = createWorkspace(root);

    workspace.showRemotePairing();

    expect(root.querySelector(".remote-pairing-panel")).not.toBeNull();
    expect(document.getElementById("workspace-nav")?.hidden).toBe(true);
  });
});
