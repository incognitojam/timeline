import type { GroupableEvent } from "./types";

// AI chat sources (grouped by conversation)
export const AI_SOURCES = [
  "claude",
  "claude-code",
  "chatgpt",
  "amp",
  "opencode",
  "conductor",
  "t3code",
  "codex",
] as const;

// Social/messaging sources with real people (grouped by conversation)
export const SOCIAL_SOURCES = [
  "discord",
  "skype",
  "facebook",
  "google-chat",
  "phone", // SMS Backup & Restore
  "google-messages",
  "linkedin",
  "instagram",
] as const;

// Sources that should be grouped by conversation (title field)
export const MESSAGE_SOURCES: Set<string> = new Set([...AI_SOURCES, ...SOCIAL_SOURCES]);

export const CONVERSATION_EVENT_TYPE_PATTERNS = [
  { op: "contains", value: "message" },
  { op: "prefix", value: "sms:" },
  { op: "prefix", value: "mms:" },
  { op: "prefix", value: "rcs:" },
  { op: "prefix", value: "call:" },
] as const;

// Predicate for event types that belong in a conversation thread. Comments
// and memories are not conversation-thread events unless a source-specific
// caller opts into them separately.
export function isConversationEventType(type: string): boolean {
  return CONVERSATION_EVENT_TYPE_PATTERNS.some((pattern) => (
    pattern.op === "contains"
      ? type.includes(pattern.value)
      : type.startsWith(pattern.value)
  ));
}

// Reactions (Facebook likes, loves, etc.) carry no per-event content and arrive
// in bursts, so they are collapsed into a time-proximity session card rather
// than rendered one card each. Comments and posts keep their own cards.
export function isReactionEventType(type: string): boolean {
  return type.startsWith("reaction:");
}

// A session made up entirely of reactions. Reactions are high-volume and
// content-free, so a reaction session renders as a compact "Reactions" card
// and — unlike other session sources — never demotes to a single card even
// when it holds just one event. Any social source whose reaction:* events are
// routed to a session bucket (see groupEvents) qualifies, not just Facebook.
function isReactionSession<T extends GroupableEvent>(events: T[]): boolean {
  return events.length > 0 && events.every((e) => isReactionEventType(e.type));
}

// Sources with actual personal contacts (for contact matching)
// Excludes public content like youtube, reddit where "people" are channels/authors
export const PERSONAL_SOURCES = [...SOCIAL_SOURCES, "google-calendar"] as const;

// Sources that should be grouped by time proximity (sessions)
// Note: spotify-friends is handled specially in groupEvents() with per-person grouping
export const SESSION_SOURCES = new Set(["spotify", "youtube", "trakt", "chrome", "google-search", "spotify-friends", "google-playstore", "steam", "minecraft", "recall", "swarm"]);

// Gap in minutes to consider same session
export const SESSION_GAP_MINUTES: Record<string, number> = {
  spotify: 10,
  youtube: 15,
  trakt: 30,
  chrome: 30,
  "google-search": 15,
  "spotify-friends": 15,
  "google-playstore": 30,
  steam: 30,
  minecraft: 10,
  // Captures land every 30s — group anything within 5 minutes as one session.
  // Larger gaps would merge separate work sessions into one giant group.
  recall: 5,
  // Reactions come in scroll-and-like bursts; group like a browsing session.
  // Facebook is not a SESSION_SOURCE (its messages group as conversations) —
  // only its reaction:* events are routed to a session bucket in groupEvents.
  facebook: 15,
  // Swarm additionally requires spatial proximity (see groupEvents) — the
  // time gap alone would merge train journeys, not just nested venues.
  swarm: 15,
};

// Swarm check-ins merge only when this close together. Nested-venue pairs
// (station → platform, adjacent shops) sit well under this; consecutive
// stops on a journey are kilometres apart.
const SWARM_MERGE_MAX_METERS = 250;

export const IDLE_MINUTES_ENDING_CONVERSATION_CARD = 60;

export interface GroupEventsOptions {
  // Transcript exports pass false to render a thread as one continuous section.
  splitConversations?: boolean;
}

export interface EventGroupData<T extends GroupableEvent = GroupableEvent> {
  id: string;
  type: "conversation" | "session" | "single";
  source: string;
  label: string;
  events: T[];
  summary: string;
  timeRange: { start: string | null; end: string | null };
  participants?: string[];
  totalDuration?: number;
}

// Get timestamp as number for comparison (handles both string and Date)
function getTimestamp(ts: string | Date | null): number {
  if (!ts) return 0;
  if (typeof ts === "string") return new Date(ts).getTime();
  if (ts instanceof Date) return ts.getTime();
  return 0;
}

// Get timestamp as ISO string (normalizes Date to string)
function toISOString(ts: string | Date | null): string | null {
  if (!ts) return null;
  if (typeof ts === "string") return ts;
  if (ts instanceof Date) return ts.toISOString();
  return null;
}

// Extract first person from people JSON field
function extractFirstPerson(peopleJson: string | null): string {
  if (!peopleJson) return "unknown";
  try {
    const people = JSON.parse(peopleJson);
    if (!Array.isArray(people)) return "unknown";
    const first = people[0];
    return typeof first === "string" && first ? first : "unknown";
  } catch {
    return "unknown";
  }
}

// Collect each event's sender (people[0]) so a group's participants mean "who
// spoke in this window" uniformly. Entries after the first are the channel
// roster, which varies by source and would otherwise credit people who said
// nothing in the group. people[0] is the same field the expanded rows render
// as the message sender.
function extractParticipants<T extends GroupableEvent>(events: T[]): string[] {
  const participants = new Set<string>();
  for (const event of events) {
    if (!event.people) continue;
    try {
      const people = JSON.parse(event.people) as unknown;
      if (!Array.isArray(people)) continue;
      const sender = people[0];
      if (typeof sender === "string" && sender.trim()) {
        participants.add(sender);
      }
    } catch {
      // Ignore parse errors
    }
  }
  return Array.from(participants);
}

// Generate group ID from the grouping key (conversation id or label)
function makeGroupId(source: string, key: string, startTime: string | null): string {
  return `${source}:${key}:${startTime || "unknown"}`;
}

// Extract artist from content string (format: "Track by Artist from Album")
function extractArtistFromContent(content: string): string | null {
  const match = content.match(/by (.+?)(?:\s+from\s+|$)/);
  return match ? match[1] : null;
}

// Extract unique artists from a list of events
function extractArtistsFromEvents<T extends GroupableEvent>(events: T[]): Set<string> {
  const artists = new Set<string>();
  for (const event of events) {
    if (event.content) {
      const artist = extractArtistFromContent(event.content);
      if (artist) {
        artists.add(artist);
      }
    }
  }
  return artists;
}

// Format artist set into a label string
function formatArtistLabel(artists: Set<string>): string {
  if (artists.size === 1) {
    return Array.from(artists)[0];
  } else if (artists.size === 2) {
    return Array.from(artists).join(" and ");
  } else if (artists.size >= 3) {
    return `${Array.from(artists).slice(0, 2).join(", ")} & more`;
  }
  return "Listening session";
}

// Group messages by conversation (conversation_id, falling back to title for
// events imported before their source populated the column)
function groupMessagesByConversation<T extends GroupableEvent>(
  events: T[],
  gapMinutes: number | null
): EventGroupData<T>[] {
  const conversations = new Map<string, T[]>();

  for (const event of events) {
    const key = event.conversation_id ?? (event.title || "(no title)");
    let group = conversations.get(key);
    if (!group) {
      group = [];
      conversations.set(key, group);
    }
    group.push(event);
  }

  const windows: [string, T[]][] = [];
  for (const [key, conversationEvents] of conversations) {
    conversationEvents.sort((a, b) => getTimestamp(a.timestamp) - getTimestamp(b.timestamp));
    if (gapMinutes === null) {
      windows.push([key, conversationEvents]);
      continue;
    }
    // Windows share the conversation key; makeGroupId folds in the start time,
    // which is what keeps their ids distinct.
    for (const window of splitByGap(conversationEvents, gapMinutes)) {
      windows.push([key, window]);
    }
  }

  return windows.map(([key, groupEvents]) => {
    const source = groupEvents[0].source;
    const participants = extractParticipants(groupEvents);
    const startTs = toISOString(groupEvents[0].timestamp);
    const endTs = toISOString(groupEvents[groupEvents.length - 1].timestamp);

    // Count by type for AI chats
    const isAiChat = (AI_SOURCES as readonly string[]).includes(source);
    let summary: string;
    if (isAiChat) {
      const userCount = groupEvents.filter((e) => e.type.includes("user")).length;
      const assistantCount = groupEvents.filter((e) => e.type.includes("assistant")).length;
      const plural = groupEvents.length !== 1 ? "s" : "";
      summary = `${groupEvents.length} message${plural} (${userCount} user, ${assistantCount} assistant)`;
    } else {
      summary = `${groupEvents.length} message${groupEvents.length !== 1 ? "s" : ""}`;
    }

    // The key may be an opaque conversation id — display always uses the title
    const label = groupEvents[0].title || "(no title)";

    return {
      id: makeGroupId(source, key, startTs),
      type: "conversation" as const,
      source,
      label,
      events: groupEvents,
      summary,
      timeRange: { start: startTs, end: endTs },
      participants,
    };
  });
}

// Approximate ground distance between two events' coordinates in metres
// (equirectangular — fine at venue scale). Null when either lacks coordinates.
function eventDistanceMeters(a: GroupableEvent, b: GroupableEvent): number | null {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) {
    return null;
  }
  const meanLatRad = ((a.latitude + b.latitude) / 2) * (Math.PI / 180);
  const dLat = (b.latitude - a.latitude) * 111_320;
  const dLng = (b.longitude - a.longitude) * 111_320 * Math.cos(meanLatRad);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function splitByGap<T extends GroupableEvent>(
  events: T[],
  gapMinutes: number,
  canChain?: (prev: T, curr: T) => boolean
): T[][] {
  if (events.length === 0) return [];

  const sorted = [...events].sort(
    (a, b) => getTimestamp(a.timestamp) - getTimestamp(b.timestamp)
  );

  const groups: T[][] = [];
  let currentGroup: T[] = [sorted[0]];
  const gapMs = gapMinutes * 60 * 1000;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = getTimestamp(curr.timestamp) - getTimestamp(prev.timestamp);

    if (gap <= gapMs && (!canChain || canChain(prev, curr))) {
      currentGroup.push(curr);
    } else {
      groups.push(currentGroup);
      currentGroup = [curr];
    }
  }
  groups.push(currentGroup);

  return groups;
}

// Group events by time proximity (sessions). An optional canChain predicate
// must also hold between consecutive events for them to share a group.
function groupByTimeProximity<T extends GroupableEvent>(
  events: T[],
  gapMinutes: number,
  canChain?: (prev: T, curr: T) => boolean
): EventGroupData<T>[] {
  if (events.length === 0) return [];

  const groups = splitByGap(events, gapMinutes, canChain);
  const source = events[0].source;

  return groups.map((groupEvents, idx) => {
    const startTs = toISOString(groupEvents[0].timestamp);
    const endTs = toISOString(groupEvents[groupEvents.length - 1].timestamp);

    // Calculate total duration
    let totalDuration = 0;
    for (const event of groupEvents) {
      if (event.duration_ms) {
        totalDuration += event.duration_ms;
      }
    }

    // Generate appropriate label and summary
    let label: string;
    let summary: string;

    if (source === "spotify") {
      const artists = extractArtistsFromEvents(groupEvents);
      label = formatArtistLabel(artists);
      summary = `${groupEvents.length} track${groupEvents.length !== 1 ? "s" : ""}`;
    } else if (source === "youtube") {
      label = "YouTube session";
      summary = `${groupEvents.length} video${groupEvents.length !== 1 ? "s" : ""}`;
    } else if (source === "chrome") {
      // Group by domain for Chrome
      const domains = new Map<string, number>();
      for (const event of groupEvents) {
        const title = event.title || "";
        // Extract domain from title if possible (often format is "Page Title - Domain")
        const match = title.match(/- ([^-]+)$/);
        const domain = match ? match[1].trim() : "Unknown";
        domains.set(domain, (domains.get(domain) || 0) + 1);
      }
      const topDomains = Array.from(domains.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([d]) => d);
      label = topDomains.length > 0 ? topDomains.join(", ") : "Browsing session";
      summary = `${groupEvents.length} page${groupEvents.length !== 1 ? "s" : ""}`;
    } else if (source === "trakt") {
      label = "Watching session";
      summary = `${groupEvents.length} item${groupEvents.length !== 1 ? "s" : ""}`;
    } else if (source === "google-search") {
      label = "Search session";
      summary = `${groupEvents.length} search${groupEvents.length !== 1 ? "es" : ""}`;
    } else if (source === "google-playstore") {
      // Show first few app names or generic label
      const appNames = groupEvents.map((e) => e.title).filter(Boolean);
      if (appNames.length <= 3) {
        label = appNames.join(", ");
      } else {
        label = `${appNames.slice(0, 2).join(", ")} & ${appNames.length - 2} more`;
      }
      summary = `${groupEvents.length} app${groupEvents.length !== 1 ? "s" : ""}`;
    } else if (source === "steam") {
      const gameAddedEvents = groupEvents.filter(e => e.type === "steam:game:added");
      const achievementEvents = groupEvents.filter(e => e.type === "steam:achievement");
      const otherCount = groupEvents.length - gameAddedEvents.length - achievementEvents.length;

      if (gameAddedEvents.length > 0 && achievementEvents.length === 0 && otherCount === 0) {
        // Pure library additions
        const gameNames = gameAddedEvents.map(e => e.title).filter(Boolean);
        if (gameNames.length <= 3) {
          label = gameNames.join(", ");
        } else {
          label = `${gameNames.slice(0, 2).join(", ")} & ${gameNames.length - 2} more`;
        }
        summary = `${gameAddedEvents.length} game${gameAddedEvents.length !== 1 ? "s" : ""} added`;
      } else if (achievementEvents.length > 0 && gameAddedEvents.length === 0 && otherCount === 0) {
        // Pure achievements - extract game names from title format "Achievement (Game Name)"
        const games = new Set<string>();
        for (const e of achievementEvents) {
          if (e.title) {
            const match = e.title.match(/\(([^)]+)\)$/);
            if (match) games.add(match[1]);
          }
        }
        if (games.size === 1) {
          label = Array.from(games)[0];
        } else if (games.size === 2) {
          label = Array.from(games).join(" and ");
        } else if (games.size >= 3) {
          label = `${Array.from(games).slice(0, 2).join(", ")} & more`;
        } else {
          label = "Gaming session";
        }
        summary = `${achievementEvents.length} achievement${achievementEvents.length !== 1 ? "s" : ""}`;
      } else {
        // Mixed or unknown types
        const parts: string[] = [];
        if (gameAddedEvents.length > 0) {
          parts.push(`${gameAddedEvents.length} game${gameAddedEvents.length !== 1 ? "s" : ""} added`);
        }
        if (achievementEvents.length > 0) {
          parts.push(`${achievementEvents.length} achievement${achievementEvents.length !== 1 ? "s" : ""}`);
        }
        if (otherCount > 0) {
          parts.push(`${otherCount} event${otherCount !== 1 ? "s" : ""}`);
        }
        label = "Steam";
        summary = parts.length > 0 ? parts.join(", ") : `${groupEvents.length} event${groupEvents.length !== 1 ? "s" : ""}`;
      }
    } else if (source === "minecraft") {
      const serverName = groupEvents[0].title;

      const typeCounts = new Map<string, number>();
      for (const e of groupEvents) {
        const shortType = e.type.replace("minecraft:", "");
        typeCounts.set(shortType, (typeCounts.get(shortType) || 0) + 1);
      }

      const parts: string[] = [];
      const chatCount = typeCounts.get("chat") || 0;
      const advCount = typeCounts.get("advancement") || 0;
      const deathCount = typeCounts.get("death") || 0;
      const joinCount = typeCounts.get("join") || 0;
      const leaveCount = typeCounts.get("leave") || 0;

      if (chatCount > 0) parts.push(`${chatCount} message${chatCount !== 1 ? "s" : ""}`);
      if (advCount > 0) parts.push(`${advCount} advancement${advCount !== 1 ? "s" : ""}`);
      if (deathCount > 0) parts.push(`${deathCount} death${deathCount !== 1 ? "s" : ""}`);
      if (joinCount > 0) parts.push(`${joinCount} join${joinCount !== 1 ? "s" : ""}`);
      if (leaveCount > 0) parts.push(`${leaveCount} leave${leaveCount !== 1 ? "s" : ""}`);

      if (parts.length === 0) {
        parts.push(`${groupEvents.length} event${groupEvents.length !== 1 ? "s" : ""}`);
      }

      label = serverName || "Minecraft session";
      summary = parts.join(", ");
    } else if (source === "spotify-friends") {
      const artists = extractArtistsFromEvents(groupEvents);
      label = formatArtistLabel(artists);
      summary = `${groupEvents.length} track${groupEvents.length !== 1 ? "s" : ""}`;
    } else if (source === "recall") {
      // Recall captures store the frontmost app in `title`. Show top apps in
      // the session label so the user can skim what they were working on.
      const appCounts = new Map<string, number>();
      for (const event of groupEvents) {
        const app = event.title?.trim();
        if (app) appCounts.set(app, (appCounts.get(app) || 0) + 1);
      }
      const sortedApps = Array.from(appCounts.entries()).sort((a, b) => b[1] - a[1]);
      if (sortedApps.length === 0) {
        label = "Screen captures";
      } else if (sortedApps.length === 1) {
        label = sortedApps[0][0];
      } else if (sortedApps.length === 2) {
        label = `${sortedApps[0][0]}, ${sortedApps[1][0]}`;
      } else {
        label = `${sortedApps[0][0]}, ${sortedApps[1][0]} & ${sortedApps.length - 2} more`;
      }
      summary = `${groupEvents.length} capture${groupEvents.length !== 1 ? "s" : ""}`;
    } else if (source === "swarm") {
      // Nested-venue merges check the parent in first (station, then
      // platform), so the first distinct name leads the label.
      const names: string[] = [];
      const seen = new Set<string>();
      for (const event of groupEvents) {
        const loc = event.location_name;
        if (loc && !seen.has(loc)) {
          seen.add(loc);
          names.push(loc);
        }
      }
      if (names.length === 0) {
        label = "Check-ins";
      } else if (names.length <= 2) {
        label = names.join(" · ");
      } else {
        label = `${names[0]} · ${names.length - 1} more`;
      }
      summary = `${groupEvents.length} check-in${groupEvents.length !== 1 ? "s" : ""}`;
    } else if (isReactionSession(groupEvents)) {
      label = "Reactions";
      summary = `${groupEvents.length} reaction${groupEvents.length !== 1 ? "s" : ""}`;
    } else {
      label = `${source} session`;
      summary = `${groupEvents.length} event${groupEvents.length !== 1 ? "s" : ""}`;
    }

    return {
      id: makeGroupId(source, "session", startTs),
      type: "session" as const,
      source,
      label,
      events: groupEvents,
      summary,
      timeRange: { start: startTs, end: endTs },
      totalDuration: totalDuration > 0 ? totalDuration : undefined,
    };
  });
}

// Main grouping function
export function groupEvents<T extends GroupableEvent>(
  events: T[],
  options: GroupEventsOptions = {}
): EventGroupData<T>[] {
  const conversationGap =
    options.splitConversations === false ? null : IDLE_MINUTES_ENDING_CONVERSATION_CARD;

  // Separate events by source type
  const messageEvents = new Map<string, T[]>();
  const sessionEvents = new Map<string, T[]>();
  const journalEvents: T[] = [];
  const singleEvents: T[] = [];

  for (const event of events) {
    if (MESSAGE_SOURCES.has(event.source)) {
      // Only group conversation-thread event types as conversations.
      // Reactions collapse into a time-proximity session; everything else
      // non-message (comments, posts, friend adds, votes, etc.) stays single.
      if (isConversationEventType(event.type)) {
        let arr = messageEvents.get(event.source);
        if (!arr) {
          arr = [];
          messageEvents.set(event.source, arr);
        }
        arr.push(event);
      } else if (isReactionEventType(event.type)) {
        let arr = sessionEvents.get(event.source);
        if (!arr) {
          arr = [];
          sessionEvents.set(event.source, arr);
        }
        arr.push(event);
      } else {
        singleEvents.push(event);
      }
    } else if (SESSION_SOURCES.has(event.source)) {
      let arr = sessionEvents.get(event.source);
      if (!arr) {
        arr = [];
        sessionEvents.set(event.source, arr);
      }
      arr.push(event);
    } else if (event.source === "journal") {
      journalEvents.push(event);
    } else {
      singleEvents.push(event);
    }
  }

  // Build grouped results
  const results: EventGroupData<T>[] = [];

  // Group messages by conversation
  for (const [, sourceEvents] of messageEvents) {
    const groups = groupMessagesByConversation(sourceEvents, conversationGap);
    results.push(...groups);
  }

  // Handle spotify-friends with per-person grouping
  const spotifyFriendsEvents = sessionEvents.get("spotify-friends");
  if (spotifyFriendsEvents && spotifyFriendsEvents.length > 0) {
    sessionEvents.delete("spotify-friends"); // Don't process in normal loop

    // Separate by person (friend)
    const byPerson = new Map<string, T[]>();
    for (const event of spotifyFriendsEvents) {
      const person = extractFirstPerson(event.people);
      let arr = byPerson.get(person);
      if (!arr) {
        arr = [];
        byPerson.set(person, arr);
      }
      arr.push(event);
    }

    // Group each person's events by time proximity
    const gapMinutes = SESSION_GAP_MINUTES["spotify-friends"] || 5;
    for (const [person, personEvents] of byPerson) {
      const groups = groupByTimeProximity(personEvents, gapMinutes);
      for (const group of groups) {
        group.participants = [person];
        // Include person in ID to avoid collisions when multiple friends have sessions at same time
        group.id = `${group.id}:${person}`;
        if (group.events.length === 1) {
          results.push({ ...group, type: "single" });
        } else {
          results.push(group);
        }
      }
    }
  }

  // Handle steam with per-type grouping (sessions stand alone, additions/achievements group)
  const steamEvents = sessionEvents.get("steam");
  if (steamEvents && steamEvents.length > 0) {
    sessionEvents.delete("steam"); // Don't process in normal loop

    // Separate session events (already have duration) from other types
    const sessions: T[] = [];
    const others: T[] = [];
    for (const event of steamEvents) {
      if (event.type === "steam:session") {
        sessions.push(event);
      } else {
        others.push(event);
      }
    }

    // Sessions are self-contained — render as singles
    for (const event of sessions) {
      const ts = toISOString(event.timestamp);
      results.push({
        id: `single:${event.id}`,
        type: "single",
        source: "steam",
        label: event.title || event.type,
        events: [event],
        summary: event.type,
        timeRange: { start: ts, end: ts },
      });
    }

    // Group remaining steam events (added, achievements) by time proximity
    if (others.length > 0) {
      const gapMinutes = SESSION_GAP_MINUTES["steam"] || 30;
      const groups = groupByTimeProximity(others, gapMinutes);
      for (const group of groups) {
        if (group.events.length === 1) {
          results.push({ ...group, type: "single" });
        } else {
          results.push(group);
        }
      }
    }
  }

  // Handle minecraft with per-server grouping
  const minecraftEvents = sessionEvents.get("minecraft");
  if (minecraftEvents && minecraftEvents.length > 0) {
    sessionEvents.delete("minecraft"); // Don't process in normal loop

    // Separate by server (title field)
    const byServer = new Map<string, T[]>();
    for (const event of minecraftEvents) {
      const server = event.title || "unknown";
      let arr = byServer.get(server);
      if (!arr) {
        arr = [];
        byServer.set(server, arr);
      }
      arr.push(event);
    }

    // Group each server's events by time proximity
    const gapMinutes = SESSION_GAP_MINUTES["minecraft"] || 10;
    for (const [server, serverEvents] of byServer) {
      const groups = groupByTimeProximity(serverEvents, gapMinutes);
      for (const group of groups) {
        // Include server in ID to avoid collisions
        group.id = `${group.id}:${server}`;
        if (group.events.length === 1) {
          results.push({ ...group, type: "single" });
        } else {
          results.push(group);
        }
      }
    }
  }

  // Handle swarm with a spatial guard on top of time proximity. Check-ins
  // carry no parent-venue metadata (the Foursquare check-in payload omits
  // venue hierarchy), so nesting (station → platform) is inferred from
  // being close in both time and space. Time alone would also merge train
  // journeys — consecutive stations minutes apart but kilometres away.
  const swarmEvents = sessionEvents.get("swarm");
  if (swarmEvents && swarmEvents.length > 0) {
    sessionEvents.delete("swarm"); // Don't process in normal loop

    const gapMinutes = SESSION_GAP_MINUTES["swarm"] || 15;
    const groups = groupByTimeProximity(swarmEvents, gapMinutes, (prev, curr) => {
      const distance = eventDistanceMeters(prev, curr);
      return distance !== null && distance <= SWARM_MERGE_MAX_METERS;
    });
    for (const group of groups) {
      if (group.events.length === 1) {
        results.push({ ...group, type: "single" });
      } else {
        results.push(group);
      }
    }
  }

  // Group session sources by time proximity
  for (const [source, sourceEvents] of sessionEvents) {
    const gapMinutes = SESSION_GAP_MINUTES[source] || 15;
    const groups = groupByTimeProximity(sourceEvents, gapMinutes);
    for (const group of groups) {
      // A 1-event session normally demotes to a single card, but reaction
      // sessions stay collapsed so no reaction ever takes a full timeline card.
      if (group.events.length === 1 && !isReactionSession(group.events)) {
        results.push({
          ...group,
          type: "single",
        });
      } else {
        results.push(group);
      }
    }
  }

  // Group journal events (Q&A + reflections) into a single card
  if (journalEvents.length > 1) {
    const sorted = [...journalEvents].sort(
      (a, b) => getTimestamp(a.timestamp) - getTimestamp(b.timestamp)
    );
    const startTs = toISOString(sorted[0].timestamp);
    const endTs = toISOString(sorted[sorted.length - 1].timestamp);

    const qaCount = sorted.filter(e => e.type === "journal:qa").length;
    const reflectionCount = sorted.filter(e => e.type === "journal:reflection").length;

    const parts: string[] = [];
    if (qaCount > 0) parts.push(`${qaCount} Q&A${qaCount !== 1 ? "s" : ""}`);
    if (reflectionCount > 0) parts.push(`${reflectionCount} reflection${reflectionCount !== 1 ? "s" : ""}`);
    const summary = parts.join(" + ");

    results.push({
      id: makeGroupId("journal", "journal", startTs),
      type: "session" as const,
      source: "journal",
      label: "Journal",
      events: sorted,
      summary,
      timeRange: { start: startTs, end: endTs },
    });
  } else if (journalEvents.length === 1) {
    const event = journalEvents[0];
    const ts = toISOString(event.timestamp);
    results.push({
      id: `single:${event.id}`,
      type: "single",
      source: event.source,
      label: event.title || event.type,
      events: [event],
      summary: event.type,
      timeRange: { start: ts, end: ts },
    });
  }

  // Add single events
  for (const event of singleEvents) {
    const ts = toISOString(event.timestamp);
    results.push({
      id: `single:${event.id}`,
      type: "single",
      source: event.source,
      label: event.title || event.type,
      events: [event],
      summary: event.type,
      timeRange: { start: ts, end: ts },
    });
  }

  // Sort all groups by their start time
  results.sort((a, b) => {
    const aTime = a.timeRange.start ? new Date(a.timeRange.start).getTime() : 0;
    const bTime = b.timeRange.start ? new Date(b.timeRange.start).getTime() : 0;
    return aTime - bTime;
  });

  return results;
}
