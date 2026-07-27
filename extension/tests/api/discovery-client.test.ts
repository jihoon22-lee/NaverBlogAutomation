import { describe, expect, it, vi } from "vitest";

import { LocalApiClient } from "../../src/api/client";

const id = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-07-26T00:00:00Z";

function json(value: object, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("LocalApiClient discovery API", () => {
  it("parses user-reviewed discovery settings, queue data, and import results", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json({
          items: [
            {
              id,
              name: "이웃",
              blog_url: "https://blog.naver.com/friend",
              blog_id: "friend",
              enabled: true,
              feed_status: "ready",
              last_checked_at: timestamp,
              created_at: timestamp,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json(
          {
            id,
            name: "이웃",
            blog_url: "https://blog.naver.com/friend",
            blog_id: "friend",
            enabled: true,
            feed_status: "unknown",
            last_checked_at: null,
            created_at: timestamp,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        json({
          items: [
            {
              id,
              query: "여행",
              excluded_terms: ["광고"],
              freshness_days: 14,
              enabled: true,
              created_at: timestamp,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json(
          {
            id,
            query: "여행",
            excluded_terms: [],
            freshness_days: 7,
            enabled: true,
            created_at: timestamp,
          },
          201,
        ),
      )
      .mockResolvedValueOnce(json({ imported_count: 1 }))
      .mockResolvedValueOnce(
        json({
          items: [
            {
              id,
              source: "search",
              state: "queued",
              source_url: "https://blog.naver.com/friend/123",
              title: "글",
              publisher_name: null,
              publisher_blog_id: "friend",
              published_at: null,
              neighbor_id: null,
              search_id: id,
              created_at: timestamp,
              updated_at: timestamp,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          id,
          source: "search",
          state: "opened",
          source_url: "https://blog.naver.com/friend/123",
          title: "글",
          publisher_name: null,
          publisher_blog_id: "friend",
          published_at: null,
          neighbor_id: null,
          search_id: id,
          created_at: timestamp,
          updated_at: timestamp,
        }),
      )
      .mockResolvedValueOnce(json({ imported_count: 2 }))
      .mockResolvedValueOnce(
        json({
          timezone: "Asia/Seoul",
          hour: 9,
          minute: 0,
          email_enabled: false,
          smtp_configured: true,
        }),
      )
      .mockResolvedValueOnce(
        json({
          timezone: "Asia/Seoul",
          hour: 8,
          minute: 30,
          email_enabled: false,
          smtp_configured: true,
        }),
      )
      .mockResolvedValueOnce(
        json({
          own_blog_id: "mine",
          enabled: false,
          timezone: "Asia/Seoul",
          hour: 9,
          minute: 0,
          last_synced_at: null,
          last_status: "never",
          last_detail: "",
        }),
      )
      .mockResolvedValueOnce(
        json({
          own_blog_id: "mine",
          enabled: true,
          timezone: "Asia/Seoul",
          hour: 8,
          minute: 30,
          last_synced_at: timestamp,
          last_status: "success",
          last_detail: "동기화 완료",
        }),
      )
      .mockResolvedValueOnce(
        json({
          neighbors_added: 1,
          neighbor_posts_added: 2,
          search_posts_added: 3,
          search_provider: "naver_open_api",
          status: "success",
          detail: "동기화 완료",
        }),
      );
    const client = new LocalApiClient(fetch);

    await expect(client.listDiscoveryNeighbors()).resolves.toHaveLength(1);
    await expect(
      client.saveDiscoveryNeighbor({
        name: "이웃",
        blogUrl: "https://blog.naver.com/friend",
        blogId: "friend",
      }),
    ).resolves.toMatchObject({ id, name: "이웃" });
    await expect(client.listDiscoverySearches()).resolves.toHaveLength(1);
    await expect(client.saveDiscoverySearch({ query: "여행" })).resolves.toMatchObject({
      freshnessDays: 7,
    });
    await expect(
      client.importDiscoveryPosts("search", id, [
        { sourceUrl: "https://blog.naver.com/friend/123", title: "글" },
      ]),
    ).resolves.toBe(1);
    await expect(client.listDiscoveryQueue("search")).resolves.toHaveLength(1);
    await expect(client.updateDiscoveryPostState(id, "opened")).resolves.toMatchObject({
      state: "opened",
    });
    await expect(client.refreshDiscoveryNeighbors()).resolves.toBe(2);
    await expect(client.digestSettings()).resolves.toMatchObject({
      timezone: "Asia/Seoul",
      smtpConfigured: true,
    });
    await expect(
      client.saveDigestSettings({
        timezone: "Asia/Seoul",
        hour: 8,
        minute: 30,
        emailEnabled: false,
      }),
    ).resolves.toMatchObject({ hour: 8 });
    await expect(client.automaticDiscoverySettings()).resolves.toMatchObject({
      ownBlogId: "mine",
      lastStatus: "never",
    });
    await expect(
      client.saveAutomaticDiscoverySettings({
        ownBlogId: "mine",
        enabled: true,
        timezone: "Asia/Seoul",
        hour: 8,
        minute: 30,
      }),
    ).resolves.toMatchObject({ enabled: true, lastSyncedAt: timestamp });
    await expect(client.syncAutomaticDiscovery()).resolves.toMatchObject({
      neighborsAdded: 1,
      neighborPostsAdded: 2,
      searchPostsAdded: 3,
      searchProvider: "naver_open_api",
      status: "success",
    });
    expect(fetch).toHaveBeenCalledTimes(13);
  });

  it("refreshes one saved search through the documented Naver API", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json({
        imported_count: 2,
        provider: "naver_open_api",
        detail: "공식 네이버 검색 API에서 검색 후보 2개를 확인했습니다.",
      }),
    );

    await expect(new LocalApiClient(fetch).refreshDiscoverySearch(id)).resolves.toEqual({
      importedCount: 2,
      provider: "naver_open_api",
      detail: "공식 네이버 검색 API에서 검색 후보 2개를 확인했습니다.",
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/v1/discovery/searches/${id}/refresh`),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("deletes a saved search while keeping its previously collected posts", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(new LocalApiClient(fetch).deleteDiscoverySearch(id)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/v1/discovery/searches/${id}`),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("does not pretend a saved search was deleted on an unexpected response", async () => {
    await expect(
      new LocalApiClient(
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })),
      ).deleteDiscoverySearch(id),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects malformed automatic-discovery settings and synchronization responses", async () => {
    const settings = {
      own_blog_id: "mine",
      enabled: true,
      timezone: "Asia/Seoul",
      hour: 9,
      minute: 0,
      last_synced_at: null,
      last_status: "success",
      last_detail: "동기화 완료",
    };
    const invalidSettings = [
      { ...settings, unexpected: true },
      { ...settings, own_blog_id: 1 },
      { ...settings, timezone: "" },
      { ...settings, hour: 24 },
      { ...settings, minute: -1 },
      { ...settings, enabled: "true" },
      { ...settings, last_synced_at: "not-a-date" },
      { ...settings, last_status: "pending" },
      { ...settings, last_detail: 1 },
    ];
    for (const value of invalidSettings) {
      await expect(
        new LocalApiClient(
          vi.fn<typeof fetch>().mockResolvedValue(json(value)),
        ).automaticDiscoverySettings(),
      ).rejects.toBeDefined();
    }

    const synchronization = {
      neighbors_added: 1,
      neighbor_posts_added: 2,
      search_posts_added: 3,
      search_provider: "naver_open_api",
      status: "success",
      detail: "동기화 완료",
    };
    const invalidSynchronizations = [
      { ...synchronization, neighbors_added: -1 },
      { ...synchronization, neighbor_posts_added: 51 },
      { ...synchronization, search_posts_added: "3" },
      { ...synchronization, search_provider: "unknown" },
      { ...synchronization, status: "running" },
      { ...synchronization, detail: 3 },
      { ...synchronization, unexpected: true },
    ];
    for (const value of invalidSynchronizations) {
      await expect(
        new LocalApiClient(
          vi.fn<typeof fetch>().mockResolvedValue(json(value)),
        ).syncAutomaticDiscovery(),
      ).rejects.toBeDefined();
    }
  });
});
