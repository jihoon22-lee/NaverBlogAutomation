import { ChromeTabCaptureGateway } from "../browser/tab-capture-gateway";
import { SidePanelController } from "./controller";
import { DomPanelView } from "./view";

const controller = new SidePanelController(
  new ChromeTabCaptureGateway(),
  new DomPanelView(document),
);

controller.start();
window.addEventListener("pagehide", () => controller.dispose(), { once: true });
