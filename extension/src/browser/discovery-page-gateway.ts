import {
  captureDiscoveryPage,
  type DiscoveryPageCapture,
} from "../extraction/capture-discovery-page";
import { BrowserCaptureError, type TabCaptureGateway } from "./tab-capture-gateway";

export class ChromeDiscoveryPageGateway {
  constructor(private readonly gateway: TabCaptureGateway) {}

  async capture(): Promise<DiscoveryPageCapture> {
    const tab = await this.gateway.getActiveTab();
    try {
      const [result] = await chrome.scripting.executeScript({
        func: captureDiscoveryPage,
        target: { tabId: tab.id },
        world: "ISOLATED",
      });
      if (result?.result === undefined) throw new BrowserCaptureError("permission_denied");
      return result.result;
    } catch {
      throw new BrowserCaptureError("permission_denied");
    }
  }
}
