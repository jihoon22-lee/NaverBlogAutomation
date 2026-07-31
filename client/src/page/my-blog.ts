/**
 * Read-only probes for the author's own blog.
 *
 * These read the public category tree and post list from the rendered page instead of calling an
 * internal endpoint, so the automation layer needs no undocumented API and no extra permission. Both
 * probes report what they saw and never navigate or click.
 */

import { isVisible, queryAllUnique } from "./dom";

export interface BlogCategoryProbe {
  categoryNo: number;
  name: string;
  postCount: number | null;
}

export interface BlogCategoryListProbe {
  categories: BlogCategoryProbe[];
  matchedKinds: string[];
}

export interface BlogPostProbe {
  logNo: string;
  title: string;
  publishedAt: string | null;
  url: string;
}

export interface BlogPostListProbe {
  categoryNo: number | null;
  posts: BlogPostProbe[];
}

const CATEGORY_SELECTORS: readonly [string, string][] = [
  ["category_link", "a[href*='categoryNo=']"],
  ["category_menu", "#category-list a, .category-list a, ._categoryLink"],
];

const POST_SELECTORS: readonly [string, string][] = [
  ["post_link", "a[href*='logNo=']"],
  ["post_path", "a[href*='/blog.naver.com/'][href*='/2']"],
];

const COUNT_PATTERN = /\((\d[\d,]*)\)\s*$/u;
const DATE_PATTERN = /(20\d{2})[.\-/\s]+(\d{1,2})[.\-/\s]+(\d{1,2})/u;

/** Report every category link the page exposes, keeping the first name per category number. */
export function probeMyBlogCategories(): BlogCategoryListProbe {
  const matchedKinds: string[] = [];
  const byNumber = new Map<number, BlogCategoryProbe>();
  for (const [kind, selector] of CATEGORY_SELECTORS) {
    const links = queryAllUnique([selector], document).filter(isVisible);
    if (links.length > 0) matchedKinds.push(kind);
    for (const link of links) {
      const categoryNo = readCategoryNo(link);
      if (categoryNo === null || byNumber.has(categoryNo)) continue;
      const label = readLabel(link);
      if (label.name.length === 0) continue;
      byNumber.set(categoryNo, {
        categoryNo,
        name: label.name,
        postCount: label.postCount,
      });
    }
  }
  return {
    categories: [...byNumber.values()].sort((left, right) => left.categoryNo - right.categoryNo),
    matchedKinds,
  };
}

/** Report the posts listed on the current page, deduplicated by log number. */
export function probeCategoryPostList(): BlogPostListProbe {
  const byLogNo = new Map<string, BlogPostProbe>();
  for (const [, selector] of POST_SELECTORS) {
    for (const link of queryAllUnique([selector], document).filter(isVisible)) {
      const href = link.getAttribute("href");
      if (href === null) continue;
      const logNo = readLogNo(href);
      if (logNo === null || byLogNo.has(logNo)) continue;
      const title = (link.textContent ?? "").replace(/\s+/gu, " ").trim();
      if (title.length === 0) continue;
      byLogNo.set(logNo, {
        logNo,
        title,
        publishedAt: readPublishedAt(link),
        url: absolute(href),
      });
    }
  }
  return {
    categoryNo: readCategoryNo(document.documentElement, document.location?.search ?? ""),
    posts: [...byLogNo.values()],
  };
}

function readCategoryNo(element: Element, fallback = ""): number | null {
  const href = element.getAttribute?.("href") ?? "";
  const match = /[?&]categoryNo=(\d+)/u.exec(href) ?? /[?&]categoryNo=(\d+)/u.exec(fallback);
  if (match === null) return null;
  const value = Number.parseInt(match[1] as string, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readLabel(element: Element): { name: string; postCount: number | null } {
  const text = (element.textContent ?? "").replace(/\s+/gu, " ").trim();
  const count = COUNT_PATTERN.exec(text);
  if (count === null) return { name: text, postCount: null };
  const digits = (count[1] as string).replace(/,/gu, "");
  const parsed = Number.parseInt(digits, 10);
  return {
    name: text.slice(0, count.index).trim(),
    postCount: Number.isSafeInteger(parsed) ? parsed : null,
  };
}

function readLogNo(href: string): string | null {
  const query = /[?&]logNo=(\d{6,20})/u.exec(href);
  if (query !== null) return query[1] as string;
  const path = /\/(\d{6,20})(?:[?#]|$)/u.exec(href);
  return path === null ? null : (path[1] as string);
}

function readPublishedAt(element: Element): string | null {
  let current: Element | null = element;
  for (let depth = 0; depth < 4 && current !== null; depth += 1) {
    const match = DATE_PATTERN.exec((current.textContent ?? "").trim());
    if (match !== null) {
      const [, year, month, day] = match;
      return `${year}-${(month as string).padStart(2, "0")}-${(day as string).padStart(2, "0")}`;
    }
    current = current.parentElement;
  }
  return null;
}

function absolute(href: string): string {
  try {
    return new URL(href, document.baseURI).toString();
  } catch {
    return href;
  }
}
