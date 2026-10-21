import type { HealthWindowSelection } from "@shared/health-periods";

export const ROUTES = {
  TIMELINE: "/",
  CONTACTS: "/contacts",
  HEALTH: "/health",
  CODING: "/coding",
  CODING_PROJECT: "/coding/project/:name",
  MUSIC: "/music",
  MUSIC_PLAYLIST: "/music/playlist/:id",
  SEARCH: "/search",
  SYNC: "/sync",
  SETTINGS: "/settings",
  ATTACHMENTS: "/attachments",
  MCP: "/mcp-sessions",
  EVAL: "/eval",
  MCP_SESSION: "/mcp-sessions/:id",
  CONVERSATIONS: "/conversations",
  CONVERSATION: "/conversation/:source/:conversationId",
  SERVERS: "/servers",
  SERVER: "/server/:source/:id",
  EVENT: "/event/:id",
} as const;

export type NavigationIcon =
  | "timeline"
  | "people"
  | "conversations"
  | "search"
  | "health"
  | "coding"
  | "music"
  | "sync"
  | "settings"
  | "attachments"
  | "mcp"
  | "eval";

export type NavigationSection = "primary" | "utility";

export interface NavigationItem {
  path: string;
  label: string;
  documentTitle?: string;
  icon: NavigationIcon;
  section: NavigationSection;
  mobile: boolean;
  activePaths: readonly string[];
}

/** Product name, shared by the document-title composers. */
export const APP_NAME = "Timeline";

function routePrefix(route: string): string {
  return route.split("/:")[0];
}

/**
 * The app's route hierarchy, shared by adaptive navigation and document titles.
 * Detail routes live under the destination a person would use to find them.
 */
export const NAV_ITEMS = [
  {
    path: ROUTES.TIMELINE,
    label: "Timeline",
    icon: "timeline",
    section: "primary",
    mobile: true,
    activePaths: [ROUTES.TIMELINE, routePrefix(ROUTES.EVENT)],
  },
  {
    path: ROUTES.CONTACTS,
    label: "People",
    documentTitle: "Contacts",
    icon: "people",
    section: "primary",
    mobile: true,
    activePaths: [ROUTES.CONTACTS],
  },
  {
    path: ROUTES.CONVERSATIONS,
    label: "Messages",
    documentTitle: "Conversations",
    icon: "conversations",
    section: "primary",
    mobile: true,
    activePaths: [
      ROUTES.CONVERSATIONS,
      routePrefix(ROUTES.CONVERSATION),
      ROUTES.SERVERS,
      routePrefix(ROUTES.SERVER),
    ],
  },
  {
    path: ROUTES.HEALTH,
    label: "Health",
    icon: "health",
    section: "primary",
    mobile: true,
    activePaths: [ROUTES.HEALTH],
  },
  {
    path: ROUTES.CODING,
    label: "Coding",
    icon: "coding",
    section: "primary",
    mobile: false,
    activePaths: [ROUTES.CODING],
  },
  {
    path: ROUTES.MUSIC,
    label: "Music",
    icon: "music",
    section: "primary",
    mobile: false,
    activePaths: [ROUTES.MUSIC],
  },
  {
    path: ROUTES.SEARCH,
    label: "Search",
    icon: "search",
    section: "utility",
    mobile: false,
    activePaths: [ROUTES.SEARCH],
  },
  {
    path: ROUTES.SYNC,
    label: "Sync",
    icon: "sync",
    section: "utility",
    mobile: false,
    activePaths: [ROUTES.SYNC],
  },
  {
    path: ROUTES.SETTINGS,
    label: "Settings",
    icon: "settings",
    section: "utility",
    mobile: false,
    activePaths: [ROUTES.SETTINGS],
  },
  {
    path: ROUTES.ATTACHMENTS,
    label: "Attachments",
    icon: "attachments",
    section: "utility",
    mobile: false,
    activePaths: [ROUTES.ATTACHMENTS],
  },
  {
    path: ROUTES.MCP,
    label: "MCP sessions",
    documentTitle: "MCP",
    icon: "mcp",
    section: "utility",
    mobile: false,
    activePaths: [ROUTES.MCP],
  },
  {
    path: ROUTES.EVAL,
    label: "Evaluations",
    documentTitle: "Eval",
    icon: "eval",
    section: "utility",
    mobile: false,
    activePaths: [ROUTES.EVAL],
  },
] as const satisfies readonly NavigationItem[];

export const PRIMARY_NAV_ITEMS = NAV_ITEMS.filter((item) => item.section === "primary");
export const UTILITY_NAV_ITEMS = NAV_ITEMS.filter((item) => item.section === "utility");
export const MOBILE_NAV_ITEMS = NAV_ITEMS.filter((item) => item.mobile);
export const MOBILE_MORE_ITEMS = NAV_ITEMS.filter((item) => !item.mobile);

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  if (prefix === ROUTES.TIMELINE) return pathname === ROUTES.TIMELINE;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isNavigationItemActive(item: NavigationItem, pathname: string): boolean {
  return item.activePaths.some((path) => matchesPathPrefix(pathname, path));
}

export function navigationItemForPath(pathname: string): NavigationItem | undefined {
  return NAV_ITEMS.find((item) => isNavigationItemActive(item, pathname));
}

/**
 * Stable deep-link to a single event. `<base>/event/<id>` redirects to the
 * canonical timeline view scrolled (and pane-opened) on that event.
 */
export function buildEventUrl(eventId: number): string {
  return `/event/${eventId}`;
}

export function parseEventIdFromHash(hash: string): number | undefined {
  const match = hash?.match(/^#event-(\d+)$/);
  return match ? parseInt(match[1], 10) : undefined;
}

export function buildSearchUrl(query?: string): string {
  return query ? `/search?q=${encodeURIComponent(query)}` : "/search";
}

export function buildConversationUrl(source: string, conversationId: string, eventId?: number): string {
  const hash = eventId ? `#event-${eventId}` : "";
  return `/conversation/${encodeURIComponent(source)}/${encodeURIComponent(conversationId)}${hash}`;
}

/** Detail page for a Discord server (guild). Uses the stable guild id. */
export function buildDiscordServerUrl(guildId: string): string {
  return `/server/discord/${encodeURIComponent(guildId)}`;
}

export function buildContactsUrl(params?: {
  id?: number;
  unlinked?: string;
  source?: string;
  view?: string;
  search?: string;
}): string {
  const searchParams = new URLSearchParams();
  if (params?.id) searchParams.set("id", String(params.id));
  if (params?.unlinked) searchParams.set("unlinked", params.unlinked);
  if (params?.source) searchParams.set("source", params.source);
  if (params?.view) searchParams.set("view", params.view);
  if (params?.search) searchParams.set("search", params.search);
  const query = searchParams.toString();
  return `/contacts${query ? `?${query}` : ""}`;
}

export function buildConversationsUrl(params?: { search?: string; source?: string }): string {
  const searchParams = new URLSearchParams();
  if (params?.search) searchParams.set("search", params.search);
  if (params?.source) searchParams.set("source", params.source);
  const query = searchParams.toString();
  return `/conversations${query ? `?${query}` : ""}`;
}

export function buildMcpSessionUrl(id: string): string {
  return `/mcp-sessions/${encodeURIComponent(id)}`;
}

export function buildCodingProjectUrl(name: string, eventId?: number): string {
  const hash = eventId ? `#event-${eventId}` : "";
  return `/coding/project/${encodeURIComponent(name)}${hash}`;
}

export function buildMusicPlaylistUrl(playlistId: string): string {
  return `/music/playlist/${encodeURIComponent(playlistId)}`;
}

export function buildTimelineUrl(params?: { date?: string; map?: boolean; eventId?: number }): string {
  const searchParams = new URLSearchParams();
  if (params?.date) searchParams.set("date", params.date);
  if (params?.map) searchParams.set("map", "true");
  const hash = params?.eventId ? `#event-${params.eventId}` : "";
  const query = searchParams.toString();
  return `${ROUTES.TIMELINE}${query ? `?${query}` : ""}${hash}`;
}

type HealthUrlParams =
  | { section?: string; view?: never; mode?: never; anchor?: never }
  | ({ section?: string } & HealthWindowSelection);

export function buildHealthUrl(params?: HealthUrlParams): string {
  const searchParams = new URLSearchParams();
  if (params?.section) searchParams.set("section", params.section);
  if (params?.view) searchParams.set("view", params.view);
  if (params?.mode) searchParams.set("mode", params.mode);
  if (params?.anchor) searchParams.set("anchor", params.anchor);
  const query = searchParams.toString();
  return `/health${query ? `?${query}` : ""}`;
}

export function buildCodingUrl(preset?: string): string {
  return preset ? `/coding?preset=${encodeURIComponent(preset)}` : "/coding";
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
