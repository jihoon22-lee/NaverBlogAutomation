import { beforeEach, describe, expect, it, vi } from "vitest";

import { TodayController } from "../../src/app/controllers/today";

beforeEach(() => {
  document.body.innerHTML = '<main id="workspace"></main>';
});

describe("TodayController home navigation", () => {
  it("forwards the home writing action to its navigation callback", () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onWritingRequested = vi.fn();
    const controller = new TodayController(root, {
      api: {} as never,
      onWritingRequested,
    });

    controller.setView("home");
    controller.render();
    const action = document.getElementById("home-start-writing") as HTMLButtonElement | null;
    expect(action).not.toBeNull();
    action?.click();

    expect(onWritingRequested).toHaveBeenCalledOnce();
  });

  it("forwards a blocker action to the onboarding navigation callback", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onOnboardingRequested = vi.fn();
    const controller = new TodayController(root, {
      api: {
        appReadiness: vi.fn(async () => ({
          accessMode: "local",
          webAppAssetsReady: true,
          lanAddresses: [],
          browserState: "ready",
          browserLogin: "authenticated",
          ownBlogConfigured: true,
          generationAvailable: false,
          automationConsent: true,
          safetyPolicyConfigured: true,
          blockers: ["llm_provider_missing"],
        })),
        browserSession: vi.fn(async () => ({
          state: "ready",
          login: "authenticated",
          driver: "fake",
          headless: true,
          profileDir: "profile",
          openPages: 1,
          detail: null,
        })),
        discoveryQueue: vi.fn(async () => []),
        status: vi.fn(async () => ({
          status: "ready",
          apiVersion: "v1",
          appEnvironment: "test",
          database: "ready",
          generatorMode: "fake",
          generatorModel: "fake",
        })),
      } as never,
      onOnboardingRequested,
    });

    controller.setView("home");
    await controller.load();
    (document.getElementById("home-open-onboarding") as HTMLButtonElement).click();

    expect(onOnboardingRequested).toHaveBeenCalledOnce();
  });

  it("renders the independent onboarding view and forwards completion", async () => {
    const root = document.getElementById("workspace");
    if (root === null) throw new Error("missing workspace root");
    const onOnboardingCompleted = vi.fn();
    const controller = new TodayController(root, {
      api: {
        appReadiness: vi.fn(async () => ({
          accessMode: "local",
          webAppAssetsReady: true,
          lanAddresses: [],
          browserState: "ready",
          browserLogin: "authenticated",
          ownBlogConfigured: true,
          generationAvailable: true,
          automationConsent: true,
          safetyPolicyConfigured: true,
          blockers: [],
        })),
        browserSession: vi.fn(async () => ({
          state: "ready",
          login: "authenticated",
          driver: "fake",
          headless: true,
          profileDir: "profile",
          openPages: 1,
          detail: null,
        })),
        discoveryQueue: vi.fn(async () => []),
        status: vi.fn(async () => ({
          status: "ready",
          apiVersion: "v1",
          appEnvironment: "test",
          database: "ready",
          generatorMode: "fake",
          generatorModel: "fake",
        })),
      } as never,
      onOnboardingCompleted,
    });

    controller.setView("onboarding");
    await controller.load();

    expect(document.querySelector(".onboarding-shell")).not.toBeNull();
    (document.getElementById("onboarding-complete-button") as HTMLButtonElement).click();
    expect(onOnboardingCompleted).toHaveBeenCalledOnce();
  });
});
