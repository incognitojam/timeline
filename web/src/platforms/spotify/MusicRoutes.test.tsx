import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import MusicExclusionsView from "./MusicExclusionsView";
import MusicOverview from "./MusicOverview";
import MusicPlaylistView from "./MusicPlaylistView";

vi.mock("../../lib/echarts-theme", () => ({
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

const EXAMPLE_PLAYLIST = {
  playlistUri: "spotify:playlist:example-mix", name: "Example Mix", plays: 3, lastPlayedAt: "2026-03-01T00:00:00Z",
};

/**
 * A stateful stand-in for the music API: one ranked track, one played playlist,
 * and exclusions that writes change.
 */
function musicExclusionsApi(initial: { id: number; kind: string; label: string }[] = []) {
  let exclusions = initial;
  let excludePrivateSessions = false;
  const writes: string[] = [];
  const filter = () => ({ exclusions, excludePrivateSessions });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://example.com");
    if (init?.method) {
      writes.push(`${init.method} ${url.pathname} ${init.body ?? ""}`.trim());
      if (init.method === "DELETE") exclusions = exclusions.filter((e) => `/api/music/exclusions/${e.id}` !== url.pathname);
      if (init.method === "PUT") excludePrivateSessions = JSON.parse(String(init.body)).excluded;
      if (init.method === "POST") {
        const exclusion = JSON.parse(String(init.body)).kind === "playlist"
          ? { id: 9, kind: "playlist", label: EXAMPLE_PLAYLIST.name }
          : { id: 8, kind: "track", label: "Example Track · Example Artist" };
        exclusions = [...exclusions, exclusion];
        return Response.json({ exclusion }, { status: 201 });
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/music/exclusions") {
      // The server leaves excluded playlists out of the played list.
      const playedPlaylists = exclusions.some((e) => e.kind === "playlist") ? [] : [EXAMPLE_PLAYLIST];
      return Response.json({ ...filter(), playedPlaylists });
    }
    if (url.pathname === "/api/music/rankings") {
      return Response.json({
        period: url.searchParams.get("period"),
        periodStart: null,
        totalPlays: 12,
        listeningMs: 0,
        firstPlayedAt: null,
        lastPlayedAt: null,
        // The excluded track leaves the list, as the server's filter would make it.
        topTracks: exclusions.some((e) => e.kind === "track") ? [] : [{
          rank: 1, trackName: "Example Track", artistName: "Example Artist", albumName: null, trackUri: "spotify:track:example",
          imageUrl: null, playCount: 8, listeningMs: 0, lastPlayedAt: "2026-03-01T00:00:00Z", eventId: 42,
        }],
        topArtists: [],
        filter: filter(),
      });
    }
    return Response.json({
      playlists: [],
      friends: [],
      recent: [{
        eventId: 42, timestamp: "2026-03-01T00:00:00Z", trackName: "Example Track", artistName: "Example Artist",
        albumName: null, trackUri: "spotify:track:example", imageUrl: null, playlistUri: null, playlistName: null,
      }],
    });
  });
  return { fetch, writes };
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
          filter: { exclusions: [], excludePrivateSessions: false },
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
          filter: { exclusions: [], excludePrivateSessions: false },
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

  it("excludes a row from the top lists and links to the exclusions page", async () => {
    const fetchMock = musicExclusionsApi();
    vi.stubGlobal("fetch", fetchMock.fetch);
    const screen = renderOverview(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    const quietLink = await screen.findByRole("link", { name: "Exclusions" });
    expect(quietLink).toHaveAttribute("href", "/music/excluded");

    // The ranked row and the recent play are the same track; exclude from the recent play,
    // which stays on screen once the ranked row has left the list.
    const [, recentRowButton] = screen.getAllByRole("button", { name: "Exclude from top lists" });
    recentRowButton.click();
    expect(screen.getByText("No playlist recorded for this play.")).toBeInTheDocument();
    screen.getByRole("button", { name: "Track “Example Track”" }).click();
    expect(await screen.findByRole("status")).toHaveTextContent("Track “Example Track” left out of top lists.");
    expect(screen.getByRole("link", { name: "View exclusions" })).toHaveAttribute("href", "/music/excluded");
    expect(screen.getByRole("link", { name: /Filtered · 1 excluded/ })).toHaveAttribute("href", "/music/excluded");
    expect(screen.getByText("Every track in this range is excluded.")).toBeInTheDocument();
    expect(fetchMock.writes).toEqual(['POST /api/music/exclusions {"kind":"track","eventId":42}']);
  });

  it("includes an exclusion again and toggles private sessions, and Music shows both on return", async () => {
    const fetchMock = musicExclusionsApi([{ id: 7, kind: "track", label: "Example Track · Example Artist" }]);
    vi.stubGlobal("fetch", fetchMock.fetch);
    const history = createMemoryHistory();
    history.set({ value: "/music", replace: true });
    // Cached rankings stay fresh for a minute, so only invalidation can update them on return.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    const screen = render(() => (
      <QueryClientProvider client={client}>
        <MemoryRouter history={history}>
          <Route path="/music" component={MusicOverview} />
          <Route path="/music/excluded" component={MusicExclusionsView} />
        </MemoryRouter>
      </QueryClientProvider>
    ));

    expect(await screen.findByText("Every track in this range is excluded.")).toBeInTheDocument();
    screen.getByRole("link", { name: /Filtered · 1 excluded/ }).click();

    expect(await screen.findByText("Example Track · Example Artist")).toBeInTheDocument();
    screen.getByRole("button", { name: "Include again" }).click();
    expect(await screen.findByText(/No tracks, albums, artists or playlists excluded/)).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: /Leave private-session plays out of top lists/ });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    toggle.click();
    await vi.waitFor(() => {
      expect(toggle).not.toBeDisabled();
      expect(toggle).toHaveAttribute("aria-checked", "true");
    });

    screen.getByRole("link", { name: "← Music" }).click();
    expect(await screen.findByRole("link", { name: "Filtered · no private sessions" })).toBeInTheDocument();
    expect(screen.getAllByText("Example Track").length).toBeGreaterThan(0);
    expect(screen.queryByText("Every track in this range is excluded.")).toBeNull();
    expect(fetchMock.writes).toEqual([
      "DELETE /api/music/exclusions/7",
      'PUT /api/music/exclusions/private-sessions {"excluded":true}',
    ]);
  });

  it("excludes a played playlist and lists it as excluded until included again", async () => {
    const fetchMock = musicExclusionsApi();
    vi.stubGlobal("fetch", fetchMock.fetch);
    const history = createMemoryHistory();
    history.set({ value: "/music/excluded", replace: true });
    const screen = render(() => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter history={history}>
          <Route path="/music/excluded" component={MusicExclusionsView} />
        </MemoryRouter>
      </QueryClientProvider>
    ));

    const played = await screen.findByRole("region", { name: "Playlists you've played from" });
    expect(played).toHaveTextContent("Example Mix3 plays · last played");
    expect(played).toHaveTextContent("Only playlists the live sync saw you play from are listed.");
    screen.getByRole("button", { name: "Exclude Example Mix" }).click();

    await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Example Mix left out of top lists."));
    expect(played).toHaveTextContent("Every playlist you've played from is excluded.");
    const excluded = screen.getByRole("region", { name: /^Excluded/ });
    expect(excluded).toHaveTextContent("PlaylistExample Mix");

    screen.getByRole("button", { name: "Include again" }).click();
    expect(await screen.findByRole("button", { name: "Exclude Example Mix" })).toBeInTheDocument();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(fetchMock.writes).toEqual([
      `POST /api/music/exclusions {"kind":"playlist","playlistUri":"${EXAMPLE_PLAYLIST.playlistUri}"}`,
      "DELETE /api/music/exclusions/9",
    ]);
  });

  it("says so when excluding a played playlist fails", async () => {
    const api = musicExclusionsApi();
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => init?.method === "POST"
      ? Promise.resolve(Response.json({ error: "Database is locked" }, { status: 500 }))
      : api.fetch(input, init)));
    const history = createMemoryHistory();
    history.set({ value: "/music/excluded", replace: true });
    const screen = render(() => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter history={history}>
          <Route path="/music/excluded" component={MusicExclusionsView} />
        </MemoryRouter>
      </QueryClientProvider>
    ));

    (await screen.findByRole("button", { name: "Exclude Example Mix" })).click();
    await vi.waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Could not exclude that playlist. Try again.");
    });
    expect(screen.getByRole("button", { name: "Exclude Example Mix" })).not.toBeDisabled();
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
