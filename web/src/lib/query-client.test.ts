import { QueryClient, dehydrate, hydrate } from "@tanstack/solid-query";
import { persistQueryClient, type PersistedClient, type Persister } from "@tanstack/query-persist-client-core";
import { describe, expect, it } from "vitest";
import {
  QUERY_GC_TIME_MS,
  mountAfterQueryClientRestore,
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

  it("mounts queries only after persisted data has restored", async () => {
    const sourceClient = new QueryClient();
    sourceClient.setQueryData(["contacts"], { contacts: ["Alice"] });
    const persistedClient: PersistedClient = {
      buster: "v2",
      clientState: dehydrate(sourceClient),
      timestamp: Date.now(),
    };

    let restore: ((value: PersistedClient | undefined) => void) | undefined;
    const persister: Persister = {
      persistClient: async () => {},
      restoreClient: () =>
        new Promise((resolve) => {
          restore = resolve;
        }),
      removeClient: async () => {},
    };
    const queryClient = new QueryClient();
    const [unsubscribe, restoration] = persistQueryClient({
      queryClient,
      persister,
      buster: "v2",
    });
    let observedContacts: unknown;
    let fetches = 0;

    const mounted = mountAfterQueryClientRestore(restoration, () => {
      void queryClient.fetchQuery({
        queryKey: ["preload"],
        // biome-ignore lint/plugin/require-query-signal: this cache-ordering test performs no cancellable work.
        queryFn: () => {
          fetches += 1;
          observedContacts = queryClient.getQueryData(["contacts"]);
          return "loaded";
        },
      });
    });

    expect(fetches).toBe(0);
    expect(observedContacts).toBeUndefined();
    if (!restore) throw new Error("Persister did not start restoration");
    restore(persistedClient);
    await mounted;
    await queryClient.getQueryCache().find({ queryKey: ["preload"] })?.promise;

    expect(fetches).toBe(1);
    expect(observedContacts).toEqual({ contacts: ["Alice"] });
    unsubscribe();
  });
});
