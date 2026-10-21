import { QueryClient } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClientDefaultOptions } from "./query-client";
import { queryOptions } from "./queries";
import { getToday } from "./timelineDate";

describe("map events query", () => {
  it("polls today but not historic days", () => {
    const todayOptions = queryOptions.mapEventsForDay(getToday(), []);
    const historicOptions = queryOptions.mapEventsForDay("2000-01-01", []);

    expect(todayOptions.refetchInterval).toBe(60_000);
    expect(historicOptions.refetchInterval).toBe(false);
  });
});

describe("conversation query cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deduplicates and reuses transcript pages across consumers", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({
      title: "Example conversation",
      events: [],
      nextCursor: null,
      server: null,
    })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: queryClientDefaultOptions });
    const options = queryOptions.conversationPage({
      conversationId: "conversation-1",
      source: "discord",
      limit: 100,
      order: "desc",
    });

    await Promise.all([client.fetchQuery(options), client.fetchQuery(options)]);
    await client.fetchQuery(options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the loaded media pages when a gallery remounts", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({
      attachments: [],
      nextCursor: null,
    })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: queryClientDefaultOptions });
    const options = queryOptions.conversationMedia({
      conversationId: "conversation-1",
      source: "discord",
      mime: "image",
    });

    await client.fetchInfiniteQuery(options);
    await client.fetchInfiniteQuery(options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates range exports and keys them by effective format", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(Response.json({
      text: "Alice: hello\nBob: hi",
      eventCount: 2,
      tokenCount: 8,
      range: {
        startEventId: 11,
        endEventId: 12,
        requestedStartEventId: 11,
        requestedEndEventId: 12,
        source: "discord",
        sourceAccount: null,
        conversationId: "conversation-1",
        title: "Example conversation",
        startTimestamp: "2026-01-01T00:00:00Z",
        endTimestamp: "2026-01-01T00:01:00Z",
      },
    })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: queryClientDefaultOptions });
    const request = {
      startEventId: 11,
      endEventId: 12,
      format: { timestampStyle: "date-headers" as const, includeReactions: true, compactAuthors: true },
    };
    const options = queryOptions.conversationRangeExport(request);
    const cachedRequest = options.queryKey[2];

    expect(cachedRequest?.format?.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(options.gcTime).toBe(2 * 60_000);

    await Promise.all([client.fetchQuery(options), client.fetchQuery(options)]);
    await client.fetchQuery(options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("expected fetch to be called");
    const postedRequest = JSON.parse(String(firstCall[1]?.body));
    expect(postedRequest).toEqual(cachedRequest);

    await client.fetchQuery(queryOptions.conversationRangeExport({
      ...request,
      format: { ...request.format, timestampStyle: "full-timestamps" },
    }));

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const utcOptions = queryOptions.conversationRangeExport({
      ...request,
      format: { ...request.format, timeZone: "UTC" },
    });
    const newYorkOptions = queryOptions.conversationRangeExport({
      ...request,
      format: { ...request.format, timeZone: "America/New_York" },
    });
    expect(utcOptions.queryKey).not.toEqual(newYorkOptions.queryKey);
  });

  it("refetches a cached transcript page when polling requests staleTime zero", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({
      title: "Example conversation",
      events: [],
      nextCursor: null,
      server: null,
    })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: queryClientDefaultOptions });
    const options = queryOptions.conversationPage({
      conversationId: "conversation-1",
      source: "discord",
      limit: 50,
      cursor: "2026-07-12T12:00:00Z_42",
      order: "asc",
    });

    await client.fetchQuery({ ...options, staleTime: 0 });
    await client.fetchQuery({ ...options, staleTime: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("query cancellation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes TanStack's abort signal to search requests", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Search cancelled", "AbortError")),
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: queryClientDefaultOptions });
    const options = queryOptions.searchEvents({ text: "slow search" }, true);
    const request = client.fetchInfiniteQuery(options).catch(() => undefined);

    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    await client.cancelQueries({ queryKey: options.queryKey });

    expect(requestSignal?.aborted).toBe(true);
    await request;
  });
});

describe("route query cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reuses fresh route data under stable keys", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (url.pathname === "/api/playlists") {
        return Promise.resolve(Response.json({ playlists: [] }));
      }
      if (url.pathname === "/api/music/friends/latest") {
        return Promise.resolve(Response.json({ friends: [] }));
      }
      if (url.pathname === "/api/music/rankings") {
        return Promise.resolve(Response.json({
          period: url.searchParams.get("period"),
          periodStart: null,
          totalPlays: 0,
          listeningMs: 0,
          firstPlayedAt: null,
          lastPlayedAt: null,
          topTracks: [],
          topArtists: [],
        }));
      }
      if (url.pathname === "/api/music/recent") {
        return Promise.resolve(Response.json({ recent: [] }));
      }
      if (url.pathname.startsWith("/api/playlists/")) {
        return Promise.resolve(Response.json({
          playlistId: url.pathname.split("/").at(-1),
          name: "Example playlist",
          imageUrl: null,
          createdDate: null,
          observations: [],
        }));
      }
      if (url.pathname.startsWith("/api/wakatime/projects/")) {
        const project = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        return Promise.resolve(Response.json({
          project: {
            name: project,
            totalDuration: 0,
            sessionCount: 0,
            firstActivity: null,
            lastActivity: null,
          },
          byLanguage: [],
          byBranch: [],
          byDay: [],
          activityByMonth: [],
        }));
      }
      if (url.pathname === "/api/discord/servers") {
        return Promise.resolve(Response.json({ servers: [] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: queryClientDefaultOptions });

    await client.fetchQuery(queryOptions.musicPlaylists());
    await client.fetchQuery(queryOptions.musicPlaylists());
    await client.fetchQuery(queryOptions.musicRankings("4w"));
    await client.fetchQuery(queryOptions.musicRankings("4w"));
    await client.fetchQuery(queryOptions.musicRecent());
    await client.fetchQuery(queryOptions.musicRecent());
    await client.fetchQuery(queryOptions.musicFriendListens());
    await client.fetchQuery(queryOptions.musicFriendListens());
    await client.fetchQuery(queryOptions.musicPlaylist("playlist-a"));
    await client.fetchQuery(queryOptions.musicPlaylist("playlist-a"));
    await client.fetchQuery(queryOptions.codingProject("project-a"));
    await client.fetchQuery(queryOptions.codingProject("project-a"));
    await client.fetchQuery(queryOptions.discordServers());
    await client.fetchQuery(queryOptions.discordServers());

    expect(fetchMock).toHaveBeenCalledTimes(7);

    await client.fetchQuery(queryOptions.musicRankings("6m"));
    await client.fetchQuery(queryOptions.musicPlaylist("playlist-b"));
    await client.fetchQuery(queryOptions.codingProject("project-b"));

    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("reuses every loaded coding-session page", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      const cursor = url.searchParams.get("cursor");
      return Promise.resolve(Response.json(cursor
        ? { sessions: [{ id: 2 }], count: 2, nextCursor: null }
        : { sessions: [{ id: 1 }], count: 2, nextCursor: "cursor-2" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: queryClientDefaultOptions });
    const options = { ...queryOptions.codingProjectSessions("example"), pages: 2 };

    const first = await client.fetchInfiniteQuery(options);
    const second = await client.fetchInfiniteQuery(options);

    expect(first.pages.flatMap((page) => page.sessions.map((session) => session.id))).toEqual([1, 2]);
    expect(second.pages).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("cursor=");
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=cursor-2");

    await client.fetchInfiniteQuery(queryOptions.codingProjectSessions("another-project"));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("/another-project/sessions");
  });

  it("uses the loaded conversation count as the next offset", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      const offset = url.searchParams.get("offset");
      return Promise.resolve(Response.json({
        conversations: [{ title: offset ? "Second" : "First" }],
        total: 2,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({ defaultOptions: queryClientDefaultOptions });
    const options = { ...queryOptions.codingProjectConversations("example"), pages: 2 };

    const first = await client.fetchInfiniteQuery(options);
    const second = await client.fetchInfiniteQuery(options);

    expect(first.pages.flatMap((page) => page.conversations.map((conversation) => conversation.title)))
      .toEqual(["First", "Second"]);
    expect(second.pages).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("offset=");
    expect(String(fetchMock.mock.calls[1][0])).toContain("offset=1");

    await client.fetchInfiniteQuery(queryOptions.codingProjectConversations("another-project"));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("/another-project/conversations");
  });

  it("rejects JSON error responses for resource-backed routes", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json(
      { error: "Service unavailable" },
      { status: 500 },
    ))));
    const client = new QueryClient({ defaultOptions: queryClientDefaultOptions });

    await expect(client.fetchQuery(queryOptions.musicPlaylists())).rejects.toThrow("Service unavailable");
    await expect(client.fetchQuery(queryOptions.musicFriendListens())).rejects.toThrow("Service unavailable");
    await expect(client.fetchQuery(queryOptions.musicPlaylist("playlist-a"))).rejects.toThrow("Service unavailable");
    await expect(client.fetchQuery(queryOptions.discordServers())).rejects.toThrow("Service unavailable");
    await expect(client.fetchInfiniteQuery(queryOptions.codingProjectSessions("project-a")))
      .rejects.toThrow("Service unavailable");
    await expect(client.fetchInfiniteQuery(queryOptions.codingProjectConversations("project-a")))
      .rejects.toThrow("Service unavailable");
  });

  it("distinguishes a missing WakaTime project from a failed request", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      return Promise.resolve(url.pathname.includes("missing-project")
        ? Response.json({ error: "Project not found" }, { status: 404 })
        : Response.json({ error: "Service unavailable" }, { status: 500 }));
    }));
    const client = new QueryClient({ defaultOptions: queryClientDefaultOptions });

    await expect(client.fetchQuery(queryOptions.codingProject("missing-project")))
      .resolves.toBeNull();
    await expect(client.fetchQuery(queryOptions.codingProject("failed-project")))
      .rejects.toThrow("Service unavailable");
  });
});
