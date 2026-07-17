export const MAX_BODY_CODE_POINTS = 100_000;
export const MAX_TITLE_CODE_POINTS = 300;
export const PREVIEW_CODE_POINTS = 1_200;

export function normalizeExtractedText(value: string): string {
  return value
    .replace(/\u00a0/gu, " ")
    .split(/\r?\n/gu)
    .map((line) => line.replace(/[\t\f\v ]+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function normalizeRequestText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export function boundCodePoints(
  value: string,
  maximum: number,
): { originalLength: number; text: string; truncated: boolean } {
  const points = Array.from(value);
  return {
    originalLength: points.length,
    text: points.slice(0, maximum).join(""),
    truncated: points.length > maximum,
  };
}
