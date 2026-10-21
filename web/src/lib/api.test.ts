import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportConversationRange,
  fetchAttachments,
  fetchContacts,
  fetchConversationSources,
  fetchConversations,
  fetchDayEvents,
  fetchSearch,
  SyncSourceConfigurationError,
  updateSyncSourceConfiguration,
} from "./api";
import { INVALID_CONTACT_FILTER_MESSAGE } from "./query-parser";

const TEST_SIGNAL = new AbortController().signal;

describe("fetchAttachments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { excludeSources: ["recall", "discord"], query: "exclude_sources=recall%2Cdiscord" },
    { excludeSources: [], query: "exclude_sources=" },
  ])("forwards source exclusions as $query", async ({ excludeSources, query }) => {
    const fetchMock = vi.fn(async () => Response.json({ attachments: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchAttachments({ excludeSources, signal: TEST_SIGNAL });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/attachments?${query}`,
      expect.objectContaining({ signal: TEST_SIGNAL }),
    );
  });
});

function exportResponse() {
  return {
    text: "Alice: hello",
    eventCount: 1,
    tokenCount: 3,
    range: {
      startEventId: 1,
      endEventId: 1,
      requestedStartEventId: 1,
      requestedEndEventId: 1,
      source: "discord",
      sourceAccount: null,
      conversationId: "channel-1",
      title: "Project chat",
      startTimestamp: "2026-01-01T00:00:00Z",
      endTimestamp: "2026-01-01T00:00:00Z",
    },
  };
}

describe("exportConversationRange", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds the browser time zone to export requests", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify(exportResponse()), { status: 200 })
    ));
    vi.stubGlobal("fetch", fetchMock);

    await exportConversationRange(
      {
        startEventId: 1,
        endEventId: 2,
        format: { timestampStyle: "date-headers", includeReactions: true, compactAuthors: true },
      },
      TEST_SIGNAL,
    );

    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("expected fetch to be called");
    const init = firstCall[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as {
      format?: {
        timeZone?: string;
      };
    };

    expect(body.format?.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe("fetchDayEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws the server error message for day lookup failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => (
      new Response(JSON.stringify({ error: "Could not determine date from provided parameters" }), {
        status: 400,
      })
    )));

    await expect(fetchDayEvents({ eventId: 999_999, signal: TEST_SIGNAL })).rejects.toThrow(
      "Could not determine date from provided parameters",
    );
  });
});

describe("fetchContacts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects HTTP failures with the server error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => (
      new Response(JSON.stringify({ error: "Could not load contacts" }), {
        status: 500,
      })
    )));

    await expect(fetchContacts({ signal: TEST_SIGNAL })).rejects.toThrow("Could not load contacts");
  });
});

describe("conversation lists", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects HTTP failures from list and source requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const error = path.endsWith("/sources")
        ? "Could not load conversation sources"
        : "Could not load conversations";
      return Response.json({ error }, { status: 500 });
    }));

    await expect(fetchConversations({ signal: TEST_SIGNAL })).rejects.toThrow("Could not load conversations");
    await expect(fetchConversationSources(TEST_SIGNAL)).rejects.toThrow("Could not load conversation sources");
  });
});

describe("updateSyncSourceConfiguration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends one combined configuration patch", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify({ name: "backup" }))
    ));
    vi.stubGlobal("fetch", fetchMock);

    await updateSyncSourceConfiguration("backup", {
      enabled: false,
      interval: "45m",
      settings: { destination: "/srv/backups", keep_count: 12 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error("expected fetch to be called");
    expect(firstCall[0]).toBe("/api/sync/sources/backup");
    expect(firstCall[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({
        enabled: false,
        interval: "45m",
        settings: { destination: "/srv/backups", keep_count: 12 },
      }),
    });
  });

  it("serializes configuration patches for the same source", async () => {
    const responders: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => {
      responders.push(resolve);
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = updateSyncSourceConfiguration("backup", {
      settings: { destination: "/srv/first" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = updateSyncSourceConfiguration("backup", {
      settings: { destination: "/srv/second" },
    });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const resolveFirst = responders[0];
    if (!resolveFirst) throw new Error("expected the first request");
    resolveFirst(Response.json({ name: "backup" }));
    await first;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const resolveSecond = responders[1];
    if (!resolveSecond) throw new Error("expected the second request");
    resolveSecond(Response.json({ name: "backup" }));
    await second;

    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { settings: { destination: "/srv/first" } },
      { settings: { destination: "/srv/second" } },
    ]);
  });

  it("preserves a structured validation field on errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "settings.keep_count must be at least 1",
      field: "settings.keep_count",
    }), { status: 400 })));

    const request = updateSyncSourceConfiguration("backup", {
      settings: { keep_count: 0 },
    });

    await expect(request).rejects.toMatchObject({
      name: "SyncSourceConfigurationError",
      message: "settings.keep_count must be at least 1",
      field: "settings.keep_count",
    } satisfies Partial<SyncSourceConfigurationError>);
  });
});

describe("fetchSearch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["Alice Example", "48junk", "0", ""])(
    "rejects invalid contact filter %s before making a request",
    async (contact) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(fetchSearch({ contact }, undefined, { signal: TEST_SIGNAL })).rejects.toThrow(
        INVALID_CONTACT_FILTER_MESSAGE,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("forwards text search to the contact events endpoint", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        events: [],
        count: 0,
        nextCursor: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchSearch(
      { contact: "42", text: "contactsearchneedle" },
      undefined,
      { signal: TEST_SIGNAL },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("/api/contacts/42/events?");
    expect(new URL(requestUrl, "http://localhost").searchParams.get("q")).toBe(
      "contactsearchneedle",
    );
  });
});
