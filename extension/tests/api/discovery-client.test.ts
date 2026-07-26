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
    expect(fetch).toHaveBeenCalledTimes(10);
  });
});
