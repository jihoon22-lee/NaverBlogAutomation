import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppReadiness } from "../../src/app/api/types";
import { initialTodayState, type TodayState } from "../../src/app/state/today";
import { renderOnboarding, type OnboardingHandlers } from "../../src/app/views/onboarding";

function mountRoot(): Element {
  document.body.innerHTML = '<main id="workspace"></main>';
  return document.getElementById("workspace") as Element;
}

function readiness(overrides: Partial<AppReadiness> = {}): AppReadiness {
  return {
    accessMode: "local",
    webAppAssetsReady: false,
    lanAddresses: [],
    browserState: "stopped",
    browserLogin: "anonymous",
    ownBlogConfigured: false,
    generationAvailable: false,
    automationConsent: false,
    safetyPolicyConfigured: false,
    blockers: [],
    ...overrides,
  };
}

function completeReadiness(): AppReadiness {
  return readiness({
    webAppAssetsReady: true,
    generationAvailable: true,
    ownBlogConfigured: true,
    browserState: "ready",
    browserLogin: "authenticated",
    automationConsent: true,
    safetyPolicyConfigured: true,
  });
}

function state(overrides: Partial<TodayState> = {}): TodayState {
  return {
    ...initialTodayState(),
    phase: "ready",
    readiness: readiness(),
    ...overrides,
  };
}

function handlers(): OnboardingHandlers {
  return {
    onLaunchSession: vi.fn(),
    onFocusSession: vi.fn(),
    onOpenSettings: vi.fn(),
    onRefresh: vi.fn(),
    onComplete: vi.fn(),
  };
}

function primary(): HTMLButtonElement {
  return document.querySelector(".onboarding-primary-action") as HTMLButtonElement;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("renderOnboarding", () => {
  it("renders one accessible status, ordered steps, progress, and the app action", () => {
    const root = mountRoot();
    const viewHandlers = handlers();

    renderOnboarding(root, state(), viewHandlers);

    expect(document.querySelectorAll("#workspace-status")).toHaveLength(1);
    expect(document.querySelector("#workspace-status")?.getAttribute("role")).toBe("status");
    expect(document.querySelector(".onboarding-shell")).not.toBeNull();
    expect(document.querySelector(".onboarding-hero h2")?.textContent).toContain("처음 사용하기");
    expect(document.querySelector(".onboarding-hero h1")).toBeNull();

    const steps = Array.from(document.querySelectorAll<HTMLElement>(".onboarding-step"));
    expect(steps).toHaveLength(6);
    expect(steps.map((step) => step.dataset.step)).toEqual([
      "app",
      "ai",
      "blog",
      "browser",
      "login",
      "safety",
    ]);
    expect(steps.map((step) => step.dataset.state)).toEqual([
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
    expect(steps.map((step) => step.textContent)).toEqual([
      "1앱 준비현재",
      "2AI 연결예정",
      "3내 블로그예정",
      "4자동화 브라우저예정",
      "5네이버 로그인예정",
      "6안전 설정예정",
    ]);
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(document.querySelector(".onboarding-progress progress")?.getAttribute("max")).toBe("6");
    expect(
      document.querySelector(".onboarding-progress progress")?.getAttribute("aria-label"),
    ).toBe("초기 설정 진행률");
    expect(document.querySelector(".onboarding-progress-label")?.textContent).toBe("0/6 완료");
    expect(document.querySelectorAll(".onboarding-primary-action")).toHaveLength(1);
    expect(primary().textContent).toBe("다시 확인");
    primary().click();
    expect(viewHandlers.onRefresh).toHaveBeenCalledOnce();
  });

  it("marks completed steps and advances the current step in the required order", () => {
    const root = mountRoot();
    const stepCases: readonly {
      current: string;
      readiness: AppReadiness;
      completed: number;
    }[] = [
      { current: "app", readiness: readiness(), completed: 0 },
      {
        current: "ai",
        readiness: readiness({ webAppAssetsReady: true }),
        completed: 1,
      },
      {
        current: "blog",
        readiness: readiness({ webAppAssetsReady: true, generationAvailable: true }),
        completed: 2,
      },
      {
        current: "browser",
        readiness: readiness({
          webAppAssetsReady: true,
          generationAvailable: true,
          ownBlogConfigured: true,
        }),
        completed: 3,
      },
      {
        current: "login",
        readiness: readiness({
          webAppAssetsReady: true,
          generationAvailable: true,
          ownBlogConfigured: true,
          browserState: "ready",
        }),
        completed: 4,
      },
      {
        current: "safety",
        readiness: readiness({
          webAppAssetsReady: true,
          generationAvailable: true,
          ownBlogConfigured: true,
          browserState: "ready",
          browserLogin: "authenticated",
        }),
        completed: 5,
      },
    ];

    for (const testCase of stepCases) {
      renderOnboarding(root, state({ readiness: testCase.readiness }), handlers());
      const current = document.querySelector<HTMLElement>(".onboarding-step[data-state=current]");
      expect(current?.dataset.step).toBe(testCase.current);
      expect(document.querySelectorAll('.onboarding-step[data-state="complete"]')).toHaveLength(
        testCase.completed,
      );
      expect(
        (document.querySelector(".onboarding-progress progress") as HTMLProgressElement).value,
      ).toBe(testCase.completed);
      expect(document.querySelector(".onboarding-progress-label")?.textContent).toBe(
        `${testCase.completed}/6 완료`,
      );
      expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    }
  });

  it("delegates each current step action to the matching handler and section", () => {
    const root = mountRoot();
    const cases: readonly {
      readiness: AppReadiness;
      label: string;
      assert(viewHandlers: OnboardingHandlers): void;
      section?: string;
    }[] = [
      {
        readiness: readiness(),
        label: "다시 확인",
        assert: (viewHandlers) => expect(viewHandlers.onRefresh).toHaveBeenCalledOnce(),
      },
      {
        readiness: readiness({ webAppAssetsReady: true }),
        label: "AI 연결 설정 열기",
        assert: (viewHandlers) => expect(viewHandlers.onOpenSettings).toHaveBeenCalledOnce(),
        section: "connections",
      },
      {
        readiness: readiness({ webAppAssetsReady: true, generationAvailable: true }),
        label: "내 블로그 설정 열기",
        assert: (viewHandlers) => expect(viewHandlers.onOpenSettings).toHaveBeenCalledOnce(),
        section: "automation",
      },
      {
        readiness: readiness({
          webAppAssetsReady: true,
          generationAvailable: true,
          ownBlogConfigured: true,
        }),
        label: "브라우저 시작",
        assert: (viewHandlers) => expect(viewHandlers.onLaunchSession).toHaveBeenCalledOnce(),
      },
      {
        readiness: readiness({
          webAppAssetsReady: true,
          generationAvailable: true,
          ownBlogConfigured: true,
          browserState: "ready",
        }),
        label: "PC 브라우저 열기",
        assert: (viewHandlers) => expect(viewHandlers.onFocusSession).toHaveBeenCalledOnce(),
      },
      {
        readiness: readiness({
          webAppAssetsReady: true,
          generationAvailable: true,
          ownBlogConfigured: true,
          browserState: "ready",
          browserLogin: "authenticated",
        }),
        label: "안전 설정 열기",
        assert: (viewHandlers) => expect(viewHandlers.onOpenSettings).toHaveBeenCalledOnce(),
        section: "automation",
      },
    ];

    for (const testCase of cases) {
      const viewHandlers = handlers();
      renderOnboarding(root, state({ readiness: testCase.readiness }), viewHandlers);
      expect(primary().textContent).toBe(testCase.label);
      primary().click();
      if (testCase.section !== undefined) {
        expect(viewHandlers.onOpenSettings).toHaveBeenCalledWith(testCase.section);
      }
      testCase.assert(viewHandlers);
    }
  });

  it("explains safety gaps and browser transition states", () => {
    const root = mountRoot();
    const base = {
      webAppAssetsReady: true,
      generationAvailable: true,
      ownBlogConfigured: true,
      browserState: "ready" as const,
      browserLogin: "authenticated" as const,
    };

    renderOnboarding(
      root,
      state({
        readiness: readiness({ ...base, automationConsent: false, safetyPolicyConfigured: true }),
      }),
      handlers(),
    );
    expect(document.querySelector(".onboarding-current-description")?.textContent).toContain(
      "자동 실행 동의",
    );

    renderOnboarding(
      root,
      state({
        readiness: readiness({ ...base, automationConsent: true, safetyPolicyConfigured: false }),
      }),
      handlers(),
    );
    expect(document.querySelector(".onboarding-current-description")?.textContent).toContain(
      "안전 정책",
    );

    for (const [browserState, message] of [
      ["launching", "시작하는 중"],
      ["closing", "종료되는 중"],
    ] as const) {
      const viewHandlers = handlers();
      renderOnboarding(
        root,
        state({ readiness: readiness({ ...base, browserState }) }),
        viewHandlers,
      );
      expect(document.querySelector(".onboarding-current-description")?.textContent).toContain(
        message,
      );
      expect(primary().textContent).toBe("상태 다시 확인");
      primary().click();
      expect(viewHandlers.onRefresh).toHaveBeenCalledOnce();
    }
  });

  it("keeps retry available for idle, loading, failure, and null readiness states", () => {
    const root = mountRoot();

    renderOnboarding(root, { ...initialTodayState(), phase: "idle" }, handlers());
    expect(primary().disabled).toBe(false);
    expect(primary().textContent).toBe("다시 확인");

    renderOnboarding(root, { ...initialTodayState(), phase: "loading" }, handlers());
    expect(primary().disabled).toBe(true);
    expect(primary().textContent).toBe("다시 확인");
    expect(document.getElementById("workspace-status")?.textContent).toContain("확인하는 중");

    const viewHandlers = handlers();
    renderOnboarding(
      root,
      { ...initialTodayState(), phase: "failed", error: "연결 실패" },
      viewHandlers,
    );
    expect(primary().disabled).toBe(false);
    expect(primary().textContent).toBe("다시 시도");
    expect(document.querySelector(".onboarding-current-description")?.textContent).toContain(
      "연결 실패",
    );
    primary().click();
    expect(viewHandlers.onRefresh).toHaveBeenCalledOnce();

    renderOnboarding(root, { ...initialTodayState(), phase: "failed", error: null }, handlers());
    expect(document.querySelector(".onboarding-current-description")?.textContent).toContain(
      "설정 상태를 확인하지 못했습니다",
    );

    const retainedReadinessHandlers = handlers();
    renderOnboarding(
      root,
      state({
        phase: "failed",
        error: "상태 갱신 실패",
        readiness: readiness({ webAppAssetsReady: true }),
      }),
      retainedReadinessHandlers,
    );
    expect(primary().textContent).toBe("다시 시도");
    primary().click();
    expect(retainedReadinessHandlers.onRefresh).toHaveBeenCalledOnce();

    const failedCompleteHandlers = handlers();
    renderOnboarding(
      root,
      state({ phase: "failed", error: "오래된 상태", readiness: completeReadiness() }),
      failedCompleteHandlers,
    );
    expect(
      (document.querySelector('.onboarding-step[data-step="app"]') as HTMLElement)?.dataset.state,
    ).toBe("current");
    expect(primary().textContent).toBe("다시 시도");
    primary().click();
    expect(failedCompleteHandlers.onRefresh).toHaveBeenCalledOnce();

    renderOnboarding(root, { ...initialTodayState(), phase: "ready", readiness: null }, handlers());
    expect(primary().disabled).toBe(false);
    expect(document.getElementById("workspace-status")?.textContent).toContain(
      "확인할 수 없습니다",
    );
  });

  it("renders a single completion CTA after all six checks pass", () => {
    const root = mountRoot();
    const viewHandlers = handlers();

    renderOnboarding(root, state({ readiness: completeReadiness() }), viewHandlers);

    expect(document.querySelector(".onboarding-complete")).not.toBeNull();
    expect(document.querySelector(".onboarding-current-panel")).toBeNull();
    expect(
      (document.querySelector(".onboarding-progress progress") as HTMLProgressElement).value,
    ).toBe(6);
    expect(document.querySelector(".onboarding-progress-label")?.textContent).toBe("6/6 완료");
    expect(document.querySelectorAll('.onboarding-step[data-state="complete"]')).toHaveLength(6);
    expect(document.querySelectorAll(".onboarding-primary-action")).toHaveLength(1);
    expect(primary().textContent).toBe("홈으로 돌아가기");
    expect(document.getElementById("workspace-status")?.textContent).toContain("완료했습니다");
    primary().click();
    expect(viewHandlers.onComplete).toHaveBeenCalledOnce();
  });
});
