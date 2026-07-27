const SUPPORTED_HOSTS = new Set(["blog.naver.com", "m.blog.naver.com"]);
const INVALID_PERCENT_ENCODING = /%(?![0-9a-f]{2})/iu;
const ENCODED_CONTROL_OR_SPACE = /%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/iu;

export function parseSupportedNaverUrl(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    Array.from(value).some(
      (character) => /\s/u.test(character) || character.charCodeAt(0) < 0x20,
    ) ||
    value.includes("\u007f") ||
    INVALID_PERCENT_ENCODING.test(value) ||
    ENCODED_CONTROL_OR_SPACE.test(value)
  ) {
    return null;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !SUPPORTED_HOSTS.has(url.hostname) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      (url.port.length > 0 && url.port !== "443") ||
      !url.pathname.startsWith("/")
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function sameSupportedNaverPost(left: string, right: string): boolean {
  const leftUrl = parseSupportedNaverUrl(left);
  const rightUrl = parseSupportedNaverUrl(right);
  if (leftUrl === null || rightUrl === null) return false;
  const leftIdentity = postIdentity(leftUrl);
  const rightIdentity = postIdentity(rightUrl);
  return leftIdentity !== null && rightIdentity !== null
    ? leftIdentity === rightIdentity
    : leftUrl === rightUrl;
}

function postIdentity(value: string): string | null {
  const url = new URL(value);
  const queryBlogId = url.searchParams.get("blogId")?.trim() ?? "";
  const queryLogNo = url.searchParams.get("logNo")?.trim() ?? "";
  if (queryBlogId !== "" && /^\d+$/u.test(queryLogNo)) {
    return `${queryBlogId.toLocaleLowerCase()}:${queryLogNo}`;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const [blogId, logNo] = parts;
  return blogId !== undefined && logNo !== undefined && /^\d+$/u.test(logNo)
    ? `${blogId.toLocaleLowerCase()}:${logNo}`
    : null;
}
