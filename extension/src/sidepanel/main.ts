import { ChromeTabCaptureGateway } from "../browser/tab-capture-gateway";
import { IdempotencyRegistry, restrictStorageToTrustedContexts } from "../idempotency/registry";
import { HistoryController } from "../history/controller";
import { DomHistoryView } from "../history/view";
import { SidePanelController } from "./controller";
import { DomPanelView } from "./view";

const view = new DomPanelView(document);
let controller: SidePanelController | null = null;
let historyController: HistoryController | null = null;

void (async () => {
  try {
    await restrictStorageToTrustedContexts();
    const registry = new IdempotencyRegistry();
    historyController = new HistoryController(new DomHistoryView(document), undefined, registry);
    historyController.start();
    controller = new SidePanelController(new ChromeTabCaptureGateway(), view, { registry });
    controller.start();
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
    historyController?.dispose();
    controller = null;
    historyController = null;
  },
  { once: true },
);
