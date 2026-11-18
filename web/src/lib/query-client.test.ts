import { QueryClient, dehydrate, hydrate } from "@tanstack/solid-query";
import { describe, expect, it } from "vitest";
import {
  QUERY_GC_TIME_MS,
  queryClientDefaultOptions,
  shouldDehydrateTimelineQuery,
} from "./query-client";

describe("query client retention", () => {
  it("hydrates persisted queries with finite retention", () => {
    const persistedClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    persistedClient.setQueryData(["syncSources"], { sources: [] });

    const restoredClient = new QueryClient({
      defaultOptions: queryClientDefaultOptions,
    });

    hydrate(restoredClient, dehydrate(persistedClient));

    const restoredQuery = restoredClient
      .getQueryCache()
      .find({ queryKey: ["syncSources"] });
    expect(restoredQuery?.gcTime).toBe(QUERY_GC_TIME_MS);
    expect(restoredQuery?.gcTime).not.toBe(Infinity);
  });

  it("persists only bounded app-wide query families", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["contacts"], { contacts: [] });
    queryClient.setQueryData(["syncSources"], { sources: [] });
    queryClient.setQueryData(["searchEvents", { q: "example" }], { pages: [] });
    queryClient.setQueryData(["contact", 42], { id: 42 });

    const dehydrated = dehydrate(queryClient, {
      shouldDehydrateQuery: shouldDehydrateTimelineQuery,
    });

    expect(dehydrated.queries.map((query) => query.queryKey)).toEqual([
      ["contacts"],
      ["syncSources"],
    ]);
  });


});
