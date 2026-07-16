chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setBadgeText({ text: "" });
});
