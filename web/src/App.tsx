import { Route, type RoutePreloadFunc, Router } from "@solidjs/router";
import { type Component, Suspense } from "solid-js";
import AttachmentsView from "./components/AttachmentsView";
import ContactsView from "./components/ContactsView";
import ConversationsListView from "./components/ConversationsListView";
import ConversationView from "./components/ConversationView";
import DiscordServersView from "./components/DiscordServersView";
import DiscordServerView from "./components/DiscordServerView";
import EvalView from "./components/EvalView";
import EventRedirect from "./components/EventRedirect";
import HealthDashboard from "./components/HealthDashboard";
import Layout from "./components/Layout";
import McpSessionDetailView from "./components/McpSessionDetailView";
import McpSessionsView from "./components/McpSessionsView";
import MusicOverview from "./components/MusicOverview";
import MusicPlaylistView from "./components/MusicPlaylistView";
import SearchView from "./components/SearchView";
import SettingsView from "./components/SettingsView";
import SyncSourceDetailView from "./components/SyncSourceDetailView";
import SyncView from "./components/SyncView";
import TimelineView from "./components/TimelineView";
import WakaTimeOverview from "./components/WakaTimeOverview";
import WakaTimeProjectView from "./components/WakaTimeProjectView";
import { queryOptions } from "./lib/queries";
import { queryClient } from "./lib/query-client";
import { ATTACHMENTS_PAGE_SIZE, CONVERSATIONS_PAGE_SIZE, MCP_CALL_LIMIT, MCP_SESSION_LIMIT, SYNC_HISTORY_LIMIT, SYNC_SOURCE_HISTORY_LIMIT } from "./lib/query-params";
import { parseQuery } from "./lib/query-parser";
import { normalizeRouteParam, routePageOffset } from "./lib/route-params";
import { ROUTES, safeDecode } from "./lib/routes";
import { resolveTimelineDate } from "./lib/timelineDate";

function RouteFallback(props: { label: string }) {
  return (
    <div class="h-full flex items-center justify-center text-sm text-muted-foreground">
      Loading {props.label}...
    </div>
  );
}

function suspenseRoute(component: Component, label: string): Component {
  const Component = component;
  return function SuspenseRoute() {
    return (
      <Suspense fallback={<RouteFallback label={label} />}>
        <Component />
      </Suspense>
    );
  };
}

const preloadTimeline: RoutePreloadFunc = ({ location }) => {
  const date = resolveTimelineDate(location.query.date);
  return queryClient.prefetchQuery(queryOptions.dayEvents({ date }));
};

const preloadContacts: RoutePreloadFunc = ({ location }) => {
  const idParam = normalizeRouteParam(location.query.id);
  const contactId = idParam ? parseInt(idParam, 10) : undefined;
  const unlinked = normalizeRouteParam(location.query.unlinked);
  const source = normalizeRouteParam(location.query.source);
  const preloads: Promise<unknown>[] = [
    queryClient.prefetchQuery(queryOptions.contacts({ includeHidden: false })),
    queryClient.prefetchQuery(queryOptions.unlinkedIdentities()),
    queryClient.prefetchQuery(queryOptions.skippedIdentities()),
    queryClient.prefetchQuery(queryOptions.linkSuggestions()),
  ];
  if (contactId !== undefined && Number.isFinite(contactId)) {
    preloads.push(
      queryClient.prefetchQuery(queryOptions.contact(contactId)),
      queryClient.prefetchQuery(queryOptions.contactEvents(contactId, { limit: 20 })),
      queryClient.prefetchQuery(queryOptions.contactSuggestions(contactId)),
    );
  }
  if (unlinked && source) {
    preloads.push(
      queryClient.prefetchQuery(
        queryOptions.identityEvents({ identifier: unlinked, platform: source }, { limit: 20 }),
      ),
    );
  }
  return Promise.all(preloads);
};

const preloadConversations: RoutePreloadFunc = ({ location }) => {
  const params = {
    search: normalizeRouteParam(location.query.search) || undefined,
    source: normalizeRouteParam(location.query.source) || undefined,
    limit: CONVERSATIONS_PAGE_SIZE,
    offset: routePageOffset(location.query.page, CONVERSATIONS_PAGE_SIZE),
  };
  return Promise.all([
    queryClient.prefetchQuery(queryOptions.conversations(params)),
    queryClient.prefetchQuery(queryOptions.conversationSources()),
  ]);
};

const preloadSearch: RoutePreloadFunc = ({ location }) => {
  return queryClient.prefetchInfiniteQuery(
    queryOptions.searchEvents(parseQuery(normalizeRouteParam(location.query.q)), true),
  );
};

const preloadSync: RoutePreloadFunc = () => {
  return Promise.all([
    queryClient.prefetchQuery(queryOptions.serviceStatus()),
    queryClient.prefetchQuery(queryOptions.syncHistory({ limit: SYNC_HISTORY_LIMIT })),
    queryClient.prefetchQuery(queryOptions.inboxSources()),
  ]);
};

const preloadSettings: RoutePreloadFunc = () => {
  return Promise.all([
    queryClient.prefetchQuery(queryOptions.serviceStatus()),
    queryClient.prefetchQuery(queryOptions.networkSettings()),
  ]);
};

const preloadSyncSource: RoutePreloadFunc = ({ params }) => {
  const source = safeDecode(params.source ?? "");
  return Promise.all([
    queryClient.prefetchQuery(queryOptions.serviceStatus()),
    queryClient.prefetchQuery(queryOptions.syncSources()),
    queryClient.prefetchQuery(queryOptions.syncHistory({ source, limit: SYNC_SOURCE_HISTORY_LIMIT })),
  ]);
};

const preloadEval: RoutePreloadFunc = () => {
  return queryClient.prefetchQuery(queryOptions.evalCases());
};

const preloadAttachments: RoutePreloadFunc = () => {
  return Promise.all([
    queryClient.prefetchQuery(queryOptions.attachmentsStats()),
    queryClient.prefetchInfiniteQuery(queryOptions.attachments({ limit: ATTACHMENTS_PAGE_SIZE })),
  ]);
};

const preloadMcpSessions: RoutePreloadFunc = () => {
  return queryClient.prefetchQuery(queryOptions.mcpSessions({ limit: MCP_SESSION_LIMIT, offset: 0 }));
};

const preloadMcpSession: RoutePreloadFunc = ({ params }) => {
  const sessionId = params.id ? safeDecode(params.id) : undefined;
  return queryClient.prefetchQuery(queryOptions.mcpSession(sessionId, { limit: MCP_CALL_LIMIT, offset: 0 }));
};

export default function App() {
  return (
    <Router root={Layout}>
      <Route path="/" component={TimelineView} preload={preloadTimeline} />
      <Route path="/contacts" component={ContactsView} preload={preloadContacts} />
      <Route path="/conversations" component={suspenseRoute(ConversationsListView, "conversations")} preload={preloadConversations} />
      <Route path="/servers" component={suspenseRoute(DiscordServersView, "servers")} />
      <Route path="/server/:source/:id" component={suspenseRoute(DiscordServerView, "server")} />
      <Route path="/health" component={suspenseRoute(HealthDashboard, "health")} />
      <Route path="/coding" component={suspenseRoute(WakaTimeOverview, "coding")} />
      <Route path="/coding/project/:name" component={suspenseRoute(WakaTimeProjectView, "project")} />
      <Route path="/music" component={suspenseRoute(MusicOverview, "music")} />
      <Route path="/music/playlist/:id" component={suspenseRoute(MusicPlaylistView, "playlist")} />
      <Route path="/search" component={suspenseRoute(SearchView, "search")} preload={preloadSearch} />
      <Route path="/sync" component={suspenseRoute(SyncView, "sync")} preload={preloadSync} />
      <Route path={ROUTES.SETTINGS} component={suspenseRoute(SettingsView, "settings")} preload={preloadSettings} />
      <Route path="/sync/:source" component={suspenseRoute(SyncSourceDetailView, "sync source")} preload={preloadSyncSource} />
      <Route path="/attachments" component={suspenseRoute(AttachmentsView, "attachments")} preload={preloadAttachments} />
      <Route path="/eval" component={suspenseRoute(EvalView, "eval")} preload={preloadEval} />
      <Route path="/mcp-sessions" component={suspenseRoute(McpSessionsView, "MCP sessions")} preload={preloadMcpSessions} />
      <Route path="/mcp-sessions/:id" component={suspenseRoute(McpSessionDetailView, "MCP session")} preload={preloadMcpSession} />
      <Route path="/conversation/:source/:conversationId" component={suspenseRoute(ConversationView, "conversation")} />
      <Route path="/event/:id" component={suspenseRoute(EventRedirect, "event")} />
    </Router>
  );
}
