import { describe, expect, test } from "bun:test";
import { classifyDiscordRoute, DiscordClient } from "./client";

describe("classifyDiscordRoute", () => {
  test("sanitizes channel and message IDs", () => {
    expect(
      classifyDiscordRoute(
        "https://discord.com/api/v10/channels/111111111111111111/messages?limit=100&after=222222222222222222",
      ),
    ).toBe("/channels/:id/messages?after");

    expect(
      classifyDiscordRoute(
        "https://discord.com/api/v10/channels/111111111111111111/messages/222222222222222222/reactions/smile:333333333333333333?limit=100",
      ),
    ).toBe("/channels/:id/messages/:id/reactions/:emoji");

    expect(
      classifyDiscordRoute(
        "https://discord.com/api/v10/channels/111111111111111111/polls/222222222222222222/answers/3?limit=100&after=333333333333333333",
      ),
    ).toBe("/channels/:id/polls/:id/answers/:id");
  });

  test("keeps route intent without exposing guild IDs", () => {
    expect(
      classifyDiscordRoute(
        "https://discord.com/api/v10/guilds/444444444444444444/messages/search?author_id=555555555555555555&min_id=666666666666666666&max_id=777777777777777777",
      ),
    ).toBe("/guilds/:id/messages/search?min_id&max_id");

    expect(
      classifyDiscordRoute(
        "https://discord.com/api/v10/guilds/444444444444444444/emojis",
      ),
    ).toBe("/guilds/:id/emojis");

    expect(
      classifyDiscordRoute(
        "https://discord.com/api/v10/channels/888888888888888888/threads/search?archived=true&offset=25",
      ),
    ).toBe("/channels/:id/threads/search?archived=true");
  });
});

describe("DiscordClient poll voters", () => {
  test("paginates poll answer voters with after and limit 100", async () => {
    const originalFetch = globalThis.fetch;
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `900000000000000${String(index).padStart(3, "0")}`,
      username: `user-${index}`,
      global_name: index === 0 ? "Alice" : null,
      avatar: index === 0 ? "aaaa1111" : null,
    }));
    const secondPage = [{
      id: "900000000000000100",
      username: "bob",
      global_name: "Bob",
      avatar: "bbbb2222",
    }];
    const calls: URL[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      calls.push(url);
      return new Response(JSON.stringify(url.searchParams.has("after") ? { users: secondPage } : { users: firstPage }));
    }) as unknown as typeof fetch;

    try {
      const client = new DiscordClient("test-token");
      const users = await client.fetchPollAnswerVoters(
        "800000000000000001",
        "800000000000000002",
        3,
      );

      expect(users).toHaveLength(101);
      expect(users[0]).toEqual({
        id: firstPage[0].id,
        name: "Alice",
        username: "user-0",
        avatar: "aaaa1111",
      });
      expect(users[1]).toEqual({
        id: firstPage[1].id,
        name: "user-1",
        username: "user-1",
        avatar: null,
      });
      expect(users.at(-1)).toEqual({
        id: "900000000000000100",
        name: "Bob",
        username: "bob",
        avatar: "bbbb2222",
      });
      expect(calls).toHaveLength(2);
      expect(calls[0].searchParams.get("limit")).toBe("100");
      expect(calls[0].searchParams.has("after")).toBe(false);
      expect(calls[1].searchParams.get("limit")).toBe("100");
      expect(calls[1].searchParams.get("after")).toBe(firstPage[99].id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws when a later voter page is inaccessible", async () => {
    const originalFetch = globalThis.fetch;
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `900000000000000${String(index).padStart(3, "0")}`,
      username: `user-${index}`,
      global_name: null,
      avatar: "aaaa1111",
    }));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      return url.searchParams.has("after")
        ? new Response(null, { status: 403 })
        : new Response(JSON.stringify({ users: firstPage }));
    }) as unknown as typeof fetch;

    try {
      const client = new DiscordClient("test-token");
      await expect(
        client.fetchPollAnswerVoters(
          "800000000000000001",
          "800000000000000002",
          3,
        ),
      ).rejects.toThrow("Failed to fetch poll answer voters: 403");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("DiscordClient message reconciliation signals", () => {
  const apiMessage = (id: string) => ({
    id,
    type: 0,
    content: id,
    channel_id: "channel-1",
    author: {
      id: "author-1",
      username: "alice",
      global_name: "Alice",
      discriminator: "0",
      avatar: null,
    },
    timestamp: "2026-01-01T00:00:00.000Z",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    attachments: [],
    embeds: [],
    pinned: false,
  });

  test("marks an empty range traversal complete", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("[]")) as unknown as typeof fetch;
    let completed = false;

    try {
      const client = new DiscordClient("test-token");
      for await (const _batch of client.fetchMessagesInRange("channel-1", "1", "3", {
        onComplete: () => { completed = true; },
      })) {
        // Empty response.
      }
      expect(completed).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not report a 404 range traversal as complete", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    let completed = false;
    let unavailable: number | undefined;

    try {
      const client = new DiscordClient("test-token");
      for await (const _batch of client.fetchMessagesInRange("channel-1", "1", "3", {
        onComplete: () => { completed = true; },
        onUnavailable: (status) => { unavailable = status; },
      })) {
        // Inaccessible response.
      }
      expect(completed).toBe(false);
      expect(unavailable).toBe(404);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("pages backward until it reaches the lower range bound", async () => {
    const originalFetch = globalThis.fetch;
    const firstPage = Array.from({ length: 100 }, (_, index) => apiMessage(String(299 - index)));
    const secondPage = [apiMessage("199"), apiMessage("150"), apiMessage("100")];
    const calls: URL[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      calls.push(url);
      return new Response(JSON.stringify(calls.length === 1 ? firstPage : secondPage));
    }) as unknown as typeof fetch;
    const ids: string[] = [];

    try {
      const client = new DiscordClient("test-token");
      for await (const batch of client.fetchMessagesInRange("channel-1", "100", "300")) {
        ids.push(...batch.map((message) => message.id));
      }
      expect(ids).toHaveLength(102);
      expect(ids).toContain("150");
      expect(ids).toContain("299");
      expect(calls.map((url) => url.searchParams.get("before"))).toEqual(["300", "200"]);
      expect(calls.every((url) => !url.searchParams.has("after"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("only a successful around response can report a message missing", async () => {
    const originalFetch = globalThis.fetch;
    const responses = [new Response("[]"), new Response(null, { status: 404 })];
    globalThis.fetch = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected fetch");
      return response;
    }) as unknown as typeof fetch;

    try {
      const client = new DiscordClient("test-token");
      expect(await client.checkMessagePresence("channel-1", "message-1")).toEqual({ kind: "missing" });
      expect(await client.checkMessagePresence("channel-1", "message-1")).toEqual({
        kind: "unavailable",
        status: 404,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("DiscordClient stats", () => {
  test("tracks route status counts and uses Retry-After without padding", async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      new Response(null, { status: 429, headers: { "Retry-After": "0.01" } }),
      new Response(JSON.stringify({ id: "user-1", username: "alice" }), { status: 200 }),
    ];
    globalThis.fetch = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected fetch");
      return response;
    }) as unknown as typeof fetch;

    try {
      const client = new DiscordClient("test-token");
      const user = await client.getCurrentUser();
      const stats = client.getStats();

      expect(user).toEqual({ id: "user-1", username: "alice" });
      expect(stats.totalRequests).toBe(2);
      expect(stats.routeCounts["/users/@me"]).toBe(2);
      expect(stats.routeDurationMs["/users/@me"]).toBeGreaterThan(0);
      expect(stats.routeMaxDurationMs["/users/@me"]).toBeGreaterThan(0);
      expect(stats.routeDurationMs["/users/@me"]).toBeGreaterThanOrEqual(
        stats.routeMaxDurationMs["/users/@me"],
      );
      expect(stats.statusCounts["429"]).toBe(1);
      expect(stats.statusCounts["200"]).toBe(1);
      expect(stats.routeStatusCounts["/users/@me"]["429"]).toBe(1);
      expect(stats.routeStatusCounts["/users/@me"]["200"]).toBe(1);
      expect(stats.rateLimit429Count).toBe(1);
      expect(stats.retrySleepCount).toBe(1);
      expect(stats.retrySleepMs).toBeLessThan(250);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
