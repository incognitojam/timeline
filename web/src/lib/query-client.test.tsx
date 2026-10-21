import { A, MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { render, waitFor } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider, createQuery } from "@tanstack/solid-query";
import { Suspense } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchingCount } from "./query-client";

/**
 * Reproduces the stuck route swap: leaving a Suspense-wrapped route destroys its
 * query observer, which notifies the cache while the router transition is still
 * tearing down. A fetching-count subscriber created during that transition runs
 * inside that notification, so it must not read the client through a memo.
 */
function LeavingRoute() {
  const query = createQuery(() => ({
    queryKey: ["leaving"],
    // biome-ignore lint/plugin/require-query-signal: this lifecycle test performs no cancellable work.
    queryFn: () => Promise.resolve("left"),
  }));
  return (
    <div>
      <p>leaving: {query.data}</p>
      <A href="/arriving">go</A>
    </div>
  );
}

function ArrivingRoute() {
  const fetching = createFetchingCount({ queryKey: ["arriving"] });
  return <p>arriving: {fetching()}</p>;
}

describe("createFetchingCount", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lets the router finish a route swap away from a suspended route", async () => {
    const history = createMemoryHistory();
    history.set({ value: "/leaving", replace: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { getByText, findByText } = render(() => (
      <QueryClientProvider client={client}>
        <MemoryRouter history={history}>
          <Route
            path="/leaving"
            component={() => (
              <Suspense fallback={<p>loading route</p>}>
                <LeavingRoute />
              </Suspense>
            )}
          />
          <Route path="/arriving" component={ArrivingRoute} />
        </MemoryRouter>
      </QueryClientProvider>
    ));

    await findByText("leaving: left");
    getByText("go").click();

    await waitFor(() => {
      expect(history.get()).toBe("/arriving");
      expect(getByText("arriving: 0")).toBeInTheDocument();
    });
  });
});
