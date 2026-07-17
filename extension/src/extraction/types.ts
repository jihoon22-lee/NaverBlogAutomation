export type CaptureSelectorKind = "modern" | "legacy" | "semantic";

export interface RawFrameCapture {
  body: string;
  canonicalUrl: string | null;
  frameUrl: string;
  originalLength: number;
  selectorConfidence: number;
  selectorKind: CaptureSelectorKind;
  title: string;
}

export interface FrameExecution {
  documentId?: string;
  frameId: number;
  result: RawFrameCapture | null;
}

export interface ActiveTab {
  id: number;
  title: string;
  url: string;
}

export interface CapturedPostPreview {
  body: string;
  documentId?: string;
  frameId: number;
  originalLength: number;
  sourceUrl: string;
  tabId: number;
  title: string;
  transmittedLength: number;
  truncated: boolean;
}

export type CaptureFailureCode =
  | "no_active_tab"
  | "unsupported_url"
  | "permission_denied"
  | "extraction_failed"
  | "empty_article"
  | "short_article"
  | "stale_page";

export interface CaptureFailure {
  code: CaptureFailureCode;
}

export type CaptureResult =
  | { ok: true; preview: CapturedPostPreview }
  | { failure: CaptureFailure; ok: false };
