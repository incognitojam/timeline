import { QueryClient } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dateActivityQueryOptions,
} from "./dateActivityQueries";

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

describe("dateActivityQueries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the complete lightweight date index", async () => {
    const queryClient = createQueryClient();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          dates: [
            { date: "2026-07-08", eventCount: 12 },
            { date: "2016-04-15", eventCount: 3 },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await queryClient.fetchQuery(dateActivityQueryOptions());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/timeline/date-index");
    expect(response.dates).toEqual([
      { date: "2026-07-08", eventCount: 12 },
      { date: "2016-04-15", eventCount: 3 },
    ]);

  });

  it("retries a later request after a failed fetch", async () => {
    const queryClient = createQueryClient();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ dates: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      queryClient.fetchQuery(dateActivityQueryOptions()),
    ).rejects.toThrow("Failed to fetch date activity index");
    await expect(
      queryClient.fetchQuery(dateActivityQueryOptions()),
    ).resolves.toEqual({ dates: [] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
