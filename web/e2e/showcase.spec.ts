/**
 * Showcase screenshots for the README (docs/screenshots/).
 *
 * Not part of the regression suite: these tests render the app against a rich
 * set of entirely fictional fixture data and save plain screenshots — no
 * baseline comparison. Regenerate deliberately from the repository root with
 * `./scripts/test-browser.sh --config=playwright.showcase.config.ts` whenever
 * the UI is worth re-shooting.
 *
 * All people, places, messages, and transactions below are invented; keep it
 * that way — nothing in this file may come from a real export.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/screenshots");
mkdirSync(OUTPUT_DIR, { recursive: true });

const DAY = "2025-03-07"; // A Friday; the showcase browser runs in UTC.
const NOW = new Date("2025-03-07T21:30:00.000Z");

// ---------------------------------------------------------------------------
// Generated artwork (inline SVG data URIs so no network requests happen)
// ---------------------------------------------------------------------------

/** Album-art-like tile: diagonal gradient with a vinyl-ish ring. */
function albumArt(from: string, to: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${from}'/><stop offset='1' stop-color='${to}'/>` +
    `</linearGradient></defs>` +
    `<rect width='120' height='120' fill='url(#g)'/>` +
    `<circle cx='60' cy='60' r='30' fill='none' stroke='rgba(255,255,255,0.35)' stroke-width='2'/>` +
    `<circle cx='60' cy='60' r='6' fill='rgba(255,255,255,0.45)'/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const ART = {
  ember: albumArt("#b45309", "#7c2d12"),
  tide: albumArt("#0e7490", "#1e3a8a"),
  moss: albumArt("#3f6212", "#14532d"),
  dusk: albumArt("#7e22ce", "#312e81"),
  rose: albumArt("#be185d", "#831843"),
  slate: albumArt("#475569", "#0f172a"),
  gold: albumArt("#ca8a04", "#78350f"),
  mist: albumArt("#64748b", "#334155"),
};

// ---------------------------------------------------------------------------
// Cast (all fictional)
// ---------------------------------------------------------------------------

const PEOPLE = {
  me: { id: "discord:1000", name: "Alex" },
  rowan: { id: "discord:1001", name: "Rowan" },
  priya: { id: "discord:1002", name: "Priya" },
  sam: { id: "discord:1003", name: "Sam" },
};

const RESOLVED_IDENTITIES: Record<
  string,
  { name: string; username: string | null; contactId: number | null; avatarUrl: string | null }
> = Object.fromEntries(
  Object.values(PEOPLE).map((p, i) => [
    p.id,
    { name: p.name, username: p.name.toLowerCase(), contactId: i + 1, avatarUrl: null },
  ]),
);

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

interface EventOverrides {
  end_timestamp?: string | null;
  duration_ms?: number | null;
  title?: string | null;
  content?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  location_name?: string | null;
  people?: string[] | null;
  tags?: string[] | null;
  raw_data?: unknown;
  conversation_id?: string | null;
  source_account?: string | null;
  replied_to?: {
    event_id?: number;
    conversation_id?: string;
    author_name: string | null;
    content: string | null;
    has_attachment: boolean;
  };
}

let nextEventId = 1;

function event(source: string, type: string, timestamp: string, overrides: EventOverrides = {}) {
  const id = nextEventId++;
  return {
    id,
    source,
    source_id: `showcase-${id}`,
    source_account: overrides.source_account ?? "demo",
    type,
    timestamp,
    end_timestamp: overrides.end_timestamp ?? null,
    duration_ms: overrides.duration_ms ?? null,
    title: overrides.title ?? null,
    content: overrides.content ?? null,
    latitude: overrides.latitude ?? null,
    longitude: overrides.longitude ?? null,
    location_name: overrides.location_name ?? null,
    people: overrides.people ? JSON.stringify(overrides.people) : null,
    tags: overrides.tags ? JSON.stringify(overrides.tags) : null,
    raw_data: JSON.stringify(overrides.raw_data ?? {}),
    imported_at: "2025-03-07 21:00:00",
    import_batch: "showcase",
    conversation_id: overrides.conversation_id ?? null,
    ...(overrides.replied_to ? { replied_to: overrides.replied_to } : {}),
  };
}

function spotifyTrack(timestamp: string, track: string, artist: string, album: string, art: string) {
  return event("spotify", "listen:track", timestamp, {
    title: track,
    content: `${track} by ${artist} from ${album}`,
    duration_ms: 180_000 + ((nextEventId * 7919) % 90_000),
    raw_data: { track: { uri: `spotify:track:demo${nextEventId}`, album: { images: [{ height: 300, url: art }] } } },
  });
}

// ---------------------------------------------------------------------------
// The day: Friday 7 March 2025
// ---------------------------------------------------------------------------

const HIKE_CONVERSATION_ID = "dc-weekend-hike";

function buildDayEvents() {
  nextEventId = 1;
  const t = (time: string) => `${DAY}T${time}.000Z`;

  const events = [
    // Morning listening on the commute
    spotifyTrack(t("07:32:04"), "Golden Hour", "Cassette Skyline", "Departures", ART.ember),
    spotifyTrack(t("07:35:41"), "North Sea", "Cassette Skyline", "Departures", ART.tide),
    spotifyTrack(t("07:39:12"), "Glass Rain", "Field Atlas", "Weather Systems", ART.dusk),
    spotifyTrack(t("07:43:55"), "Low Light", "Field Atlas", "Weather Systems", ART.moss),
    spotifyTrack(t("07:47:30"), "Signal Fire", "Cassette Skyline", "Departures", ART.gold),

    // Quick research burst
    event("google-search", "google:search", t("08:20:11"), { title: "greywater ridge weather saturday" }),
    event("google-search", "google:search", t("08:22:47"), { title: "greywater ridge circular route map" }),
    event("google-search", "google:search", t("08:25:03"), { title: "best flask for day hikes" }),

    // Group chat planning the weekend
    event("discord", "message:group", t("08:52:19"), {
      title: "weekend hike 🥾",
      content: "right, forecast says sunny until 3pm — are we doing Greywater Ridge or the easy one?",
      people: [PEOPLE.rowan.id],
      conversation_id: HIKE_CONVERSATION_ID,
    }),
    event("discord", "message:group", t("08:54:02"), {
      title: "weekend hike 🥾",
      content: "the ridge. we always say the easy one and then feel cheated",
      people: [PEOPLE.me.id],
      conversation_id: HIKE_CONVERSATION_ID,
    }),
    event("discord", "message:group", t("09:01:36"), {
      title: "weekend hike 🥾",
      content: "I can drive, picking up at 8:30. bring actual boots this time Sam",
      people: [PEOPLE.priya.id],
      conversation_id: HIKE_CONVERSATION_ID,
    }),
    event("discord", "message:group", t("09:14:50"), {
      title: "weekend hike 🥾",
      content: "one (1) time",
      people: [PEOPLE.sam.id],
      conversation_id: HIKE_CONVERSATION_ID,
    }),

    // Deep work
    event("wakatime", "code:session", t("09:05:00"), {
      title: "timeline (2h 38m)",
      end_timestamp: t("11:43:00"),
      duration_ms: 9_480_000,
      raw_data: { languages: { TypeScript: 74, Swift: 18, CSS: 8 }, branches: ["day-view-polish"] },
    }),
    event("github", "github:pr", t("11:52:26"), {
      title: "Merged #214 — health: sleep stage charts",
      content: "timeline",
    }),

    // Lunch out
    event("monzo", "transaction:food", t("12:34:09"), {
      title: "Corner Deli",
      content: "-£6.80 · Lunch",
      source_account: "personal",
    }),
    event("swarm", "location:visit", t("13:02:44"), {
      location_name: "Lanternfield Park",
      title: "Checked in at Lanternfield Park",
      content: "lunchtime loop ☀️",
      latitude: 47.618,
      longitude: -31.402,
      tags: ["Park"],
    }),

    // Afternoon
    event("youtube", "youtube:watch", t("14:03:12"), {
      title: "How SQLite Works: Pages & B-Trees",
      content: "Systems Sketchbook",
      people: ["name:Systems Sketchbook"],
    }),
    event("youtube", "youtube:watch", t("14:18:40"), {
      title: "Restoring a 1970s field camera, part 3",
      content: "Workbench Diaries",
      people: ["name:Workbench Diaries"],
    }),
    event("google-calendar", "event", t("15:30:00"), {
      title: "Team retro",
      end_timestamp: t("16:00:00"),
      duration_ms: 1_800_000,
    }),
    spotifyTrack(t("16:41:08"), "Slow Orbit", "Marrow Theory", "Perihelion", ART.slate),
    spotifyTrack(t("16:45:56"), "Afterglow", "Marrow Theory", "Perihelion", ART.rose),
    spotifyTrack(t("16:50:22"), "Meridian", "Marrow Theory", "Perihelion", ART.mist),

    // Evening
    event("monzo", "transaction:groceries", t("18:12:33"), {
      title: "Fern & Root Grocers",
      content: "-£23.41 · Groceries",
      source_account: "personal",
    }),
    event("google-fit", "activity:running", t("18:35:00"), {
      title: "Evening run",
      end_timestamp: t("19:09:00"),
      duration_ms: 2_040_000,
      content: "5.2 km · riverside loop",
    }),
    event("trakt", "trakt:watch:movie", t("19:45:00"), {
      title: "Spirited Away (2001)",
      duration_ms: 7_500_000,
    }),

    // Late-night AI chat
    event("claude", "claude:message:user", t("21:02:11"), {
      title: "Raised bed planting plan",
      content: "I have a 2m x 1m raised bed, partial shade. What can I plant in March?",
      conversation_id: "cl-garden",
    }),
    event("claude", "claude:message:assistant", t("21:02:38"), {
      title: "Raised bed planting plan",
      content: "March is a great time to start. For partial shade, direct-sow spinach, radishes, and…",
      conversation_id: "cl-garden",
    }),
    event("claude", "claude:message:user", t("21:05:57"), {
      title: "Raised bed planting plan",
      content: "How deep does the bed need to be for carrots?",
      conversation_id: "cl-garden",
    }),
    event("claude", "claude:message:assistant", t("21:06:19"), {
      title: "Raised bed planting plan",
      content: "At least 30cm of loose, stone-free soil — shorter varieties like Paris Market cope with less.",
      conversation_id: "cl-garden",
    }),
  ];

  const bySourceCounts = new Map<string, number>();
  for (const e of events) bySourceCounts.set(e.source, (bySourceCounts.get(e.source) ?? 0) + 1);

  return {
    date: DAY,
    centerTimestamp: `${DAY}T12:00:00.000Z`,
    events,
    attachments: {},
    summary: {
      totalEvents: events.length,
      bySource: [...bySourceCounts.entries()].map(([source, count]) => ({ source, count })),
      byType: [],
      timeRange: { earliest: events[0].timestamp, latest: events[events.length - 1].timestamp },
    },
  };
}

const dayHealth = {
  date: DAY,
  hasData: true,
  activity: { steps: 11_247, caloriesOut: 2_610, activeMinutes: 58, floors: 14 },
  sleep: {
    duration: 27_720_000,
    efficiency: 93,
    deepMinutes: 92,
    lightMinutes: 238,
    remMinutes: 96,
    score: {
      score: 84,
      breakdown: { duration: 88, deepSleep: 84, remSleep: 86, continuity: 90, onsetLatency: 78 },
      hasStageData: true,
    },
  },
  healthMetrics: {
    restingHR: { value: 58, status: "in_range", personalRange: [54, 62] },
    hrv: { value: 52, status: "in_range", personalRange: [38, 64] },
    spo2: { value: 96.8, status: "in_range", personalRange: [95, 98] },
    breathingRate: { value: 15.4, status: "in_range", personalRange: [14, 17] },
    skinTempVariation: { value: 0.1, status: "in_range", personalRange: [-1, 1] },
  },
  outOfRangeCount: 0,
  totalMetricCount: 5,
};

// Complete date index for the sidebar: two years of deterministic activity,
// newest first, with quiet gaps (today's count matches the day fixture).
function buildDateIndex(todayCount: number) {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const dates = [{ date: DAY, eventCount: todayCount }];
  const cursor = new Date(`${DAY}T12:00:00.000Z`);
  for (let i = 1; i < 730; i++) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const roll = rand();
    if (roll < 0.06) continue;
    const weekend = cursor.getUTCDay() % 6 === 0;
    dates.push({
      date: cursor.toISOString().slice(0, 10),
      eventCount: Math.round(8 + roll * 44 + (weekend ? 10 : 0)),
    });
  }
  return { dates };
}

// ---------------------------------------------------------------------------
// Conversation: the hiking group chat, in full
// ---------------------------------------------------------------------------

function buildConversation() {
  nextEventId = 500;
  const msg = (
    time: string,
    person: { id: string; name: string },
    content: string,
    extra: EventOverrides = {},
  ) =>
    event("discord", "message:group", time, {
      title: "weekend hike 🥾",
      content,
      people: [person.id],
      conversation_id: HIKE_CONVERSATION_ID,
      ...extra,
    });

  // Thursday evening + Friday, ascending; the shot is anchored at the newest
  // message with "End of conversation" visible.
  const events = [
    msg("2025-03-06T19:41:22.000Z", PEOPLE.rowan, "weather finally looks decent saturday — who's in?"),
    msg("2025-03-06T19:44:31.000Z", PEOPLE.me, "in. shall we finally do Greywater Ridge?", {
      raw_data: {
        reactions: [{ emoji: { name: "👍" }, count: 3, users: [{ name: "Rowan" }, { name: "Sam" }, { name: "Priya" }] }],
      },
    }),
    msg("2025-03-06T19:48:12.000Z", PEOPLE.sam, "depends. is the pub in Lowmere part of the route", {
      raw_data: { reactions: [{ emoji: { name: "😂" }, count: 2, users: [{ name: "Priya" }, { name: "Alex" }] }] },
    }),
    msg("2025-03-07T08:52:19.000Z", PEOPLE.rowan, "right, forecast says sunny until 3pm — are we doing Greywater Ridge or the easy one?"),
    msg("2025-03-07T08:54:02.000Z", PEOPLE.me, "the ridge. we always say the easy one and then feel cheated", {
      raw_data: { reactions: [{ emoji: { name: "💯" }, count: 2, users: [{ name: "Rowan" }, { name: "Priya" }] }] },
    }),
    msg("2025-03-07T09:01:36.000Z", PEOPLE.priya, "I can drive, picking up at 8:30. bring actual boots this time Sam"),
    msg("2025-03-07T09:14:50.000Z", PEOPLE.sam, "one (1) time", {
      replied_to: {
        author_name: "Priya",
        content: "I can drive, picking up at 8:30. bring actual boots this time Sam",
        has_attachment: false,
      },
    }),
    msg("2025-03-07T09:16:33.000Z", PEOPLE.rowan, "I'll sort sandwiches. cheese and pickle non-negotiable"),
    msg("2025-03-07T17:20:41.000Z", PEOPLE.me, "route saved offline + headtorch packed in case we're slow off the plateau"),
    msg("2025-03-07T17:24:58.000Z", PEOPLE.priya, "see everyone at 8:30 sharp ⛰️", {
      raw_data: {
        reactions: [{ emoji: { name: "⛰️" }, count: 3, users: [{ name: "Rowan" }, { name: "Sam" }, { name: "Alex" }] }],
      },
    }),
  ];

  // An older page behind a cursor: the chat reads as long-running (matching
  // the sidebar stats). The scroller pulls it while the top is in view, and
  // its null cursor ends the pagination.
  const olderEvents = [
    msg("2025-03-05T21:03:12.000Z", PEOPLE.priya, "found my map from last time, it has a suspicious tea stain on the summit"),
    msg("2025-03-05T21:07:44.000Z", PEOPLE.rowan, "that's how you know it's been used"),
  ];

  const participants = Object.fromEntries(
    Object.values(PEOPLE).map((p, i) => [p.id, { name: p.name, contactId: i + 1, avatarUrl: null }]),
  );

  return {
    page: {
      title: "weekend hike 🥾",
      // The initial conversation load expects newest-first; the client reverses.
      events: [...events].reverse(),
      attachments: {},
      nextCursor: "older-page-1",
      participants,
      server: { source: "discord", id: "9000001", name: "Ridge Crew" },
    },
    olderPage: {
      title: "weekend hike 🥾",
      events: [...olderEvents].reverse(),
      attachments: {},
      nextCursor: null,
      participants,
      server: { source: "discord", id: "9000001", name: "Ridge Crew" },
    },
    // Polling for newer messages finds nothing past the newest message.
    newerPage: {
      title: "weekend hike 🥾",
      events: [],
      attachments: {},
      nextCursor: null,
      participants,
      server: { source: "discord", id: "9000001", name: "Ridge Crew" },
    },
    stats: {
      totalMessages: 1_284,
      firstMessage: "2024-04-02T18:12:00.000Z",
      lastMessage: events[events.length - 1].timestamp,
      firstEventId: 1,
      lastEventId: events[events.length - 1].id,
      participants: Object.values(PEOPLE).map((p, i) => ({
        identifier: p.id,
        name: p.name,
        contactId: i + 1,
        count: [412, 386, 341, 145][i] ?? 100,
      })),
      attachmentCount: 87,
      activityByMonth: [
        { month: "2024-04", count: 61 },
        { month: "2024-05", count: 84 },
        { month: "2024-06", count: 122 },
        { month: "2024-07", count: 96 },
        { month: "2024-08", count: 143 },
        { month: "2024-09", count: 78 },
        { month: "2024-10", count: 102 },
        { month: "2024-11", count: 91 },
        { month: "2024-12", count: 130 },
        { month: "2025-01", count: 118 },
        { month: "2025-02", count: 149 },
        { month: "2025-03", count: 109 },
      ],
      titles: [],
      tokenUsage: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Health month (February 2025 — complete, deterministic pseudo-random)
// ---------------------------------------------------------------------------

function buildHealthStats() {
  // Small deterministic LCG so the charts look organic but never change.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };

  const sleepByDay = [];
  const heartByDay = [];
  const hrvByDay = [];
  const activityByDay = [];
  const spo2ByDay = [];
  const weightByDay = [];

  for (let day = 1; day <= 28; day++) {
    const date = `2025-02-${String(day).padStart(2, "0")}`;
    const weekend = new Date(`${date}T12:00:00Z`).getUTCDay() % 6 === 0;

    const sleepHours = 6.9 + rand() * 1.4 + (weekend ? 0.5 : 0);
    const bedtimeMinutes = 22 * 60 + 40 + Math.floor(rand() * 70) - (weekend ? 0 : 15);
    const start = new Date(`${date}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 1);
    start.setUTCMinutes(bedtimeMinutes);
    const end = new Date(start.getTime() + sleepHours * 3_600_000);
    sleepByDay.push({
      date,
      duration: Math.round(sleepHours * 3_600_000),
      efficiency: Math.round(89 + rand() * 6),
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      score: Math.round(74 + rand() * 16),
    });

    heartByDay.push({ date, restingHR: Math.round(55 + rand() * 6) });
    hrvByDay.push({ date, rmssd: Math.round(40 + rand() * 22) });
    activityByDay.push({ date, steps: Math.round(4_500 + rand() * 8_000 + (weekend ? 5_000 : 0)) });
    spo2ByDay.push({ date, value: Math.round((96 + rand() * 1.8) * 10) / 10 });
    if (day % 2 === 1) {
      const weight = 72.4 - day * 0.02 + rand() * 0.5;
      weightByDay.push({ date, weight: Math.round(weight * 10) / 10 });
    }
  }

  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  return {
    dateRange: { start: "2025-02-01", end: "2025-02-28" },
    sleep: {
      avgDuration: Math.round(avg(sleepByDay.map((d) => d.duration))),
      avgEfficiency: Math.round(avg(sleepByDay.map((d) => d.efficiency))),
      avgBedtime: 23.1,
      avgWakeTime: 7.0,
      avgScore: Math.round(avg(sleepByDay.map((d) => d.score))),
      nightsTracked: sleepByDay.length,
      byDay: sleepByDay,
      naps: [],
    },
    heart: {
      avgRestingHR: Math.round(avg(heartByDay.map((d) => d.restingHR))),
      byDay: heartByDay,
      rollingBaseline: [],
    },
    hrv: {
      avgRmssd: Math.round(avg(hrvByDay.map((d) => d.rmssd))),
      byDay: hrvByDay,
      rollingBaseline: [],
    },
    activity: {
      avgSteps: Math.round(avg(activityByDay.map((d) => d.steps))),
      totalSteps: activityByDay.reduce((a, d) => a + d.steps, 0),
      daysTracked: activityByDay.length,
      byDay: activityByDay,
    },
    spo2: {
      avgValue: Math.round(avg(spo2ByDay.map((d) => d.value)) * 10) / 10,
      byDay: spo2ByDay,
      rollingBaseline: [],
    },
    weight: {
      latest: weightByDay[weightByDay.length - 1].weight,
      change: -0.6,
      measurements: weightByDay.length,
      byDay: weightByDay,
    },
  };
}

// ---------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------

function monthlySeries(startYear: number, startMonth: number, startCount: number, monthlyGains: number[]) {
  const series = [];
  let count = startCount;
  for (let i = 0; i < monthlyGains.length; i++) {
    const d = new Date(Date.UTC(startYear, startMonth - 1 + i, 15));
    count += monthlyGains[i];
    series.push({ date: d.toISOString().slice(0, 10), count });
  }
  return series;
}

function buildMusic() {
  const playlists = [
    {
      playlistId: "pl-slow-orbit",
      name: "slow orbit",
      imageUrl: ART.dusk,
      createdDate: "2022-05-14",
      series: monthlySeries(2023, 10, 310, [6, 9, 14, -3, 18, 22, 17, 25, 31, -8, 28, 35, 30, 26, 33, 41, 38]),
    },
    {
      playlistId: "pl-kitchen-radio",
      name: "kitchen radio",
      imageUrl: ART.ember,
      createdDate: "2023-11-02",
      series: monthlySeries(2023, 12, 180, [4, 7, -2, 12, 9, 15, 11, 14, 19, 16, -5, 18, 25, 21, 27]),
    },
    {
      playlistId: "pl-deep-focus",
      name: "deep focus, allegedly",
      imageUrl: ART.slate,
      createdDate: "2024-02-20",
      series: monthlySeries(2024, 3, 96, [2, 5, 3, 8, -4, 9, 12, 7, 11, 15, 10, 14]),
    },
    {
      playlistId: "pl-crag-mix",
      name: "van songs (ridge edition)",
      imageUrl: ART.moss,
      createdDate: "2024-06-08",
      series: monthlySeries(2024, 7, 64, [1, 3, 2, 5, -1, 7, 3, 6]),
    },
  ].map((p) => ({
    playlistId: p.playlistId,
    name: p.name,
    imageUrl: p.imageUrl,
    latestCount: p.series[p.series.length - 1].count,
    latestDate: p.series[p.series.length - 1].date,
    firstDate: p.series[0].date,
    createdDate: p.createdDate,
    observations: p.series.length,
    series: p.series,
  }));

  const friends = [
    {
      eventId: 9001,
      person: PEOPLE.rowan.id,
      spotifyId: "rowan-demo",
      contactId: 2,
      name: "Rowan",
      avatarUrl: null,
      timestamp: "2025-03-07T21:12:00.000Z",
      trackName: "Glass Rain",
      artistName: "Field Atlas",
      albumName: "Weather Systems",
      imageUrl: ART.dusk,
    },
    {
      eventId: 9002,
      person: PEOPLE.priya.id,
      spotifyId: "priya-demo",
      contactId: 3,
      name: "Priya",
      avatarUrl: null,
      timestamp: "2025-03-07T20:48:00.000Z",
      trackName: "Meridian",
      artistName: "Marrow Theory",
      albumName: "Perihelion",
      imageUrl: ART.mist,
    },
    {
      eventId: 9003,
      person: PEOPLE.sam.id,
      spotifyId: "sam-demo",
      contactId: 4,
      name: "Sam",
      avatarUrl: null,
      timestamp: "2025-03-07T18:03:00.000Z",
      trackName: "Signal Fire",
      artistName: "Cassette Skyline",
      albumName: "Departures",
      imageUrl: ART.gold,
    },
  ];

  // Four weeks of listening ending on the showcase day.
  const catalogue = [
    { track: "Signal Fire", artist: "Cassette Skyline", album: "Departures", art: ART.gold, plays: 34 },
    { track: "Glass Rain", artist: "Field Atlas", album: "Weather Systems", art: ART.dusk, plays: 29 },
    { track: "Meridian", artist: "Marrow Theory", album: "Perihelion", art: ART.mist, plays: 26 },
    { track: "Golden Hour", artist: "Cassette Skyline", album: "Departures", art: ART.ember, plays: 23 },
    { track: "Paper Lanterns", artist: "Hollow Pines", album: "Small Fires", art: ART.rose, plays: 21 },
    { track: "Slow Orbit", artist: "Marrow Theory", album: "Perihelion", art: ART.slate, plays: 18 },
    { track: "North Sea", artist: "Cassette Skyline", album: "Departures", art: ART.tide, plays: 16 },
    { track: "Low Light", artist: "Field Atlas", album: "Weather Systems", art: ART.moss, plays: 14 },
    { track: "Night Ferry", artist: "Hollow Pines", album: "Small Fires", art: ART.rose, plays: 12 },
    { track: "Afterglow", artist: "Marrow Theory", album: "Perihelion", art: ART.rose, plays: 11 },
  ];
  const trackMs = 214_000;
  const topTracks = catalogue.map((t, i) => ({
    rank: i + 1,
    trackName: t.track,
    artistName: t.artist,
    albumName: t.album,
    trackUri: `spotify:track:showcase-${i + 1}`,
    imageUrl: t.art,
    playCount: t.plays,
    listeningMs: t.plays * trackMs,
    lastPlayedAt: new Date(Date.UTC(2025, 2, 7, 16, 50) - i * 9 * 3_600_000).toISOString(),
    eventId: 9100 + i,
  }));

  const artistTotals = new Map<string, { plays: number; latest: (typeof catalogue)[number]; index: number }>();
  catalogue.forEach((t, index) => {
    const current = artistTotals.get(t.artist);
    if (current) current.plays += t.plays;
    else artistTotals.set(t.artist, { plays: t.plays, latest: t, index });
  });
  const topArtists = [...artistTotals.entries()]
    .sort((a, b) => b[1].plays - a[1].plays)
    .map(([artistName, { plays, latest, index }], i) => ({
      rank: i + 1,
      artistName,
      playCount: plays,
      listeningMs: plays * trackMs,
      lastPlayedAt: topTracks[index].lastPlayedAt,
      latestTrackName: latest.track,
      latestTrackUri: topTracks[index].trackUri,
      imageUrl: latest.art,
      eventId: topTracks[index].eventId,
    }));

  const totalPlays = 487;
  const rankings = {
    period: "4w",
    periodStart: "2025-02-07T21:30:00.000Z",
    totalPlays,
    listeningMs: totalPlays * trackMs,
    firstPlayedAt: "2025-02-07T22:04:00.000Z",
    lastPlayedAt: "2025-03-07T16:50:22.000Z",
    // The ranked list scrolls past eight rows; stop there so the shot ends cleanly.
    topTracks: topTracks.slice(0, 8),
    topArtists,
  };

  const recentPlays: Array<[string, number]> = [
    ["2025-03-07T16:50:22.000Z", 2],
    ["2025-03-07T16:45:56.000Z", 9],
    ["2025-03-07T16:41:08.000Z", 5],
    ["2025-03-07T07:47:30.000Z", 0],
    ["2025-03-07T07:43:55.000Z", 7],
    ["2025-03-07T07:39:12.000Z", 1],
    ["2025-03-07T07:35:41.000Z", 6],
    ["2025-03-07T07:32:04.000Z", 3],
    ["2025-03-06T22:18:40.000Z", 8],
    ["2025-03-06T22:14:02.000Z", 4],
    ["2025-03-06T19:05:11.000Z", 1],
    ["2025-03-06T18:59:47.000Z", 0],
  ];
  const recent = recentPlays.map(([timestamp, index], i) => ({
    eventId: 9200 + i,
    timestamp,
    trackName: catalogue[index].track,
    artistName: catalogue[index].artist,
    albumName: catalogue[index].album,
    trackUri: topTracks[index].trackUri,
    imageUrl: catalogue[index].art,
  }));

  return {
    playlists: { playlists },
    friends: { friends },
    rankings,
    recent: { recent },
  };
}

// ---------------------------------------------------------------------------
// Search: "aurora" across sources
// ---------------------------------------------------------------------------

function buildSearchResults() {
  nextEventId = 700;
  const events = [
    event("discord", "message:group", "2025-02-27T22:41:09.000Z", {
      title: "weekend hike 🥾",
      content: "did anyone else see the aurora tonight?? whole sky went green for a bit",
      people: [PEOPLE.rowan.id],
      conversation_id: HIKE_CONVERSATION_ID,
    }),
    event("claude", "claude:message:assistant", "2025-02-27T23:02:51.000Z", {
      title: "Aurora photography settings",
      content: "For aurora on a mirrorless camera: start around ISO 3200, f/2.8, 4–8s exposure, manual focus on a bright star…",
      conversation_id: "cl-aurora",
    }),
    event("google-search", "google:search", "2025-02-27T22:38:02.000Z", {
      title: "aurora forecast tonight",
    }),
    event("chrome", "browse", "2025-02-27T22:38:40.000Z", {
      title: "Aurora watch — current geomagnetic activity",
      content: "https://example.com/aurora-watch",
    }),
    spotifyTrack("2025-01-19T09:12:00.000Z", "Aurora", "Field Atlas", "Weather Systems", ART.tide),
    event("youtube", "youtube:watch", "2024-11-02T20:15:00.000Z", {
      title: "Chasing the aurora across a frozen lake — 4K",
      content: "Fjord & Field",
      people: ["name:Fjord & Field"],
    }),
    event("swarm", "location:visit", "2025-02-27T21:55:00.000Z", {
      location_name: "Corvid Edge",
      title: "Checked in at Corvid Edge",
      content: "aurora spotting 🌌",
      tags: ["Scenic Lookout"],
      latitude: 47.594,
      longitude: -31.517,
    }),
  ];
  return { events, count: 61, nextCursor: null };
}

// ---------------------------------------------------------------------------
// Shared API scaffolding
// ---------------------------------------------------------------------------

const stats = {
  total_events: 1_847_203,
  sources: [
    { source: "wakatime", type: "code:session", count: 812_400 },
    { source: "facebook", type: "message", count: 704_120 },
    { source: "spotify", type: "listen:track", count: 207_331 },
    { source: "discord", type: "message:group", count: 54_209 },
  ],
  date_range: { earliest: "2009-06-14T09:00:00.000Z", latest: "2025-03-07T21:29:00.000Z" },
};

function baseResponses(): Record<string, unknown> {
  const music = buildMusic();
  const day = buildDayEvents();
  return {
    "/api/auth/status": { authenticated: true, authEnabled: true },
    "/api/stats": stats,
    "/api/day": day,
    [`/api/day/${DAY}/health`]: dayHealth,
    "/api/timeline/date-index": buildDateIndex(day.summary.totalEvents),
    "/api/health/stats": buildHealthStats(),
    "/api/health/biomarkers": { biomarkers: [] },
    "/api/playlists": music.playlists,
    "/api/music/friends/latest": music.friends,
    "/api/music/rankings": music.rankings,
    "/api/music/recent": music.recent,
    "/api/search": buildSearchResults(),
    "/api/conversations/sources": { sources: ["discord", "claude", "facebook", "phone"] },
    "/api/contacts": {
      contacts: Object.values(PEOPLE).map((p, i) => ({
        id: i + 1,
        display_name: p.name,
        notes: null,
        date_of_birth: null,
        hidden: 0,
        is_self: p === PEOPLE.me ? 1 : 0,
        created_at: "2024-01-01T09:00:00.000Z",
        updated_at: "2025-03-01T09:00:00.000Z",
        identityCount: 2,
        eventCount: [1_204, 3_411, 2_876, 1_530][i] ?? 500,
        avatarUrl: null,
      })),
    },
  };
}

async function mockApi(page: Page): Promise<string[]> {
  const unexpectedRequests: string[] = [];
  const responses = baseResponses();
  const conversation = buildConversation();

  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (request.method() === "POST" && pathname === "/api/identities/resolve") {
      const body = request.postDataJSON() as { identifiers: string[] };
      const resolved = Object.fromEntries(
        body.identifiers.map((id) => [
          id,
          RESOLVED_IDENTITIES[id] ?? { name: null, username: null, contactId: null, avatarUrl: null },
        ]),
      );
      await route.fulfill({ json: { resolved } });
      return;
    }

    if (request.method() === "GET" && pathname === "/api/conversation") {
      const params = new URL(request.url()).searchParams;
      // Older pages are requested newest-first ("desc"), newer ones oldest-first
      // ("asc"); the view polls for newer messages while it is open.
      const page = !params.has("cursor")
        ? conversation.page
        : params.get("order") === "asc"
          ? conversation.newerPage
          : conversation.olderPage;
      await route.fulfill({ json: page });
      return;
    }
    if (request.method() === "GET" && pathname === "/api/conversation/stats") {
      await route.fulfill({ json: conversation.stats });
      return;
    }

    const response = responses[pathname];
    if (request.method() !== "GET" || response === undefined) {
      unexpectedRequests.push(`${request.method()} ${pathname}`);
      await route.fulfill({
        status: 500,
        json: { error: `Unexpected showcase request: ${request.method()} ${pathname}` },
      });
      return;
    }
    await route.fulfill({ json: response });
  });

  return unexpectedRequests;
}

interface ShotProblems {
  unexpectedRequests: string[];
  browserErrors: string[];
}

async function openApp(page: Page, path: string): Promise<ShotProblems> {
  const unexpectedRequests = await mockApi(page);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  // Shots must be reproducible offline: anything leaving the preview server fails.
  const { baseURL } = test.info().project.use;
  if (!baseURL) throw new Error("The showcase config must set use.baseURL");
  const previewOrigin = new URL(baseURL).origin;
  await page.route(
    (url) => url.origin !== previewOrigin,
    async (route) => {
      unexpectedRequests.push(`${route.request().method()} ${route.request().url()}`);
      await route.abort();
    },
  );
  await page.clock.setFixedTime(NOW);
  await page.goto(path);
  return { unexpectedRequests, browserErrors };
}

// Panels that load independently and have no aria-busy state get a content
// assertion in their shot; the sidebar's event total appears in every shot.
async function settle(page: Page, problems: ShotProblems): Promise<void> {
  await expect(page.getByText(`${stats.total_events.toLocaleString("en-GB")} events`, { exact: true })).toBeVisible();
  await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  expect(problems.unexpectedRequests).toEqual([]);
  expect(problems.browserErrors).toEqual([]);
}

/** Saves the README image, then fails on anything that went wrong while capturing. */
async function capture(page: Page, problems: ShotProblems, name: string): Promise<void> {
  await page.screenshot({ path: resolve(OUTPUT_DIR, name) });
  expect(problems.unexpectedRequests).toEqual([]);
  expect(problems.browserErrors).toEqual([]);
}

// ---------------------------------------------------------------------------
// The shots
// ---------------------------------------------------------------------------

test("day timeline", async ({ page }) => {
  const problems = await openApp(page, `/?date=${DAY}`);

  await expect(page.getByRole("heading", { name: "Friday, 7 March 2025", level: 1 })).toBeVisible();
  await expect(page.getByText(dayHealth.activity.steps.toLocaleString("en-GB"))).toBeVisible();
  await expect(page.getByText("weekend hike 🥾").first()).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Date navigation" }).getByText("February 2025", { exact: true }),
  ).toBeVisible();
  await settle(page, problems);

  await capture(page, problems, "timeline-day.png");
});

test("conversation", async ({ page }) => {
  const problems = await openApp(
    page,
    `/conversation/discord/${encodeURIComponent(HIKE_CONVERSATION_ID)}`,
  );

  await expect(page.getByText("see everyone at 8:30 sharp ⛰️")).toBeVisible();
  await expect(page.getByText("End of conversation")).toBeVisible();
  await expect(page.getByText("1,284")).toBeVisible();
  // The older page loads on open; wait for it so the prepend doesn't land mid-shot.
  await expect(page.getByText("12 messages loaded")).toBeVisible();
  await expect(page.getByText("Loading older messages...")).toHaveCount(0);
  await settle(page, problems);

  await capture(page, problems, "conversation.png");
});

test("health dashboard", async ({ page }) => {
  const problems = await openApp(page, "/health?view=month&mode=calendar&anchor=2025-02-01");

  await expect(page.getByRole("heading", { name: "Health Dashboard", level: 1 })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
  await settle(page, problems);

  await capture(page, problems, "health.png");
});

test("music", async ({ page }) => {
  const problems = await openApp(page, "/music");

  await expect(page.getByRole("heading", { name: "Music", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /slow orbit/ })).toBeVisible();
  await expect(page.getByText("487", { exact: true })).toBeVisible(); // rankings
  await expect(page.getByText("Afterglow", { exact: true })).toBeVisible(); // recent plays
  await expect(page.getByText("Rowan", { exact: true })).toBeVisible(); // friends
  await settle(page, problems);

  await capture(page, problems, "music.png");
});

test("search", async ({ page }) => {
  const problems = await openApp(page, "/search?q=aurora");

  await expect(page.getByText("aurora spotting 🌌")).toBeVisible();
  await settle(page, problems);

  await capture(page, problems, "search.png");
});
