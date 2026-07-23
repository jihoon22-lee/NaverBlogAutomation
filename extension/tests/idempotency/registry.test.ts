import { describe, expect, it, vi } from "vitest";

import {
  IdempotencyRegistry,
  RegistryFullError,
  RegistryQuarantinedError,
  restrictStorageToTrustedContexts,
  type RegistryMutationLock,
  type StorageArea,
} from "../../src/idempotency/registry";

const KEY = "generationRegistryV1";
const HOUR = 60 * 60 * 1_000;

class MemoryStorage implements StorageArea {
  beforeSet: (() => Promise<void>) | null = null;
  value: Record<string, unknown> = {};
  readonly writes: Record<string, unknown>[] = [];

  async get(_key: string): Promise<Record<string, unknown>> {
    await Promise.resolve();
    return structuredClone(this.value);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    await this.beforeSet?.();
    this.beforeSet = null;
    await Promise.resolve();
    this.value = { ...this.value, ...structuredClone(items) };
    this.writes.push(structuredClone(items));
  }
}

class MemoryLock implements RegistryMutationLock {
  #pending: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation, operation);
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function registry(storage: MemoryStorage, now: () => number = Date.now, lock = new MemoryLock()) {
  return new IdempotencyRegistry(storage, now, lock);
}

const digest = (index: number) => index.toString(16).padStart(64, "0");

describe("IdempotencyRegistry", () => {
  it("restricts storage access to trusted extension contexts", async () => {
    const setAccessLevel = vi.fn(async () => undefined);
    await restrictStorageToTrustedContexts({ setAccessLevel } as never);
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });

  it("persists and reuses metadata without source or comment text", async () => {
    const storage = new MemoryStorage();
    const subject = registry(storage, () => 1_000);
    const first = await subject.getOrCreate(digest(1));
    const second = await subject.getOrCreate(digest(1));

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    const serialized = JSON.stringify(storage.value);
    expect(serialized).not.toMatch(/body|title|source_url|comment|blog\.naver/u);
    expect(storage.writes).toHaveLength(1);
  });

  it("serializes concurrent updates without losing entries", async () => {
    const storage = new MemoryStorage();
    const subject = registry(storage, () => 2_000);
    await Promise.all([subject.getOrCreate(digest(2)), subject.getOrCreate(digest(3))]);
    const stored = storage.value[KEY] as { entries: unknown[] };
    expect(stored.entries).toHaveLength(2);
  });

  it("pins unexpired records, expires TTL records, and requires explicit cleanup at capacity", async () => {
    let now = 10_000;
    const storage = new MemoryStorage();
    const subject = registry(storage, () => now);
    for (let index = 1; index <= 20; index += 1) {
      await subject.getOrCreate(digest(index));
      await subject.transition(digest(index), "released");
    }
    await expect(subject.getOrCreate(digest(21))).rejects.toBeInstanceOf(RegistryFullError);

    now += HOUR + 1;
    await expect(subject.getOrCreate(digest(21))).resolves.toMatchObject({ digest: digest(21) });
    await subject.cleanupAll();
    expect((storage.value[KEY] as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it("quarantines malformed data and only clears it explicitly", async () => {
    const storage = new MemoryStorage();
    storage.value = { [KEY]: { entries: [{ body: "private" }], schemaVersion: 1 } };
    const subject = registry(storage);
    await expect(subject.getOrCreate(digest(4))).rejects.toBeInstanceOf(RegistryQuarantinedError);
    expect(JSON.stringify(storage.value)).toContain("private");
    await subject.cleanupInvalid();
    expect(storage.value[KEY]).toEqual({
      entries: [],
      policyVersion: "generation-policy-v3",
      schemaVersion: 2,
    });
  });

  it("migrates only an empty legacy V1 registry to the V3 policy", async () => {
    const storage = new MemoryStorage();
    storage.value[KEY] = { entries: [], schemaVersion: 1 };

    await expect(registry(storage).find(digest(41))).resolves.toBeNull();
    expect(storage.value[KEY]).toEqual({
      entries: [],
      policyVersion: "generation-policy-v3",
      schemaVersion: 2,
    });
  });

  it("quarantines legacy attempts until explicit cleanup before creating a V3 key", async () => {
    const storage = new MemoryStorage();
    const legacyKey = "00000000-0000-4000-8000-000000000041";
    storage.value[KEY] = {
      entries: [
        {
          createdAt: 1_000,
          digest: digest(41),
          idempotencyKey: legacyKey,
          state: "indeterminate",
          updatedAt: 1_000,
        },
      ],
      schemaVersion: 1,
    };
    const subject = registry(storage, () => 2_000);

    await expect(subject.getOrCreate(digest(42))).rejects.toBeInstanceOf(RegistryQuarantinedError);
    expect(storage.writes).toEqual([]);
    expect(JSON.stringify(storage.value)).toContain(legacyKey);

    await subject.cleanupAll();
    await expect(subject.getOrCreate(digest(42))).resolves.toMatchObject({
      digest: digest(42),
      state: "active",
    });
    expect(JSON.stringify(storage.value)).not.toContain(legacyKey);
    expect(storage.value[KEY]).toMatchObject({
      policyVersion: "generation-policy-v3",
      schemaVersion: 2,
    });
  });

  it("quarantines a registry with an unknown policy version", async () => {
    const storage = new MemoryStorage();
    storage.value[KEY] = {
      entries: [],
      policyVersion: "generation-policy-unknown",
      schemaVersion: 2,
    };

    await expect(registry(storage).getOrCreate(digest(43))).rejects.toBeInstanceOf(
      RegistryQuarantinedError,
    );
    expect(storage.writes).toEqual([]);
  });

  it("quarantines TTL metadata that exceeds the exact 60-minute retention", async () => {
    const storage = new MemoryStorage();
    const subject = registry(storage, () => 5_000);
    await subject.getOrCreate(digest(40));
    await subject.transition(digest(40), "released");
    const stored = storage.value[KEY] as { entries: Array<{ expiresAt: number }> };
    const entry = stored.entries[0];
    if (entry === undefined) {
      throw new Error("Synthetic registry entry missing");
    }
    entry.expiresAt += 1;

    await expect(registry(storage).find(digest(40))).rejects.toBeInstanceOf(
      RegistryQuarantinedError,
    );
  });

  it("requires opaque recommendation IDs and legal transitions", async () => {
    const subject = registry(new MemoryStorage(), () => 3_000);
    await subject.getOrCreate(digest(5));
    await expect(subject.transition(digest(5), "reviewing")).rejects.toBeInstanceOf(
      RegistryQuarantinedError,
    );
    const reviewing = await subject.transition(
      digest(5),
      "reviewing",
      "00000000-0000-4000-8000-000000000005",
    );
    expect(reviewing.recommendationId).toBe("00000000-0000-4000-8000-000000000005");
    await expect(subject.transition(digest(5), "active")).rejects.toBeInstanceOf(
      RegistryQuarantinedError,
    );
  });

  it("regenerates only a known reviewing or completed recommendation", async () => {
    const recommendationId = "00000000-0000-4000-8000-000000000006";
    const subject = registry(new MemoryStorage(), () => 4_000);
    const first = await subject.getOrCreate(digest(6));

    await expect(subject.regenerateKnown(digest(6), recommendationId)).rejects.toBeInstanceOf(
      RegistryQuarantinedError,
    );
    await subject.transition(digest(6), "reviewing", recommendationId);
    const regenerated = await subject.regenerateKnown(digest(6), recommendationId);

    expect(regenerated.state).toBe("active");
    expect(regenerated.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(regenerated.recommendationId).toBeUndefined();
    await expect(
      subject.regenerateKnown(digest(6), "00000000-0000-4000-8000-000000000007"),
    ).rejects.toBeInstanceOf(RegistryQuarantinedError);

    const completedId = "00000000-0000-4000-8000-000000000008";
    await subject.getOrCreate(digest(8));
    await subject.transition(digest(8), "reviewing", completedId);
    await subject.transition(digest(8), "completed", completedId);
    await expect(subject.regenerateKnown(digest(8), completedId)).resolves.toMatchObject({
      state: "active",
    });
  });

  it("removes retry metadata for an explicitly deleted recommendation", async () => {
    const storage = new MemoryStorage();
    const subject = registry(storage, () => 4_500);
    const removedId = "00000000-0000-4000-8000-000000000061";
    const retainedId = "00000000-0000-4000-8000-000000000062";
    await subject.getOrCreate(digest(61));
    await subject.transition(digest(61), "reviewing", removedId);
    await subject.getOrCreate(digest(62));
    await subject.transition(digest(62), "reviewing", retainedId);

    await subject.removeRecommendation(removedId);

    await expect(subject.find(digest(61))).resolves.toBeNull();
    await expect(subject.find(digest(62))).resolves.toMatchObject({
      recommendationId: retainedId,
    });
    await expect(subject.removeRecommendation("invalid")).rejects.toBeInstanceOf(
      RegistryQuarantinedError,
    );
  });

  it("serializes mutations across registry instances with a shared browser lock", async () => {
    const storage = new MemoryStorage();
    const lock = new MemoryLock();
    let release: (() => void) | undefined;
    storage.beforeSet = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const first = registry(storage, () => 5_000, lock);
    const second = registry(storage, () => 5_001, lock);

    const firstWrite = first.getOrCreate(digest(7));
    await vi.waitFor(() => expect(release).toBeDefined());
    const secondWrite = second.getOrCreate(digest(8));
    release?.();
    await Promise.all([firstWrite, secondWrite]);

    const stored = storage.value[KEY] as { entries: Array<{ digest: string }> };
    expect(stored.entries.map((entry) => entry.digest)).toEqual([digest(7), digest(8)]);
  });

  it("returns one key for concurrent same-digest creation across registry instances", async () => {
    const storage = new MemoryStorage();
    const lock = new MemoryLock();
    let release: (() => void) | undefined;
    storage.beforeSet = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const first = registry(storage, () => 5_000, lock);
    const second = registry(storage, () => 5_001, lock);

    const firstWrite = first.getOrCreate(digest(12));
    await vi.waitFor(() => expect(release).toBeDefined());
    const secondWrite = second.getOrCreate(digest(12));
    release?.();
    const [firstEntry, secondEntry] = await Promise.all([firstWrite, secondWrite]);

    expect(secondEntry.idempotencyKey).toBe(firstEntry.idempotencyKey);
    const stored = storage.value[KEY] as { entries: Array<{ digest: string }> };
    expect(stored.entries).toHaveLength(1);
  });

  it("fails closed without Web Locks before writing storage", async () => {
    const storage = new MemoryStorage();
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    try {
      const subject = new IdempotencyRegistry(storage, () => 7_000);
      await expect(subject.getOrCreate(digest(13))).rejects.toBeInstanceOf(
        RegistryQuarantinedError,
      );
      expect(storage.writes).toEqual([]);
    } finally {
      if (descriptor === undefined) delete (navigator as { locks?: unknown }).locks;
      else Object.defineProperty(navigator, "locks", descriptor);
    }
  });

  it.each(["indeterminate", "terminal_failure"] as const)(
    "replaces only the exact confirmed %s state",
    async (state) => {
      const subject = registry(new MemoryStorage(), () => 6_000);
      await subject.getOrCreate(digest(9));
      await subject.transition(digest(9), state);

      await expect(subject.replace(digest(9), state)).resolves.toMatchObject({ state: "active" });
      await expect(subject.replace(digest(10), state)).rejects.toBeInstanceOf(
        RegistryQuarantinedError,
      );
    },
  );
});
