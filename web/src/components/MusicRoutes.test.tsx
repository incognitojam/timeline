import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import MusicOverview from "./MusicOverview";
import MusicPlaylistView from "./MusicPlaylistView";

vi.mock("../lib/echarts-theme", () => ({
  useChartTheme: () => ({
    option: (option: unknown) => option,
    palette: () => ["#000000", "#111111"],
  }),
}));

function renderOverview(client: QueryClient) {
  const history = createMemoryHistory();
  history.set({ value: "/music", replace: true });
  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route path="/music" component={MusicOverview} />
      </MemoryRouter>
    </QueryClientProvider>
  ));
}

function renderPlaylist(client: QueryClient) {
  const history = createMemoryHistory();
  history.set({ value: "/music/playlist/playlist-a", replace: true });
  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route path="/music/playlist/:id" component={MusicPlaylistView} />
      </MemoryRouter>
    </QueryClientProvider>
  ));
}

describe("music route query cache", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reuses overview data when the route remounts", async () => {
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
          periodStart: new Date(0).toISOString(),
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
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });

    const firstVisit = renderOverview(client);
    expect(await firstVisit.findByText("No playlists tracked yet.")).toBeInTheDocument();
    expect(await firstVisit.findByText("No friend listens yet.")).toBeInTheDocument();
    cleanup();

    const revisit = renderOverview(client);
    expect(await revisit.findByText("No playlists tracked yet.")).toBeInTheDocument();
    expect(revisit.getByText("No friend listens yet.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("shows listening time alongside play counts for tracks and artists", async () => {
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
          periodStart: new Date(0).toISOString(),
          totalPlays: 12,
          listeningMs: 7_200_000,
          firstPlayedAt: "2026-01-01T00:00:00Z",
          lastPlayedAt: "2026-03-01T00:00:00Z",
          topTracks: [
            {
              rank: 1,
              trackName: "Example Track",
              artistName: "Example Artist",
              albumName: "Example Album",
              trackUri: null,
              imageUrl: null,
              playCount: 8,
              // 1h 5m
              listeningMs: 3_900_000,
              lastPlayedAt: "2026-03-01T00:00:00Z",
              eventId: 1,
            },
          ],
          topArtists: [
            {
              rank: 1,
              artistName: "Example Artist",
              playCount: 8,
              // 45m — no hour component, so the other formatDuration branch
              listeningMs: 2_700_000,
              lastPlayedAt: "2026-03-01T00:00:00Z",
              latestTrackName: "Example Track",
              latestTrackUri: null,
              imageUrl: null,
              eventId: 1,
            },
          ],
        }));
      }
      if (url.pathname === "/api/music/recent") {
        return Promise.resolve(Response.json({ recent: [] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });

    const screen = renderOverview(client);

    expect(await screen.findByText("Example Track")).toBeInTheDocument();
    expect(screen.getByText("1h 5m")).toBeInTheDocument();

    screen.getByRole("radio", { name: "Artists" }).click();

    expect(await screen.findByText("45m")).toBeInTheDocument();
  });

  it("reuses playlist detail when the route remounts", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({
      playlistId: "playlist-a",
      name: "Example Playlist",
      imageUrl: null,
      createdDate: null,
      observations: [],
    })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });

    const firstVisit = renderPlaylist(client);
    expect(await firstVisit.findByText("Example Playlist")).toBeInTheDocument();
    cleanup();

    const revisit = renderPlaylist(client);
    expect(await revisit.findByText("Example Playlist")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
