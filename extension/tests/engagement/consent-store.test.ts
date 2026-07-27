import { describe, expect, it } from "vitest";

import {
  ENGAGEMENT_CONSENT_STORAGE_KEY,
  ENGAGEMENT_CONSENT_VERSION,
  EngagementConsentStore,
  type ConsentStorageArea,
} from "../../src/engagement/consent-store";

class MemoryStorage implements ConsentStorageArea {
  value: Record<string, unknown> = {};
  writes: Record<string, unknown>[] = [];

  async get(): Promise<Record<string, unknown>> {
    return structuredClone(this.value);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.writes.push(structuredClone(items));
    this.value = { ...this.value, ...structuredClone(items) };
  }
}

describe("EngagementConsentStore", () => {
  it("fails closed for missing, malformed, or outdated consent", async () => {
    const storage = new MemoryStorage();
    const store = new EngagementConsentStore(storage);
    await expect(store.load()).resolves.toEqual({
      active: false,
      agreedAt: null,
      version: ENGAGEMENT_CONSENT_VERSION,
    });
    storage.value[ENGAGEMENT_CONSENT_STORAGE_KEY] = {
      active: true,
      agreedAt: "2026-07-27T00:00:00.000Z",
      comment: "저장하면 안 되는 댓글",
      version: ENGAGEMENT_CONSENT_VERSION,
    };
    await expect(store.load()).resolves.toMatchObject({ active: false });
    storage.value[ENGAGEMENT_CONSENT_STORAGE_KEY] = {
      active: true,
      agreedAt: "2026-07-27T00:00:00.000Z",
      version: "old-version",
    };
    await expect(store.load()).resolves.toMatchObject({ active: false });
    storage.value[ENGAGEMENT_CONSENT_STORAGE_KEY] = {
      active: false,
      agreedAt: "2026-07-27T00:00:00.000Z",
      version: ENGAGEMENT_CONSENT_VERSION,
    };
    await expect(store.load()).resolves.toMatchObject({ active: false, agreedAt: null });
  });

  it("stores only version, agreement time, and active state", async () => {
    const storage = new MemoryStorage();
    const store = new EngagementConsentStore(storage, () => new Date("2026-07-27T01:02:03.000Z"));

    await expect(store.agree()).resolves.toEqual({
      active: true,
      agreedAt: "2026-07-27T01:02:03.000Z",
      version: ENGAGEMENT_CONSENT_VERSION,
    });
    expect(storage.value).toEqual({
      [ENGAGEMENT_CONSENT_STORAGE_KEY]: {
        active: true,
        agreedAt: "2026-07-27T01:02:03.000Z",
        version: ENGAGEMENT_CONSENT_VERSION,
      },
    });
  });

  it("withdraws without retaining the prior agreement time", async () => {
    const storage = new MemoryStorage();
    const store = new EngagementConsentStore(storage);
    await store.agree();

    await expect(store.withdraw()).resolves.toEqual({
      active: false,
      agreedAt: null,
      version: ENGAGEMENT_CONSENT_VERSION,
    });
  });
});
