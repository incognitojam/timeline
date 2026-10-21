import { QueryClient, type QueryFilters, useQueryClient } from "@tanstack/solid-query";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { type Accessor, createSignal, onCleanup } from "solid-js";

export const QUERY_GC_TIME_MS = 8 * 60 * 60_000;
export const PERSISTED_QUERY_MAX_AGE_MS = 12 * 60 * 60_000;

const PERSISTED_QUERY_ROOTS = new Set([
  "contacts",
  "conversationSources",
  "serviceStatus",
  "syncSources",
  "inboxSources",
]);

export function shouldDehydrateTimelineQuery(query: {
  queryKey: readonly unknown[];
  state: { status: string };
}) {
  return (
    query.state.status === "success" &&
    typeof query.queryKey[0] === "string" &&
    PERSISTED_QUERY_ROOTS.has(query.queryKey[0])
  );
}

export const queryClientDefaultOptions = {
  queries: {
    staleTime: 30_000, // 30s before considered stale
    gcTime: QUERY_GC_TIME_MS,
    refetchOnWindowFocus: false, // User controls refetch via Refresh button
  },
  hydrate: {
    // Hydration constructs queries before their family-specific options run.
    // Supply the finite default here so restored entries cannot retain old Infinity.
    queries: { gcTime: QUERY_GC_TIME_MS },
  },
};

export const queryClient = new QueryClient({
  defaultOptions: queryClientDefaultOptions,
});

/**
 * Count of in-flight queries matching `filters`, kept live by a query-cache
 * subscription.
 *
 * Stands in for `useIsFetching`, which resolves its client through
 * `createMemo(() => useQueryClient())`. A memo created inside a router
 * transition keeps its value in `tValue` until the transition finishes, but the
 * cache subscription fires earlier — while Solid disposes the outgoing route's
 * query observers — so the memo reads back `undefined` and the callback throws
 * `Cannot read properties of undefined (reading 'isFetching')`. That aborted
 * the router's update mid-swap, leaving the previous page mounted under the new
 * URL. Reading the client once, outside a memo, keeps the callback safe.
 */
export function createFetchingCount(filters: QueryFilters): Accessor<number> {
  const client = useQueryClient();
  const read = () => client.isFetching(filters);
  const [count, setCount] = createSignal(read());
  onCleanup(client.getQueryCache().subscribe(() => setCount(read())));
  return count;
}

export function mountAfterQueryClientRestore(
  restoration: Promise<void>,
  mount: () => void,
): Promise<void> {
  return restoration.then(mount, mount);
}

function persistQueryClientToLocalStorage() {
  const persister = createSyncStoragePersister({
    storage: window.localStorage,
    key: "timeline-query-cache",
  });

  return persistQueryClient({
    queryClient,
    persister,
    maxAge: PERSISTED_QUERY_MAX_AGE_MS,
    buster: "v2", // Bump when cache semantics or response shapes change
    dehydrateOptions: {
      shouldDehydrateQuery: shouldDehydrateTimelineQuery,
    },
  });
}

// Persist cache to localStorage (only in browser).
export const [unsubscribeQueryClientPersistence, queryClientRestoration] =
  typeof window !== "undefined"
    ? persistQueryClientToLocalStorage()
    : [() => {}, Promise.resolve()];
