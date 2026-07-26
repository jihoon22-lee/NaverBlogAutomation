import { configureSidePanel } from "./browser/configure-side-panel";
import { LOCAL_API_ORIGIN } from "./config";

configureSidePanel(chrome);

const DISCOVERY_ALARM = "discovery-queue-check";
const DISCOVERY_COUNT_KEY = "discovery-queued-neighbor-count";

chrome.alarms.create(DISCOVERY_ALARM, { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DISCOVERY_ALARM) void updateDiscoveryBadge();
});
void updateDiscoveryBadge();

async function updateDiscoveryBadge(): Promise<void> {
  try {
    const response = await fetch(`${LOCAL_API_ORIGIN}/api/v1/discovery/queue?source=neighbor`, {
      cache: "no-store",
      credentials: "omit",
    });
    const value: unknown = await response.json();
    if (!response.ok || !isQueueResponse(value)) return;
    const count = value.items.length;
    await chrome.action.setBadgeText({ text: count === 0 ? "" : String(count) });
    const previous = await chrome.storage.local.get(DISCOVERY_COUNT_KEY);
    const previousCount =
      typeof previous[DISCOVERY_COUNT_KEY] === "number" ? previous[DISCOVERY_COUNT_KEY] : 0;
    await chrome.storage.local.set({ [DISCOVERY_COUNT_KEY]: count });
    if (count > previousCount) {
      await chrome.notifications.create("discovery-queue-update", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon.svg"),
        title: "네이버 블로그 새 글",
        message: `이웃 새 글 ${count}개가 대기열에 있습니다.`,
      });
    }
  } catch {
    // The local API is optional while the user has not started its launcher.
  }
}

function isQueueResponse(value: unknown): value is { items: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { items?: unknown }).items)
  );
}
