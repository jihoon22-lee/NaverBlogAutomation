export interface SidePanelSetupApi {
  action: {
    onClicked: Pick<typeof chrome.action.onClicked, "addListener">;
  };
  sidePanel: {
    open(options: { tabId: number }): Promise<void>;
    setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
  };
}

export function configureSidePanel(api: SidePanelSetupApi): void {
  api.action.onClicked.addListener((tab) => {
    const tabId = tab.id;
    if (!isChromeTabId(tabId)) {
      return;
    }
    ignoreChromeFailure(() => api.sidePanel.open({ tabId }));
  });

  // A previous release persisted the declarative action behavior. Reset it only after the
  // explicit listener is registered so a failed migration cannot make a cold worker miss clicks.
  ignoreChromeFailure(() => api.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }));
}

function isChromeTabId(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function ignoreChromeFailure(operation: () => Promise<void>): void {
  try {
    void operation().catch(() => undefined);
  } catch {
    // Chrome may synchronously reject an API call while its context is being torn down.
  }
}
