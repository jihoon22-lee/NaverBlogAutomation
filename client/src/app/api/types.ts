/** Transport types mirrored from the checked-in OpenAPI contract. */

export type DiscoverySource = "neighbor" | "search";

export type DiscoveryState = "queued" | "opened" | "completed" | "skipped" | "unavailable";

export type BrowserSessionState = "stopped" | "launching" | "ready" | "closing";

export type BrowserLoginState = "unknown" | "anonymous" | "authenticated";

export type ArticleSelectorKind = "modern" | "legacy" | "semantic";

export interface ServiceStatus {
  status: "ready";
  apiVersion: string;
  appEnvironment: "production" | "development" | "test";
  database: "ready";
  generatorMode: "openai" | "fake";
  generatorModel: string;
}

export interface DiscoveryPost {
  id: string;
  source: DiscoverySource;
  state: DiscoveryState;
  sourceUrl: string;
  title: string;
  publisherName: string | null;
  publisherBlogId: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserSession {
  state: BrowserSessionState;
  login: BrowserLoginState;
  driver: string;
  headless: boolean;
  profileDir: string;
  openPages: number;
  detail: string | null;
}

export interface ArticleExtraction {
  sourceUrl: string;
  title: string;
  selectorKind: ArticleSelectorKind;
  originalLength: number;
  transmittedLength: number;
  truncated: boolean;
  preview: string;
}

export interface ProblemDetails {
  code: string;
  detail: string;
  status: number;
  title: string;
}
