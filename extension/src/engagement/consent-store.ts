export const ENGAGEMENT_CONSENT_STORAGE_KEY = "engagementConsentV1";
export const ENGAGEMENT_CONSENT_VERSION = "2026-07-27-v1";

export interface EngagementConsent {
  active: boolean;
  agreedAt: string | null;
  version: string;
}

export interface ConsentStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class EngagementConsentStore {
  readonly #now: () => Date;
  readonly #storage: ConsentStorageArea;

  constructor(
    storage: ConsentStorageArea = chrome.storage.local,
    now: () => Date = () => new Date(),
  ) {
    this.#storage = storage;
    this.#now = now;
  }

  async load(): Promise<EngagementConsent> {
    let stored: unknown;
    try {
      stored = (await this.#storage.get(ENGAGEMENT_CONSENT_STORAGE_KEY))[
        ENGAGEMENT_CONSENT_STORAGE_KEY
      ];
    } catch {
      return inactiveConsent();
    }
    if (!isStoredConsent(stored) || stored.version !== ENGAGEMENT_CONSENT_VERSION) {
      return inactiveConsent();
    }
    return stored;
  }

  async agree(): Promise<EngagementConsent> {
    const consent: EngagementConsent = {
      active: true,
      agreedAt: this.#now().toISOString(),
      version: ENGAGEMENT_CONSENT_VERSION,
    };
    await this.#storage.set({ [ENGAGEMENT_CONSENT_STORAGE_KEY]: consent });
    return consent;
  }

  async withdraw(): Promise<EngagementConsent> {
    const consent = inactiveConsent();
    await this.#storage.set({ [ENGAGEMENT_CONSENT_STORAGE_KEY]: consent });
    return consent;
  }
}

function inactiveConsent(): EngagementConsent {
  return {
    active: false,
    agreedAt: null,
    version: ENGAGEMENT_CONSENT_VERSION,
  };
}

function isStoredConsent(value: unknown): value is EngagementConsent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== "active,agreedAt,version") return false;
  const structurallyValid =
    "active" in value &&
    typeof value.active === "boolean" &&
    "agreedAt" in value &&
    (value.agreedAt === null ||
      (typeof value.agreedAt === "string" && !Number.isNaN(Date.parse(value.agreedAt)))) &&
    "version" in value &&
    typeof value.version === "string";
  if (!structurallyValid) return false;
  return value.active ? value.agreedAt !== null : value.agreedAt === null;
}
