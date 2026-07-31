/**
 * Global entry point for the injected page bundle.
 *
 * The Python layer evaluates `window.__nbaPage.<probe>(...)` inside an isolated context. Every
 * exported function is read-only; the caller performs actions with trusted CDP input.
 */

import { type ArticleCapture, captureArticle } from "./article";
import {
  type CommentPageDiagnosis,
  type CommentProbe,
  captchaVisible,
  commentStillPending,
  countMatchingComments,
  diagnoseCommentPage,
  probeComment,
} from "./comment";
import { type LikeProbe, probeLike, probeLikeOption } from "./like";
import {
  type BlogCategoryListProbe,
  type BlogPostListProbe,
  probeCategoryPostList,
  probeMyBlogCategories,
} from "./my-blog";
import {
  type NeighborApplicationProbe,
  type NeighborConfirmationProbe,
  type NeighborOptionProbe,
  type NeighborRelationshipProbe,
  probeNeighborApplication,
  probeNeighborConfirmation,
  probeNeighborOption,
  probeNeighborRelationship,
} from "./mutual-neighbor";

export const PAGE_BUNDLE_NAMESPACE = "__nbaPage";
export const PAGE_BUNDLE_VERSION = 2;

export interface PageBundle {
  captchaVisible(): boolean;
  captureArticle(): ArticleCapture | null;
  commentStillPending(selector: string, expectedValue: string): boolean;
  countMatchingComments(expectedValue: string): number;
  diagnoseCommentPage(): CommentPageDiagnosis;
  probeCategoryPostList(): BlogPostListProbe;
  probeComment(expectedValue: string): CommentProbe;
  probeLike(): LikeProbe;
  probeMyBlogCategories(): BlogCategoryListProbe;
  probeLikeOption(): string | null;
  probeNeighborApplication(expectedMessage: string): NeighborApplicationProbe;
  probeNeighborConfirmation(): NeighborConfirmationProbe;
  probeNeighborOption(): NeighborOptionProbe;
  probeNeighborRelationship(): NeighborRelationshipProbe;
  version: number;
}

/** Build the read-only probe surface exposed to the automation layer. */
export function createPageBundle(): PageBundle {
  return {
    captchaVisible,
    captureArticle,
    commentStillPending,
    countMatchingComments,
    diagnoseCommentPage,
    probeCategoryPostList,
    probeComment,
    probeLike,
    probeLikeOption,
    probeMyBlogCategories,
    probeNeighborApplication,
    probeNeighborConfirmation,
    probeNeighborOption,
    probeNeighborRelationship,
    version: PAGE_BUNDLE_VERSION,
  };
}

/** Install the bundle on the isolated-context global object exactly once. */
export function installPageBundle(target: Record<string, unknown> = globalThis): PageBundle {
  const existing = target[PAGE_BUNDLE_NAMESPACE];
  if (existing !== undefined && (existing as PageBundle).version === PAGE_BUNDLE_VERSION) {
    return existing as PageBundle;
  }
  const bundle = createPageBundle();
  target[PAGE_BUNDLE_NAMESPACE] = bundle;
  return bundle;
}

installPageBundle();
