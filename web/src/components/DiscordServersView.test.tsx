import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { cleanup, render } from "@solidjs/testing-library";
import { Suspense } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import DiscordServersView from "./DiscordServersView";

function renderServers(client: QueryClient) {
  const history = createMemoryHistory();
  history.set({ value: "/servers", replace: true });

  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route
          path="/servers"
          component={() => (
            <Suspense fallback={<div>Route fallback</div>}>
              <DiscordServersView />
            </Suspense>
          )}
        />
      </MemoryRouter>
    </QueryClientProvider>
  ));
}

describe("DiscordServersView", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps its local loading state outside the route Suspense fallback", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const view = renderServers(client);

    expect(view.getByText("Discord Servers")).toBeInTheDocument();
    expect(view.queryByText("Route fallback")).not.toBeInTheDocument();
  });

  it("surfaces transport failures instead of caching an empty server list", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json(
      { error: "Discord unavailable" },
      { status: 500 },
    ))));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const view = renderServers(client);

    expect(await view.findByText("Failed to load Discord servers.")).toBeInTheDocument();
    expect(view.queryByText(/No Discord servers found/)).not.toBeInTheDocument();
  });

  it("reuses fresh cached data when the route remounts", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({
      servers: [{
        guildId: "server-1",
        name: "Example Server",
        iconUrl: null,
        channelCount: 2,
        messageCount: 3,
        firstMessage: null,
        lastMessage: null,
      }],
    })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });

    const firstVisit = renderServers(client);
    expect(await firstVisit.findByText("Example Server")).toBeInTheDocument();
    cleanup();

    const revisit = renderServers(client);
    expect(await revisit.findByText("Example Server")).toBeInTheDocument();
    expect(revisit.queryByText("Route fallback")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
