const STORAGE_KEY = "generationRegistryV1";
const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 20;
const RETENTION_MS = 60 * 60 * 1_000;
const DIGEST = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type RegistryState =
  | "active"
  | "completed"
  | "dismissed"
  | "indeterminate"
  | "released"
  | "reviewing"
  | "terminal_failure";

export interface RegistryEntry {
  createdAt: number;
  digest: string;
  expiresAt?: number;
  idempotencyKey: string;
  recommendationId?: string;
  state: RegistryState;
  updatedAt: number;
}

interface StoredRegistry {
  entries: RegistryEntry[];
  schemaVersion: 1;
}

export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class RegistryQuarantinedError extends Error {
  constructor() {
    super("저장된 retry registry가 손상되어 명시적인 정리가 필요합니다.");
  }
}

export class RegistryFullError extends Error {
  constructor() {
    super("보호 중인 retry 작업이 20개여서 새 추천을 시작할 수 없습니다.");
  }
}

export async function restrictStorageToTrustedContexts(
  local: Pick<chrome.storage.LocalStorageArea, "setAccessLevel"> = chrome.storage.local,
): Promise<void> {
  await local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

export class IdempotencyRegistry {
  readonly #now: () => number;
  readonly #storage: StorageArea;
  #pending: Promise<void> = Promise.resolve();

  constructor(storage: StorageArea = chrome.storage.local, now: () => number = Date.now) {
    this.#storage = storage;
    this.#now = now;
  }

  async find(digest: string): Promise<RegistryEntry | null> {
    return this.#exclusive(async () => {
      const registry = await this.#load();
      return registry.entries.find((entry) => entry.digest === digest) ?? null;
    });
  }

  async getOrCreate(digest: string): Promise<RegistryEntry> {
    assertDigest(digest);
    return this.#exclusive(async () => {
      const registry = await this.#load();
      const existing = registry.entries.find((entry) => entry.digest === digest);
      if (existing !== undefined) {
        return existing;
      }
      this.#makeRoom(registry);
      const entry = newEntry(digest, this.#now());
      registry.entries.push(entry);
      await this.#save(registry);
      return entry;
    });
  }

  async replace(digest: string): Promise<RegistryEntry> {
    assertDigest(digest);
    return this.#exclusive(async () => {
      const registry = await this.#load();
      const existing = registry.entries.find((entry) => entry.digest === digest);
      if (existing === undefined) {
        this.#makeRoom(registry);
        const entry = newEntry(digest, this.#now());
        registry.entries.push(entry);
        await this.#save(registry);
        return entry;
      }
      const replacement = newEntry(digest, this.#now());
      registry.entries.splice(registry.entries.indexOf(existing), 1, replacement);
      await this.#save(registry);
      return replacement;
    });
  }

  async transition(
    digest: string,
    state: RegistryState,
    recommendationId?: string,
  ): Promise<RegistryEntry> {
    return this.#exclusive(async () => {
      const registry = await this.#load();
      const index = registry.entries.findIndex((entry) => entry.digest === digest);
      const current = registry.entries[index];
      if (index < 0 || current === undefined || !legalTransition(current.state, state)) {
        throw new RegistryQuarantinedError();
      }
      const resolvedRecommendationId = recommendationId ?? current.recommendationId;
      if (
        (resolvedRecommendationId !== undefined && !UUID.test(resolvedRecommendationId)) ||
        ((state === "reviewing" || state === "completed") && resolvedRecommendationId === undefined)
      ) {
        throw new RegistryQuarantinedError();
      }
      const updatedAt = this.#now();
      const expiresAt = updatedAt + RETENTION_MS;
      if (isExpirable(state) && !Number.isSafeInteger(expiresAt)) {
        throw new RegistryQuarantinedError();
      }
      const updated: RegistryEntry = {
        createdAt: current.createdAt,
        digest: current.digest,
        idempotencyKey: current.idempotencyKey,
        state,
        updatedAt,
        ...(resolvedRecommendationId === undefined
          ? {}
          : { recommendationId: resolvedRecommendationId }),
        ...(isExpirable(state) ? { expiresAt } : {}),
      };
      registry.entries.splice(index, 1, updated);
      await this.#save(registry);
      return updated;
    });
  }

  async cleanupInvalid(): Promise<void> {
    await this.#exclusive(async () => {
      const raw = await this.#storage.get(STORAGE_KEY);
      const parsed = parseRegistry(raw[STORAGE_KEY]);
      await this.#save(parsed ?? { entries: [], schemaVersion: SCHEMA_VERSION });
    });
  }

  async cleanupAll(): Promise<void> {
    await this.#exclusive(() => this.#save({ entries: [], schemaVersion: SCHEMA_VERSION }));
  }

  async #load(): Promise<StoredRegistry> {
    const raw = await this.#storage.get(STORAGE_KEY);
    if (raw[STORAGE_KEY] === undefined) {
      return { entries: [], schemaVersion: SCHEMA_VERSION };
    }
    const parsed = parseRegistry(raw[STORAGE_KEY]);
    if (parsed === null) {
      throw new RegistryQuarantinedError();
    }
    const now = this.#now();
    const retained = parsed.entries.filter(
      (entry) =>
        !isExpirable(entry.state) || entry.expiresAt === undefined || entry.expiresAt > now,
    );
    if (retained.length !== parsed.entries.length) {
      parsed.entries = retained;
      await this.#save(parsed);
    }
    return parsed;
  }

  #makeRoom(registry: StoredRegistry): void {
    if (registry.entries.length < MAX_ENTRIES) {
      return;
    }
    throw new RegistryFullError();
  }

  async #save(registry: StoredRegistry): Promise<void> {
    await this.#storage.set({ [STORAGE_KEY]: registry });
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation, operation);
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isExpirable(state: RegistryState): boolean {
  return state === "completed" || state === "dismissed" || state === "released";
}

function assertDigest(digest: string): void {
  if (!DIGEST.test(digest)) {
    throw new RegistryQuarantinedError();
  }
}

function parseRegistry(value: unknown): StoredRegistry | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES ||
    !onlyKeys(value, ["entries", "schemaVersion"])
  ) {
    return null;
  }
  const entries = value.entries.map(parseEntry);
  if (entries.some((entry) => entry === null)) {
    return null;
  }
  const safeEntries = entries as RegistryEntry[];
  if (new Set(safeEntries.map((entry) => entry.digest)).size !== safeEntries.length) {
    return null;
  }
  return { entries: safeEntries, schemaVersion: SCHEMA_VERSION };
}

function parseEntry(value: unknown): RegistryEntry | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "createdAt",
      "digest",
      "expiresAt",
      "idempotencyKey",
      "recommendationId",
      "state",
      "updatedAt",
    ])
  ) {
    return null;
  }
  const { createdAt, digest, expiresAt, idempotencyKey, recommendationId, state, updatedAt } =
    value;
  const expectedExpiresAt = typeof updatedAt === "number" ? updatedAt + RETENTION_MS : Number.NaN;
  if (
    typeof digest !== "string" ||
    !DIGEST.test(digest) ||
    typeof idempotencyKey !== "string" ||
    !UUID.test(idempotencyKey) ||
    typeof state !== "string" ||
    !isRegistryState(state) ||
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    updatedAt < createdAt ||
    (recommendationId !== undefined &&
      (typeof recommendationId !== "string" || !UUID.test(recommendationId))) ||
    ((state === "reviewing" || state === "completed") && recommendationId === undefined) ||
    (isExpirable(state)
      ? typeof expiresAt !== "number" ||
        !Number.isSafeInteger(expectedExpiresAt) ||
        expiresAt !== expectedExpiresAt
      : expiresAt !== undefined)
  ) {
    return null;
  }
  return {
    createdAt,
    digest,
    idempotencyKey,
    state,
    updatedAt,
    ...(typeof expiresAt === "number" ? { expiresAt } : {}),
    ...(recommendationId === undefined ? {} : { recommendationId }),
  };
}

function isRegistryState(value: string): value is RegistryState {
  return [
    "active",
    "completed",
    "dismissed",
    "indeterminate",
    "released",
    "reviewing",
    "terminal_failure",
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function newEntry(digest: string, now: number): RegistryEntry {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RegistryQuarantinedError();
  }
  return {
    createdAt: now,
    digest,
    idempotencyKey: crypto.randomUUID(),
    state: "active",
    updatedAt: now,
  };
}

function legalTransition(from: RegistryState, to: RegistryState): boolean {
  const allowed: Record<RegistryState, readonly RegistryState[]> = {
    active: ["active", "indeterminate", "released", "reviewing", "terminal_failure"],
    completed: ["completed", "dismissed"],
    dismissed: ["dismissed"],
    indeterminate: ["dismissed", "indeterminate"],
    released: ["active", "indeterminate", "released", "reviewing", "terminal_failure"],
    reviewing: ["completed", "dismissed", "reviewing"],
    terminal_failure: ["dismissed", "terminal_failure"],
  };
  return allowed[from].includes(to);
}
