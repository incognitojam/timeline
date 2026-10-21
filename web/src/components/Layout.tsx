import { useLocation } from "@solidjs/router";
import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, type ParentProps, Show } from "solid-js";
import { type AuthStatus, fetchAuthStatus, fetchStats, login, logout } from "../lib/api";
import { queryKeys } from "../lib/queries";
import { createFetchingCount } from "../lib/query-client";
import { APP_NAME, navigationItemForPath, ROUTES, safeDecode } from "../lib/routes";
import { resolveTimelineDate } from "../lib/timelineDate";
import Navigation from "./Navigation";

const FETCH_BAR_EXCLUDED_QUERY_ROOTS = new Set<unknown>([
  queryKeys.serviceStatus()[0],
  queryKeys.syncHistoryRoot()[0],
]);

function routeDocumentTitle(pathname: string, timelineDateLabel?: string | null): string {
  const projectMatch = pathname.match(/^\/coding\/project\/([^/]+)/);
  if (projectMatch) {
    return `${safeDecode(projectMatch[1])} · Coding · ${APP_NAME}`;
  }

  const conversationMatch = pathname.match(/^\/conversation\/([^/]+)/);
  if (conversationMatch) {
    return `${safeDecode(conversationMatch[1])} · ${APP_NAME}`;
  }

  const eventMatch = pathname.match(/^\/event\/(\d+)/);
  if (eventMatch) {
    return `Event #${eventMatch[1]} · ${APP_NAME}`;
  }

  if (pathname === ROUTES.SERVERS) {
    return `Servers · ${APP_NAME}`;
  }
  if (pathname.startsWith("/mcp-sessions/")) {
    return `MCP session · ${APP_NAME}`;
  }
  if (pathname.startsWith("/server/")) {
    return `Server · ${APP_NAME}`;
  }

  if (pathname === ROUTES.TIMELINE && timelineDateLabel) {
    return `${timelineDateLabel} · ${APP_NAME}`;
  }

  const navItem = navigationItemForPath(pathname);
  if (navItem) {
    return `${navItem.documentTitle ?? navItem.label} · ${APP_NAME}`;
  }

  return APP_NAME;
}

export default function Layout(props: ParentProps) {
  const location = useLocation();
  const activeFetches = createFetchingCount({
    predicate: (query) => !FETCH_BAR_EXCLUDED_QUERY_ROOTS.has(query.queryKey[0]),
  });

  const timelineDate = createMemo(() =>
    resolveTimelineDate(new URLSearchParams(location.search).get("date")),
  );

  const timelineDateLabel = createMemo(() =>
    new Date(`${timelineDate()}T00:00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
  );

  createEffect(() => {
    document.title = routeDocumentTitle(location.pathname, timelineDateLabel());
  });

  // Auth state
  const [authStatus, setAuthStatus] = createSignal<AuthStatus | null>(null);
  const [authLoading, setAuthLoading] = createSignal(true);
  const [authUnavailable, setAuthUnavailable] = createSignal(false);
  const [loginError, setLoginError] = createSignal<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = createSignal(false);
  let passwordInputRef: HTMLInputElement | undefined;

  const checkAuthStatus = async () => {
    setAuthLoading(true);
    setAuthUnavailable(false);
    try {
      const status = await fetchAuthStatus();
      setAuthStatus(status);
    } catch {
      setAuthStatus(null);
      setAuthUnavailable(true);
    } finally {
      setAuthLoading(false);
    }
  };

  // Check auth status on mount
  onMount(() => {
    void checkAuthStatus();
  });

  // Listen for 401 responses (auth:required event from apiFetch)
  onMount(() => {
    const handleAuthRequired = () => {
      setAuthUnavailable(false);
      setAuthStatus({ authenticated: false, authEnabled: true });
      setAuthLoading(false);
    };
    window.addEventListener("auth:required", handleAuthRequired);
    onCleanup(() => window.removeEventListener("auth:required", handleAuthRequired));
  });

  // Login handler
  const handleLogin = async (e: Event) => {
    e.preventDefault();
    const password = passwordInputRef?.value || "";

    setIsLoggingIn(true);
    setLoginError(null);

    try {
      const result = await login(password);
      if (result.success) {
        setAuthStatus({ authenticated: true, authEnabled: true });
      } else {
        setLoginError(result.error || "Login failed");
      }
    } catch {
      setAuthStatus(null);
      setAuthUnavailable(true);
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Logout handler
  const handleLogout = async () => {
    await logout();
    setAuthStatus({ authenticated: false, authEnabled: true });
  };

  // Only fetch stats when authenticated (or auth disabled)
  const isAuthenticated = () => {
    const status = authStatus();
    if (!status) return false;
    return !status.authEnabled || status.authenticated;
  };
  const [stats] = createResource(isAuthenticated, (authed) => authed ? fetchStats() : null);

  const availableSources = createMemo(() => {
    const s = stats();
    if (!s?.sources) return [];
    const sources = new Set<string>();
    for (const item of s.sources) {
      sources.add(item.source);
    }
    return Array.from(sources).sort();
  });

  const statsSummary = createMemo(() => {
    const currentStats = stats();
    if (!currentStats) return "Loading…";
    const eventLabel = currentStats.total_events === 1 ? "event" : "events";
    const sourceCount = availableSources().length;
    const sourceLabel = sourceCount === 1 ? "source" : "sources";
    return `${currentStats.total_events.toLocaleString()} ${eventLabel} · ${sourceCount} ${sourceLabel}`;
  });

  const showLoading = () => authLoading();
  const showUnavailable = () => !authLoading() && authUnavailable();
  const showLogin = () =>
    !authLoading() &&
    !authUnavailable() &&
    authStatus()?.authEnabled &&
    !authStatus()?.authenticated;
  const showApp = () => {
    const status = authStatus();
    return !authLoading() && status !== null && (!status.authEnabled || status.authenticated);
  };

  return (
    <>
      {/* Loading state */}
      <Show when={showLoading()}>
        <div class="min-h-dvh flex items-center justify-center bg-background">
          <div class="text-muted-foreground">Loading...</div>
        </div>
      </Show>

      {/* API unavailable state */}
      <Show when={showUnavailable()}>
        <div class="min-h-dvh flex items-center justify-center bg-background">
          <div class="w-full max-w-sm p-6 space-y-6 text-center">
            <div>
              <h1 class="font-display text-2xl font-medium text-foreground">Timeline</h1>
              <p class="text-sm font-medium text-foreground mt-4">Service unavailable</p>
              <p class="text-sm text-muted-foreground mt-2">
                The app could not reach the Timeline API.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void checkAuthStatus()}
              class="w-full rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
            >
              Retry
            </button>
          </div>
        </div>
      </Show>

      {/* Login form */}
      <Show when={showLogin()}>
        <div class="min-h-dvh flex items-center justify-center bg-background">
          <div class="w-full max-w-sm p-6 space-y-6">
            <div class="text-center">
              <h1 class="font-display text-2xl font-medium text-foreground">Timeline</h1>
              <p class="text-sm text-muted-foreground mt-2">Enter password to continue</p>
            </div>

            <form onSubmit={handleLogin} class="space-y-4">
              <div>
                <input
                  ref={passwordInputRef}
                  type="password"
                  placeholder="Password"
                  autocomplete="current-password"
                  class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  disabled={isLoggingIn()}
                />
              </div>

              <Show when={loginError()}>
                <p class="text-sm text-red-500">{loginError()}</p>
              </Show>

              <button
                type="submit"
                disabled={isLoggingIn()}
                class="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
              >
                {isLoggingIn() ? "Logging in..." : "Login"}
              </button>
            </form>
          </div>
        </div>
      </Show>

      {/* Main app */}
      <Show when={showApp()}>
        <div class="flex h-dvh min-h-0 flex-col bg-background text-foreground min-[600px]:flex-row">
          <a
            href="#main-content"
            class="skip-link fixed left-3 top-3 z-[60] -translate-y-24 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg transition-transform focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
          >
            Skip to content
          </a>

          <Show when={activeFetches() > 0}>
            <div class="fixed top-0 left-0 right-0 h-0.5 bg-primary/20 overflow-hidden z-50">
              <div class="h-full w-1/3 bg-primary/80 animate-slide" />
            </div>
          </Show>

          <Navigation
            statsSummary={statsSummary()}
            authEnabled={Boolean(authStatus()?.authEnabled)}
            onLogout={handleLogout}
          />

          <main
            id="main-content"
            tabindex="-1"
            class="min-h-0 min-w-0 flex-1 overflow-hidden focus:outline-none"
          >
            {props.children}
          </main>
        </div>
      </Show>
    </>
  );
}
