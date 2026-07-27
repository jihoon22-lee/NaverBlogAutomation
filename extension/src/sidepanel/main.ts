import { ChromeTabCaptureGateway } from "../browser/tab-capture-gateway";
import { NaverSitePermission } from "../browser/naver-site-permission";
import { DiscoveryController } from "../discovery/controller";
import { EngagementApprovalSession } from "../engagement/approval-session";
import { EngagementConsentController } from "../engagement/consent-controller";
import { EngagementRunController } from "../engagement/run-controller";
import { IdempotencyRegistry, restrictStorageToTrustedContexts } from "../idempotency/registry";
import { HistoryController } from "../history/controller";
import { DomHistoryView } from "../history/view";
import { SidePanelController } from "./controller";
import { DomPanelView } from "./view";

const view = new DomPanelView(document);
let controller: SidePanelController | null = null;
let historyController: HistoryController | null = null;
let discoveryController: DiscoveryController | null = null;
let engagementConsentController: EngagementConsentController | null = null;

async function configureNaverPermission(): Promise<void> {
  const permission = new NaverSitePermission();
  const card = document.querySelector<HTMLElement>("#naver-permission-card");
  const button = document.querySelector<HTMLButtonElement>("#naver-permission-button");
  const notice = document.querySelector<HTMLElement>("#naver-permission-notice");
  if (card === null || button === null || notice === null) return;
  const render = async (): Promise<void> => {
    card.hidden = await permission.granted();
  };
  await render();
  button.addEventListener("click", () => {
    void (async () => {
      try {
        const granted = await permission.request();
        notice.textContent = granted
          ? "접근을 허용했습니다. 현재 네이버 글을 다시 읽습니다."
          : "허용하지 않아도 확장 아이콘을 클릭한 현재 탭에서는 사용할 수 있습니다.";
        await render();
        if (granted) controller?.captureActivePost();
      } catch {
        notice.textContent =
          "접근 권한 요청을 완료하지 못했습니다. 확장 아이콘을 다시 열어 시도해 주세요.";
      }
    })();
  });
}

void (async () => {
  try {
    await restrictStorageToTrustedContexts();
    const registry = new IdempotencyRegistry();
    const api = new LocalApiClient();
    const session = new EngagementApprovalSession();
    historyController = new HistoryController(new DomHistoryView(document), api, registry);
    historyController.start();
    engagementConsentController = new EngagementConsentController(document, {
      session,
    });
    await engagementConsentController.start();
    controller = new SidePanelController(new ChromeTabCaptureGateway(), view, {
      api,
      approval: engagementConsentController,
      engagement: new EngagementRunController(session, { api }),
      registry,
    });
    controller.start();
    await configureNaverPermission();
    discoveryController = new DiscoveryController(document, api);
    discoveryController.start();
  } catch {
    view.render({
      failure: {
        action: null,
        code: "storage_unavailable",
        message:
          "Browser storage를 trusted extension context로 제한하지 못해 안전하게 시작할 수 없습니다.",
        title: "Extension storage를 준비하지 못했습니다",
      },
      kind: "error",
    });
  }
})();

window.addEventListener(
  "pagehide",
  () => {
    controller?.dispose();
    engagementConsentController?.dispose();
    historyController?.dispose();
    controller = null;
    engagementConsentController = null;
    historyController = null;
  },
  { once: true },
);

window.addEventListener("discovery-open-post", (event) => {
  const detail = (event as CustomEvent<{ post?: unknown; tabId?: unknown }>).detail;
  if (typeof detail?.tabId === "number" && isDiscoveryPost(detail.post)) {
    engagementConsentController?.cancelPendingApproval();
    void controller?.captureDiscoveryPost(detail.post, detail.tabId);
  }
});

window.addEventListener("engagement-run-updated", () => {
  void historyController?.refresh();
});

function isDiscoveryPost(value: unknown): value is DiscoveryPost {
  if (typeof value !== "object" || value === null) return false;
  const post = value as Partial<DiscoveryPost>;
  return (
    typeof post.id === "string" &&
    (post.source === "neighbor" || post.source === "search") &&
    typeof post.sourceUrl === "string" &&
    typeof post.title === "string" &&
    (post.publisherBlogId === null || typeof post.publisherBlogId === "string")
  );
}
import { LocalApiClient } from "../api/client";
import type { DiscoveryPost } from "../api/types";
