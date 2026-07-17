export interface SidePanelSetupApi {
  sidePanel: Pick<typeof chrome.sidePanel, "setPanelBehavior">;
}

export async function configureSidePanel(api: SidePanelSetupApi): Promise<void> {
  await api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}
