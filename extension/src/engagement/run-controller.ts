import { ApiClientError, LocalApiClient } from "../api/client";
import type {
  DiscoveryPost,
  EngagementRun,
  EngagementStepName,
  EngagementStepState,
  Recommendation,
} from "../api/types";
import {
  ChromeCommentPublishGateway,
  type CommentPublishGateway,
  type CommentPublishResult,
} from "../browser/naver-comment-publish-gateway";
import {
  ChromeNaverLikeGateway,
  type LikeActionResult,
  type NaverLikeGateway,
} from "../browser/naver-like-gateway";
import {
  ChromeNaverMutualNeighborGateway,
  type MutualNeighborActionCode,
  type NaverMutualNeighborGateway,
} from "../browser/naver-mutual-neighbor-gateway";
import type { EngagementApprovalSession } from "./approval-session";
import { sameSupportedNaverPost } from "../extraction/source-url";

type EngagementApi = Pick<LocalApiClient, "startEngagementRun" | "transitionEngagementStep">;

export interface EngagementRunControllerDependencies {
  api?: EngagementApi;
  comments?: CommentPublishGateway;
  likes?: NaverLikeGateway;
  mutualNeighbors?: NaverMutualNeighborGateway;
}

export interface EngagementExecutionRequest {
  discoveryPost: DiscoveryPost;
  recommendation: Recommendation;
  tabId: number;
  tokenId: string;
}

export interface EngagementExecutionResult {
  code: string;
  run: EngagementRun | null;
  status: "completed" | "failed" | "rejected" | "unconfirmed";
}

interface TerminalResult {
  resultCode: string;
  state: Exclude<EngagementStepState, "pending" | "running">;
}

export class EngagementRunController {
  readonly #api: EngagementApi;
  readonly #comments: CommentPublishGateway;
  readonly #likes: NaverLikeGateway;
  readonly #mutualNeighbors: NaverMutualNeighborGateway;
  readonly #session: EngagementApprovalSession;
  #busy = false;

  constructor(
    session: EngagementApprovalSession,
    {
      api = new LocalApiClient(),
      comments = new ChromeCommentPublishGateway(),
      likes = new ChromeNaverLikeGateway(),
      mutualNeighbors = new ChromeNaverMutualNeighborGateway(),
    }: EngagementRunControllerDependencies = {},
  ) {
    this.#session = session;
    this.#api = api;
    this.#comments = comments;
    this.#likes = likes;
    this.#mutualNeighbors = mutualNeighbors;
  }

  async execute(request: EngagementExecutionRequest): Promise<EngagementExecutionResult> {
    if (this.#busy) {
      return { code: "engagement_busy", run: null, status: "rejected" };
    }
    this.#busy = true;
    let run: EngagementRun | null = null;
    try {
      const token = this.#session.consume(request.tokenId);
      if (token === null || !matchesApproval(token.details, request)) {
        return { code: "approval_invalid", run: null, status: "rejected" };
      }
      run = (
        await this.#api.startEngagementRun({
          approvalId: token.id,
          discoveryPostId: request.discoveryPost.id,
          recommendationId: request.recommendation.id,
        })
      ).value;

      const interrupted = run.steps.find((step) => step.state === "running");
      if (interrupted !== undefined) {
        run = await this.#api.transitionEngagementStep(run.id, interrupted.name, {
          state: "unconfirmed",
          resultCode: "interrupted_before_confirmation",
        });
        return { code: "interrupted_before_confirmation", run, status: "unconfirmed" };
      }
      if (run.state === "unconfirmed") {
        return { code: "previous_result_unconfirmed", run, status: "unconfirmed" };
      }
      if (run.state === "succeeded") {
        return { code: "already_completed", run, status: "completed" };
      }

      for (const step of run.steps) {
        if (step.state === "succeeded" || step.state === "skipped") continue;
        if (step.state === "unconfirmed") {
          return {
            code: step.resultCode ?? "previous_result_unconfirmed",
            run,
            status: "unconfirmed",
          };
        }
        run = await this.#api.transitionEngagementStep(run.id, step.name, { state: "running" });
        const result = await this.#perform(step.name, request, token.details.neighborMessage);
        run = await this.#api.transitionEngagementStep(run.id, step.name, {
          state: result.state,
          resultCode: result.resultCode,
        });
        if (result.state === "failed") {
          return { code: result.resultCode, run, status: "failed" };
        }
        if (result.state === "unconfirmed") {
          return { code: result.resultCode, run, status: "unconfirmed" };
        }
      }
      return {
        code: run.state === "succeeded" ? "engagement_completed" : "engagement_incomplete",
        run,
        status: run.state === "succeeded" ? "completed" : "failed",
      };
    } catch (error) {
      return {
        code:
          error instanceof ApiClientError && error.problem !== null
            ? error.problem.code
            : error instanceof Error
              ? "engagement_api_error"
              : "engagement_unknown_error",
        run,
        status: "failed",
      };
    } finally {
      this.#busy = false;
    }
  }

  async #perform(
    step: EngagementStepName,
    request: EngagementExecutionRequest,
    neighborMessage: string | undefined,
  ): Promise<TerminalResult> {
    if (step === "like") {
      return likeResult(await this.#likes.like(request.tabId));
    }
    if (step === "comment") {
      return commentResult(
        await this.#comments.publish(request.tabId, approvedComment(request.recommendation)),
      );
    }
    const publisherBlogId = request.discoveryPost.publisherBlogId;
    if (publisherBlogId === null || neighborMessage === undefined) {
      return { state: "failed", resultCode: "mutual_neighbor_context_missing" };
    }
    return mutualNeighborResult(
      (await this.#mutualNeighbors.request(request.tabId, publisherBlogId, neighborMessage)).code,
    );
  }
}

function matchesApproval(
  details: {
    comment: string;
    neighborMessage?: string;
    sourceUrl: string;
    steps: readonly EngagementStepName[];
    title: string;
  },
  request: EngagementExecutionRequest,
): boolean {
  const requiredSteps: readonly EngagementStepName[] =
    request.discoveryPost.source === "neighbor"
      ? ["like", "comment"]
      : ["like", "comment", "mutual_neighbor"];
  return (
    request.tabId >= 0 &&
    Number.isSafeInteger(request.tabId) &&
    sameSupportedNaverPost(request.discoveryPost.sourceUrl, request.recommendation.sourceUrl) &&
    details.sourceUrl === request.recommendation.sourceUrl &&
    details.title === request.recommendation.title &&
    details.comment === approvedComment(request.recommendation) &&
    (request.recommendation.reviewStatus === "approved" ||
      request.recommendation.reviewStatus === "completed") &&
    sameSteps(details.steps, requiredSteps) &&
    (request.discoveryPost.source === "neighbor"
      ? details.neighborMessage === undefined
      : request.discoveryPost.publisherBlogId !== null &&
        details.neighborMessage !== undefined &&
        details.neighborMessage.trim().length > 0 &&
        Array.from(details.neighborMessage).length <= 500)
  );
}

function approvedComment(recommendation: Recommendation): string {
  const selected = recommendation.candidates.find(
    (candidate) => candidate.id === recommendation.selectedCandidateId,
  );
  return recommendation.editedComment ?? selected?.comment ?? "";
}

function sameSteps(
  actual: readonly EngagementStepName[],
  expected: readonly EngagementStepName[],
): boolean {
  return (
    actual.length === expected.length && actual.every((step, index) => step === expected[index])
  );
}

function likeResult(result: LikeActionResult): TerminalResult {
  if (result === "clicked") return { state: "succeeded", resultCode: result };
  if (result === "already_liked") return { state: "skipped", resultCode: result };
  if (result === "unconfirmed") return { state: "unconfirmed", resultCode: result };
  return { state: "failed", resultCode: result };
}

function commentResult(result: CommentPublishResult): TerminalResult {
  if (result === "submitted") return { state: "succeeded", resultCode: result };
  if (result === "submission_unconfirmed") {
    return { state: "unconfirmed", resultCode: result };
  }
  return { state: "failed", resultCode: result };
}

function mutualNeighborResult(result: MutualNeighborActionCode): TerminalResult {
  if (result === "requested") return { state: "succeeded", resultCode: result };
  if (result === "already_mutual" || result === "request_pending") {
    return { state: "skipped", resultCode: result };
  }
  if (result === "request_unconfirmed") {
    return { state: "unconfirmed", resultCode: result };
  }
  return { state: "failed", resultCode: result };
}
