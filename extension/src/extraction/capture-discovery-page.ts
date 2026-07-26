export interface DiscoveryPageCapture {
  readonly blogs: readonly { blogId: string; blogUrl: string; name: string }[];
  readonly posts: readonly {
    publisherName: string | null;
    sourceUrl: string;
    title: string;
    publishedAt?: string;
  }[];
}

export function captureDiscoveryPage(): DiscoveryPageCapture {
  const blogs = new Map<string, { blogId: string; blogUrl: string; name: string }>();
  const posts = new Map<
    string,
    { publisherName: string | null; sourceUrl: string; title: string; publishedAt?: string }
  >();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const url = supportedBlogUrl(anchor.href);
    if (url === null) continue;
    const text = normalizedText(anchor.textContent);
    const parts = url.pathname.split("/").filter(Boolean);
    const blogId = new URL(url).searchParams.get("blogId") ?? parts[0] ?? "";
    if (!blogId) continue;
    if (isPostUrl(url)) {
      if (text.length > 1 && !posts.has(url.href)) {
        const publishedAt = nearbyPublishedAt(anchor);
        posts.set(url.href, {
          publisherName: null,
          sourceUrl: url.href,
          title: text,
          ...(publishedAt === undefined ? {} : { publishedAt }),
        });
      }
    } else if (parts.length === 1 && text.length > 0 && !blogs.has(blogId)) {
      blogs.set(blogId, {
        blogId,
        blogUrl: `https://blog.naver.com/${blogId}`,
        name: text.slice(0, 120),
      });
    }
  }
  return { blogs: [...blogs.values()].slice(0, 50), posts: [...posts.values()].slice(0, 50) };
}

function supportedBlogUrl(value: string): URL | null {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "https:" &&
      (url.hostname === "blog.naver.com" || url.hostname === "m.blog.naver.com")
      ? url
      : null;
  } catch {
    return null;
  }
}

function isPostUrl(url: URL): boolean {
  return (
    url.pathname.includes("PostView") ||
    url.pathname.split("/").filter(Boolean).length >= 2 ||
    url.searchParams.has("logNo")
  );
}

function normalizedText(value: string | null): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function nearbyPublishedAt(anchor: HTMLAnchorElement): string | undefined {
  const context = anchor.closest("li, article") ?? anchor.parentElement;
  const match = normalizedText(context?.textContent ?? null).match(
    /\b(20\d{2})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\.?\b/u,
  );
  if (match === null) return undefined;
  const [yearText, monthText, dayText] = match.slice(1);
  if (yearText === undefined || monthText === undefined || dayText === undefined) return undefined;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  )
    return undefined;
  return value.toISOString();
}
