import { describe, expect, it, vi } from "vitest";

import {
  IdempotencyRegistry,
  RegistryFullError,
  RegistryQuarantinedError,
  restrictStorageToTrustedContexts,
  type StorageArea,
} from "../../src/idempotency/registry";

const KEY = "generationRegistryV1";
const HOUR = 60 * 60 * 1_000;

class MemoryStorage implements StorageArea {
  value: Record<string, unknown> = {};
  readonly writes: Record<string, unknown>[] = [];

  async get(_key: string): Promise<Record<string, unknown>> {
    await Promise.resolve();
    return structuredClone(this.value);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    await Promise.resolve();
    this.value = structuredClone(items);
    this.writes.push(structuredClone(items));
  }
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
    const registry = new IdempotencyRegistry(storage, () => 1_000);
    const first = await registry.getOrCreate(digest(1));
    const second = await registry.getOrCreate(digest(1));

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    const serialized = JSON.stringify(storage.value);
    expect(serialized).not.toMatch(/body|title|source_url|comment|blog\.naver/u);
    expect(storage.writes).toHaveLength(1);
  });

  it("serializes concurrent updates without losing entries", async () => {
    const storage = new MemoryStorage();
    const registry = new IdempotencyRegistry(storage, () => 2_000);
    await Promise.all([registry.getOrCreate(digest(2)), registry.getOrCreate(digest(3))]);
    const stored = storage.value[KEY] as { entries: unknown[] };
    expect(stored.entries).toHaveLength(2);
  });

  it("pins unexpired records, expires TTL records, and requires explicit cleanup at capacity", async () => {
    let now = 10_000;
    const storage = new MemoryStorage();
    const registry = new IdempotencyRegistry(storage, () => now);
    for (let index = 1; index <= 20; index += 1) {
      await registry.getOrCreate(digest(index));
      await registry.transition(digest(index), "released");
    }
    await expect(registry.getOrCreate(digest(21))).rejects.toBeInstanceOf(RegistryFullError);

    now += HOUR + 1;
    await expect(registry.getOrCreate(digest(21))).resolves.toMatchObject({ digest: digest(21) });
    await registry.cleanupAll();
    expect((storage.value[KEY] as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it("quarantines malformed data and only clears it explicitly", async () => {
    const storage = new MemoryStorage();
    storage.value = { [KEY]: { entries: [{ body: "private" }], schemaVersion: 1 } };
    const registry = new IdempotencyRegistry(storage);
    await expect(registry.getOrCreate(digest(4))).rejects.toBeInstanceOf(RegistryQuarantinedError);
    expect(JSON.stringify(storage.value)).toContain("private");
    await registry.cleanupInvalid();
    expect((storage.value[KEY] as { entries: unknown[] }).entries).toEqual([]);
  });

  it("quarantines TTL metadata that exceeds the exact 60-minute retention", async () => {
    const storage = new MemoryStorage();
    const registry = new IdempotencyRegistry(storage, () => 5_000);
    await registry.getOrCreate(digest(40));
    await registry.transition(digest(40), "released");
    const stored = storage.value[KEY] as { entries: Array<{ expiresAt: number }> };
    const entry = stored.entries[0];
    if (entry === undefined) {
      throw new Error("Synthetic registry entry missing");
    }
    entry.expiresAt += 1;

    await expect(new IdempotencyRegistry(storage).find(digest(40))).rejects.toBeInstanceOf(
      RegistryQuarantinedError,
    );
  });

  it("requires opaque recommendation IDs and legal transitions", async () => {
    const registry = new IdempotencyRegistry(new MemoryStorage(), () => 3_000);
    await registry.getOrCreate(digest(5));
    await expect(registry.transition(digest(5), "reviewing")).rejects.toBeInstanceOf(
      RegistryQuarantinedError,
    );
    const reviewing = await registry.transition(
      digest(5),
      "reviewing",
      "00000000-0000-4000-8000-000000000005",
    );
    expect(reviewing.recommendationId).toBe("00000000-0000-4000-8000-000000000005");
    await expect(registry.transition(digest(5), "active")).rejects.toBeInstanceOf(
      RegistryQuarantinedError,
    );
  });
});
