const NAVER_ORIGINS = ["https://blog.naver.com/*", "https://m.blog.naver.com/*"] as const;

export class NaverSitePermission {
  constructor(private readonly api: typeof chrome.permissions = chrome.permissions) {}

  async granted(): Promise<boolean> {
    return this.api.contains({ origins: [...NAVER_ORIGINS] });
  }

  async request(): Promise<boolean> {
    return this.api.request({ origins: [...NAVER_ORIGINS] });
  }
}
