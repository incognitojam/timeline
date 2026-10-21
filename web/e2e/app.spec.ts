import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AttachmentListItem, SyncSourceInfo } from "../src/lib/api";
import type { TimelineEvent } from "../src/lib/types";

test.describe.configure({ mode: "parallel" });

const chartSweep = process.env.PLAYWRIGHT_CHART_SWEEP ?? "full";
if (chartSweep !== "smoke" && chartSweep !== "full") {
  throw new Error("PLAYWRIGHT_CHART_SWEEP must be smoke or full");
}

const TEST_DATE = "2025-01-15";

function conversationEvent(
  id: number,
  timestamp: string,
  person: "alice" | "bob",
  content: string | null,
  overrides: Partial<TimelineEvent> = {},
): TimelineEvent {
  return {
    id,
    source: "discord",
    source_id: `message-${id}`,
    source_account: "example",
    type: "message:group",
    timestamp,
    end_timestamp: null,
    duration_ms: null,
    title: "Study Group",
    content,
    latitude: null,
    longitude: null,
    location_name: null,
    people: JSON.stringify([`discord:${person}`]),
    tags: null,
    raw_data: "{}",
    imported_at: timestamp,
    import_batch: "playwright-conversation",
    conversation_id: "study-group",
    ...overrides,
  };
}

const conversationEvents = [
  conversationEvent(1001, "2025-01-15T09:00:00.000Z", "alice", "Morning! Are we still meeting at the library?"),
  conversationEvent(1002, "2025-01-15T09:01:00.000Z", "alice", "I can bring the notes from last week."),
  conversationEvent(1003, "2025-01-15T09:04:00.000Z", "bob", "Yes — the quiet room is booked for ten.", {
    version_count: 1,
    raw_data: JSON.stringify({
      reactions: [{ emoji: { name: "👍" }, count: 3, users: [{ id: "alice", name: "Alice" }] }],
    }),
  }),
  conversationEvent(1004, "2025-01-15T09:06:00.000Z", "alice", "Perfect, I’ll meet you there.", {
    replied_to: {
      event_id: 1003,
      conversation_id: "study-group",
      author_name: "Bob",
      content: "Yes — the quiet room is booked for ten.",
      has_attachment: false,
    },
  }),
  conversationEvent(1005, "2025-01-15T09:12:00.000Z", "bob", null, {
    type: "message:group:forward",
    raw_data: JSON.stringify({
      message_snapshots: [{ message: { content: "The reading list is in the shared folder." } }],
    }),
  }),
  conversationEvent(1006, "2025-01-15T09:16:00.000Z", "alice", "[photo]", {
    type: "message:group:photo",
  }),
  conversationEvent(1008, "2025-01-15T09:25:00.000Z", "alice", null, {
    type: "message:group:call",
    raw_data: JSON.stringify({
      call: { participants: ["alice"], ended_timestamp: "2025-01-15T09:25:12.000Z" },
    }),
  }),
  conversationEvent(1009, "2025-01-15T09:30:00.000Z", "bob", "I removed the old room number so nobody gets lost.", {
    source_deleted_observed_at: "2025-01-15T11:00:00.000Z",
  }),
];

function searchEvent(
  id: number,
  source: string,
  type: string,
  timestamp: string,
  title: string,
  content: string,
): TimelineEvent {
  return {
    id,
    source,
    source_id: `search-${id}`,
    source_account: "example",
    type,
    timestamp,
    end_timestamp: null,
    duration_ms: null,
    title,
    content,
    latitude: null,
    longitude: null,
    location_name: null,
    people: null,
    tags: null,
    raw_data: "{}",
    imported_at: timestamp,
    import_batch: "playwright-search",
    conversation_id: null,
  };
}

const searchEvents = [
  searchEvent(
    2001,
    "google-calendar",
    "event",
    "2025-01-15T10:00:00.000Z",
    "Library study session",
    "Quiet room on the second floor",
  ),
  searchEvent(
    2002,
    "google-search",
    "google:search",
    "2025-01-14T18:42:00.000Z",
    "Search",
    "city library winter opening hours",
  ),
  searchEvent(
    2003,
    "google-keep",
    "note:list",
    "2025-01-12T09:15:00.000Z",
    "Library reading list",
    "The Left Hand of Darkness, Kindred, Piranesi",
  ),
];

const timelineSourceIconEvents = [
  searchEvent(
    2101,
    "youtube",
    "youtube:watch",
    "2025-01-15T09:05:00.000Z",
    "How suspension bridges stay standing",
    "Example Engineering",
  ),
  searchEvent(
    2102,
    "manual",
    "note",
    "2025-01-15T09:25:00.000Z",
    "Bring a notebook",
    "Sketch the key ideas after the talk.",
  ),
  searchEvent(
    2103,
    "spotify-friends",
    "listen:track:friend",
    "2025-01-15T09:45:00.000Z",
    "Night Drive",
    "Night Drive by Example Artist",
  ),
  searchEvent(
    2104,
    "example-source",
    "bookmark",
    "2025-01-15T10:05:00.000Z",
    "Reading list",
    "A source without a registered icon uses the neutral fallback.",
  ),
];

function attachmentItem(
  id: number,
  asset: string,
  source: string,
  timestamp: string,
  description: string,
): AttachmentListItem {
  return {
    id,
    eventId: id - 1_000,
    source,
    filename: `${asset}.jpg`,
    mimeType: "image/jpeg",
    fileSize: id * 1_000,
    width: 1_600,
    height: 1_200,
    durationMs: null,
    storagePath: `playwright/${asset}.svg`,
    thumbhash: null,
    contentHash: `attachment-${id}`,
    status: "stored",
    timestamp,
    description,
    descriptionModel: "example/vision-small",
  };
}

const attachmentItems = [
  attachmentItem(
    3001,
    "coastal-path",
    "discord",
    "2025-01-15T11:30:00.000Z",
    "A winding coastal path beside blue water",
  ),
  attachmentItem(
    3002,
    "market-stall",
    "facebook",
    "2025-01-15T10:15:00.000Z",
    "Colourful fruit arranged at a market stall",
  ),
  attachmentItem(
    3003,
    "mountain-lake",
    "instagram",
    "2025-01-14T16:00:00.000Z",
    "A still lake beneath purple mountains",
  ),
  attachmentItem(
    3004,
    "desk-plants",
    "discord",
    "2025-01-13T13:20:00.000Z",
    "House plants casting shadows across a desk",
  ),
  attachmentItem(
    3005,
    "evening-train",
    "sms",
    "2025-01-12T19:45:00.000Z",
    "A train crossing the landscape at sunset",
  ),
  attachmentItem(
    3006,
    "ceramic-cups",
    "facebook",
    "2025-01-11T12:00:00.000Z",
    "Handmade ceramic cups on a wooden shelf",
  ),
  attachmentItem(
    3007,
    "garden-gate",
    "discord",
    "2025-01-10T08:35:00.000Z",
    "A green gate opening into a flower garden",
  ),
  attachmentItem(
    3008,
    "city-lights",
    "instagram",
    "2025-01-09T21:10:00.000Z",
    "City lights reflected in the river at night",
  ),
] satisfies AttachmentListItem[];

const attachmentMedia: Record<string, string> = {
  "/api/media/playwright/coastal-path.svg": `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#8fc7d8"/><path d="M0 245L115 180l90 55 88-92 107 84v173H0z" fill="#486b63"/><path d="M0 305c115-68 174-31 260-112 34-32 76-41 140-24v231H0z" fill="#d8b878"/><path d="M122 400c14-82 57-115 134-164" fill="none" stroke="#f4e9c9" stroke-width="25"/>
    </svg>`,
  "/api/media/playwright/market-stall.svg": `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#27334b"/><path d="M45 115h310l-28-58H73z" fill="#eab464"/><path d="M64 115h272v228H64z" fill="#89543d"/><g fill="#f17c67"><circle cx="122" cy="238" r="34"/><circle cx="184" cy="230" r="31"/></g><g fill="#e6c653"><circle cx="251" cy="232" r="32"/><circle cx="290" cy="277" r="29"/></g><path d="M85 318h230" stroke="#e9d9b5" stroke-width="18"/>
    </svg>`,
  "/api/media/playwright/mountain-lake.svg": `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#d5b4ce"/><circle cx="310" cy="80" r="38" fill="#f7dda5"/><path d="M0 245L116 104l72 92 68-126 144 175z" fill="#675978"/><path d="M0 245h400v155H0z" fill="#557e88"/><path d="M0 310c95-30 165 25 247-10 64-27 103-20 153-4" fill="none" stroke="#8db7b5" stroke-width="16"/>
    </svg>`,
  "/api/media/playwright/desk-plants.svg": `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#e7d3b0"/><path d="M0 282h400v118H0z" fill="#8c5f47"/><path d="M182 290h86l-12 78h-62z" fill="#bd7256"/><g fill="#53765b"><ellipse cx="210" cy="225" rx="33" ry="72" transform="rotate(-34 210 225)"/><ellipse cx="258" cy="220" rx="30" ry="76" transform="rotate(30 258 220)"/><ellipse cx="235" cy="178" rx="27" ry="73"/></g><path d="M38 282L250 45M112 282L320 50" stroke="#9f8d73" stroke-width="12" opacity=".32"/>
    </svg>`,
  "/api/media/playwright/evening-train.svg": `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#dd765f"/><circle cx="305" cy="94" r="45" fill="#ffd27d"/><path d="M0 230l120-80 90 70 90-100 100 110v170H0z" fill="#513f55"/><path d="M-20 291h440" stroke="#272838" stroke-width="22"/><path d="M62 215h260v83H62z" fill="#e4c6a1"/><g fill="#5b7890"><rect x="84" y="235" width="48" height="30"/><rect x="151" y="235" width="48" height="30"/><rect x="218" y="235" width="48" height="30"/></g><circle cx="112" cy="307" r="21" fill="#24232d"/><circle cx="272" cy="307" r="21" fill="#24232d"/>
    </svg>`,
  "/api/media/playwright/ceramic-cups.svg": `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#97a99c"/><path d="M0 304h400v96H0z" fill="#795848"/><path d="M80 160h92v130H80z" fill="#d78e71"/><path d="M172 188h31c42 0 42 62 0 62h-31" fill="none" stroke="#d78e71" stroke-width="22"/><path d="M230 190h92v100h-92z" fill="#e9d5a6"/><path d="M322 207h20c34 0 34 48 0 48h-20" fill="none" stroke="#e9d5a6" stroke-width="18"/>
    </svg>`,
  "/api/media/playwright/garden-gate.svg": `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#a9c9a6"/><g fill="#f2b5b0"><circle cx="66" cy="90" r="28"/><circle cx="332" cy="125" r="31"/><circle cx="74" cy="316" r="35"/></g><g fill="#f2d48b"><circle cx="115" cy="128" r="23"/><circle cx="315" cy="300" r="34"/></g><path d="M140 95h120v305H140z" fill="#416957"/><path d="M161 95v305M200 95v305M239 95v305" stroke="#9cc09e" stroke-width="9"/><path d="M140 188h120M140 292h120" stroke="#9cc09e" stroke-width="12"/>
    </svg>`,
  "/api/media/playwright/city-lights.svg": `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
      <rect width="400" height="400" fill="#18243d"/><circle cx="312" cy="72" r="30" fill="#e8dcaa"/><path d="M28 100h65v183H28zM105 155h74v128h-74zM192 78h74v205h-74zM280 135h92v148h-92z" fill="#324661"/><g fill="#e9ba69"><path d="M45 128h12v18H45zM68 128h12v18H68zM45 168h12v18H45zM215 108h14v20h-14zM239 108h14v20h-14zM304 166h15v21h-15zM335 166h15v21h-15z"/></g><path d="M0 283h400v117H0z" fill="#263e54"/><path d="M40 310h300M92 348h250" stroke="#d7a558" stroke-width="9" opacity=".48"/>
    </svg>`,
};

const syncHistoryEntry = {
  id: 1,
  job_id: null,
  source: "discord",
  started_at: "2025-01-15 11:45:00",
  finished_at: "2025-01-15 11:45:04",
  success: 1,
  skipped: 0,
  events_added: 12,
  events_updated: 3,
  error: null,
  duration_ms: 4_200,
  metadata: JSON.stringify({ channels: 3 }),
};

const healthStats = {
  dateRange: { start: "2025-01-01", end: "2025-01-31" },
  sleep: {
    avgDuration: 27_000_000,
    avgEfficiency: 90,
    avgBedtime: 22.5,
    avgWakeTime: 6.5,
    avgScore: 82,
    nightsTracked: 3,
    byDay: [
      {
        date: "2025-01-13",
        duration: 26_100_000,
        efficiency: 88,
        startTime: "2025-01-12T22:45:00.000Z",
        endTime: "2025-01-13T06:00:00.000Z",
        score: 78,
      },
      {
        date: "2025-01-14",
        duration: 27_000_000,
        efficiency: 90,
        startTime: "2025-01-13T22:30:00.000Z",
        endTime: "2025-01-14T06:00:00.000Z",
        score: 82,
      },
      {
        date: "2025-01-15",
        duration: 27_900_000,
        efficiency: 92,
        startTime: "2025-01-14T22:15:00.000Z",
        endTime: "2025-01-15T06:00:00.000Z",
        score: 86,
      },
    ],
    naps: [],
  },
  heart: {
    avgRestingHR: 61,
    byDay: [
      { date: "2025-01-13", restingHR: 63 },
      { date: "2025-01-14", restingHR: 61 },
      { date: "2025-01-15", restingHR: 59 },
    ],
    rollingBaseline: [],
  },
  hrv: {
    avgRmssd: 45,
    byDay: [
      { date: "2025-01-13", rmssd: 41 },
      { date: "2025-01-14", rmssd: 45 },
      { date: "2025-01-15", rmssd: 49 },
    ],
    rollingBaseline: [],
  },
  activity: {
    avgSteps: 8_000,
    totalSteps: 24_000,
    daysTracked: 3,
    byDay: [
      { date: "2025-01-13", steps: 6_500 },
      { date: "2025-01-14", steps: 8_000 },
      { date: "2025-01-15", steps: 9_500 },
    ],
  },
  spo2: {
    avgValue: 97.4,
    byDay: [
      { date: "2025-01-13", value: 97.1 },
      { date: "2025-01-14", value: 97.4 },
      { date: "2025-01-15", value: 97.7 },
    ],
    rollingBaseline: [],
  },
  weight: {
    latest: 70.2,
    change: -0.3,
    measurements: 2,
    byDay: [
      { date: "2025-01-13", weight: 70.5 },
      { date: "2025-01-15", weight: 70.2 },
    ],
  },
};

const healthYearStats = {
  ...healthStats,
  dateRange: { start: "2025-09-01", end: "2026-08-12" },
  sleep: {
    ...healthStats.sleep,
    nightsTracked: 12,
    byDay: [
      { date: "2025-09-15", duration: 25_200_000, efficiency: 88, score: 78 },
      { date: "2025-10-15", duration: 25_920_000, efficiency: 89, score: 79 },
      { date: "2025-11-15", duration: 26_640_000, efficiency: 90, score: 80 },
      { date: "2025-12-15", duration: 27_360_000, efficiency: 91, score: 81 },
      { date: "2026-01-15", duration: 26_280_000, efficiency: 89, score: 80 },
      { date: "2026-02-15", duration: 27_000_000, efficiency: 90, score: 82 },
      { date: "2026-03-15", duration: 27_720_000, efficiency: 91, score: 83 },
      { date: "2026-04-15", duration: 28_440_000, efficiency: 92, score: 84 },
      { date: "2026-05-15", duration: 27_900_000, efficiency: 91, score: 83 },
      { date: "2026-06-15", duration: 27_180_000, efficiency: 90, score: 82 },
      { date: "2026-07-15", duration: 26_820_000, efficiency: 89, score: 81 },
      { date: "2026-08-15", duration: 26_460_000, efficiency: 88, score: 80 },
    ],
  },
};

const apiResponses: Record<string, unknown> = {
  "/api/auth/status": {
    authenticated: true,
    authEnabled: false,
  },
  "/api/stats": {
    total_events: 0,
    sources: [],
    date_range: { earliest: null, latest: null },
  },
  "/api/search": {
    events: searchEvents,
    count: searchEvents.length,
    nextCursor: null,
  },
  "/api/attachments": {
    attachments: attachmentItems,
    nextCursor: null,
  },
  "/api/attachments/stats": {
    total: 1_284,
    byStatus: { pending: 3, stored: 1_278, failed: 2, unrecoverable: 1 },
    distinctHashes: 1_196,
    descriptionEligibleHashes: 842,
    describedHashes: 731,
    needingDescription: 111,
    byModel: [
      { model: "example/vision-small", count: 604 },
      { model: "example/vision-large", count: 127 },
    ],
    bySource: [
      { source: "discord", count: 438 },
      { source: "facebook", count: 361 },
      { source: "instagram", count: 176 },
      { source: "recall", count: 200 },
      { source: "sms", count: 109 },
    ],
  },
  "/api/attachments/description-history": {
    points: [
      {
        date: "2024-10-01",
        queueDepth: 212,
        descriptionEligibleHashes: null,
        describedHashes: null,
        described: 15,
        skipped: 2,
        failed: 1,
        runs: 1,
        failedRuns: 0,
        deferredRuns: 0,
      },
      {
        date: "2024-11-01",
        queueDepth: 191,
        descriptionEligibleHashes: null,
        describedHashes: null,
        described: 22,
        skipped: 1,
        failed: 0,
        runs: 2,
        failedRuns: 0,
        deferredRuns: 0,
      },
      {
        date: "2024-12-01",
        queueDepth: 155,
        descriptionEligibleHashes: 830,
        describedHashes: 686,
        described: 37,
        skipped: 3,
        failed: 2,
        runs: 2,
        failedRuns: 1,
        deferredRuns: 0,
      },
      {
        date: "2025-01-01",
        queueDepth: 128,
        descriptionEligibleHashes: 838,
        describedHashes: 711,
        described: 28,
        skipped: 2,
        failed: 0,
        runs: 2,
        failedRuns: 0,
        deferredRuns: 1,
      },
      {
        date: "2025-01-15",
        queueDepth: 111,
        descriptionEligibleHashes: 842,
        describedHashes: 731,
        described: 21,
        skipped: 1,
        failed: 1,
        runs: 1,
        failedRuns: 0,
        deferredRuns: 0,
      },
    ],
  },
  "/api/day": {
    date: TEST_DATE,
    centerTimestamp: `${TEST_DATE}T12:00:00.000Z`,
    events: [],
    attachments: {},
    summary: {
      totalEvents: 0,
      bySource: [],
      byType: [],
      timeRange: { earliest: null, latest: null },
    },
  },
  [`/api/day/${TEST_DATE}/health`]: {
    healthMetrics: {},
    outOfRangeCount: 0,
    totalMetricCount: 0,
  },
  "/api/day/2025-01-14/health": {
    healthMetrics: {},
    outOfRangeCount: 0,
    totalMetricCount: 0,
  },
  "/api/timeline/date-index": {
    dates: [
      {
        date: "2025-01-14",
        eventCount: 24,
      },
      {
        date: "2025-01-13",
        eventCount: 8,
      },
      // Far enough back to put a second month divider in the sidebar.
      {
        date: "2024-12-20",
        eventCount: 3,
      },
    ],
  },
  "/api/settings/network": {
    blockedNetworks: ["iPhone", "Train WiFi"],
  },
  "/api/releases/latest": {
    latest: {
      version: "0.9.0",
      url: "https://github.com/example/timeline/releases/tag/v0.9.0",
      publishedAt: "2025-01-14T12:00:00Z",
      notes: "## Changes\n\n- Faster timeline searches.\n- Clearer capture status.",
      downloadUrl: "https://github.com/example/timeline/releases/download/v0.9.0/Timeline-0.9.0-macos-arm64.dmg",
    },
    comparison: "update-available",
    checkedAt: "2025-01-15T12:00:00Z",
  },
  "/api/status": {
    service: {
      uptime: 14_400,
      startedAt: "2025-01-15T08:00:00.000Z",
      version: {
        version: "0.8.1",
        build: "10",
        commit: "1111111",
        commitFull: "1111111111111111111111111111111111111111",
        message: "Package the Timeline service",
        branch: "main",
        builtAt: "2025-01-15T07:30:00.000Z",
      },
    },
    database: {
      status: "ok",
      eventCount: 24,
    },
    scheduler: {
      enabled: true,
      sources: [
        {
          source: "discord",
          description: "Import Discord messages and reactions",
          enabled: true,
          isRunning: false,
          intervalMs: 3_600_000,
          lastRun: {
            time: "2025-01-15T11:45:00.000Z",
            success: true,
            skipped: false,
            isRunning: false,
            eventsAdded: 12,
            eventsUpdated: 3,
            error: null,
            durationMs: 4_200,
          },
          nextRunAt: "2025-01-15T12:45:00.000Z",
        },
      ],
    },
    inbox: {
      enabled: true,
      watchedDirs: ["/tmp/timeline-inbox"],
      sources: [
        {
          source: "discord",
          filesProcessed: 2,
          totalSize: 2_048,
          totalEvents: 24,
          lastProcessed: "2025-01-15 11:45:00",
          lastDetectedType: "discord",
        },
      ],
    },
    queue: [],
  },
  "/api/sync/sources": {
    sources: [
      {
        name: "discord",
        description: "Import Discord messages and reactions",
        configured: true,
        enabled: true,
        interval: "1h",
        effectiveInterval: "1h",
        effectiveIntervalMs: 3_600_000,
        defaultInterval: "30m",
        settings: {},
        settingsSchema: [],
      },
    ],
  },
  "/api/status/sync-history": {
    entries: [syncHistoryEntry],
    count: 1,
  },
  "/api/status/inbox-sources": {
    basePath: "/tmp/timeline-inbox",
    archivePath: null,
    sources: [
      {
        name: "discord",
        parser: "discord",
        account: "example",
        patterns: ["*.json"],
        enabled: true,
      },
    ],
  },
  "/api/contacts": {
    contacts: [
      {
        id: 1,
        display_name: "Alice",
        notes: null,
        date_of_birth: null,
        hidden: 0,
        is_self: 1,
        created_at: "2025-01-01T09:00:00.000Z",
        updated_at: "2025-01-15T09:00:00.000Z",
        identityCount: 2,
        eventCount: 18,
        avatarUrl: null,
      },
    ],
  },
  "/api/contacts/1": {
    contact: {
      id: 1,
      display_name: "Alice",
      notes: "Met through the local book club.",
      date_of_birth: "1990-01-01",
      hidden: 0,
      is_self: 1,
      created_at: "2025-01-01T09:00:00.000Z",
      updated_at: "2025-01-15T09:00:00.000Z",
    },
    identities: [
      {
        id: 1,
        platform: "discord",
        platform_id: "alice_example",
        display_name: "Alice",
        username: "alice_example",
        contact_id: 1,
        skipped: 0,
        first_seen: "2024-06-01T09:00:00.000Z",
        last_seen: "2025-01-15T10:30:00.000Z",
        avatar_url: null,
      },
      {
        id: 2,
        platform: "email",
        platform_id: "alice@example.com",
        display_name: "Alice",
        username: null,
        contact_id: 1,
        skipped: 0,
        first_seen: "2024-06-01T09:00:00.000Z",
        last_seen: "2025-01-15T10:30:00.000Z",
        avatar_url: null,
      },
    ],
    avatarUrl: null,
    memories: [
      {
        id: 1,
        contact_id: 1,
        content: "Enjoys science fiction novels.",
        created_at: "2025-01-10T09:00:00.000Z",
      },
    ],
  },
  "/api/contacts/1/events": {
    events: [],
    count: 0,
    nextCursor: null,
  },
  "/api/contacts/1/suggestions": {
    suggestions: [],
    count: 0,
  },
  "/api/contacts/1/spotify-summary": {
    summary: null,
  },
  "/api/contacts/1/conversations": {
    conversations: [],
  },
  "/api/identities/unlinked": {
    identities: [],
  },
  "/api/identities/skipped": {
    identities: [],
  },
  "/api/identities/link-suggestions": {
    suggestions: [],
  },
  "/api/conversations": {
    conversations: [
      {
        source: "discord",
        sourceAccount: "example",
        conversationId: "study-group",
        title: "Study Group",
        messageCount: 24,
        firstMessage: "2025-01-15T09:00:00.000Z",
        lastMessage: "2025-01-15T10:30:00.000Z",
      },
    ],
    total: 1,
  },
  "/api/conversations/sources": {
    sources: ["discord"],
  },
  "/api/conversation": {
    title: "Study Group",
    events: [...conversationEvents].reverse(),
    attachments: {},
    nextCursor: null,
    participants: {
      "discord:alice": { name: "Alice", contactId: 1, avatarUrl: null },
      "discord:bob": { name: "Bob", contactId: null, avatarUrl: null },
    },
    server: { source: "discord", id: "example-server", name: "Example University" },
  },
  "/api/conversation/stats": {
    totalMessages: conversationEvents.length,
    firstMessage: conversationEvents[0]?.timestamp,
    lastMessage: conversationEvents.at(-1)?.timestamp,
    firstEventId: conversationEvents[0]?.id,
    lastEventId: conversationEvents.at(-1)?.id,
    participants: [
      { identifier: "discord:alice", name: "Alice", contactId: 1, count: 4 },
      { identifier: "discord:bob", name: "Bob", contactId: null, count: 4 },
    ],
    attachmentCount: 0,
    activityByMonth: [{ month: "2025-01", count: conversationEvents.length }],
    titles: [],
    tokenUsage: null,
  },
  "/api/health/stats": healthStats,
  "/api/health/biomarkers": {
    biomarkers: [],
  },
  "/api/playlists": {
    playlists: [
      {
        playlistId: "focus-mix",
        name: "Focus Mix",
        imageUrl: null,
        latestCount: 128,
        latestDate: "2025-01-15",
        firstDate: "2024-01-15",
        createdDate: "2023-06-01",
        observations: 3,
        series: [
          { date: "2024-01-15", count: 100 },
          { date: "2024-07-15", count: 115 },
          { date: "2025-01-15", count: 128 },
        ],
      },
      {
        playlistId: "weekend-drive",
        name: "Weekend Drive",
        imageUrl: null,
        latestCount: 64,
        latestDate: "2025-01-14",
        firstDate: "2024-09-01",
        createdDate: "2024-08-15",
        observations: 2,
        series: [
          { date: "2024-09-01", count: 52 },
          { date: "2025-01-14", count: 64 },
        ],
      },
    ],
  },
  "/api/playlists/focus-mix": {
    playlistId: "focus-mix",
    name: "Focus Mix",
    imageUrl: null,
    createdDate: "2023-06-01",
    observations: [
      { date: "2024-01-15", count: 100, origin: "seed" },
      { date: "2024-07-15", count: 115, origin: "api" },
      { date: "2025-01-15", count: 128, origin: "api" },
    ],
  },
  "/api/music/rankings": {
    period: "4w",
    periodStart: "2024-12-18T12:00:00.000Z",
    totalPlays: 12,
    listeningMs: 0,
    firstPlayedAt: "2025-01-02T09:00:00.000Z",
    lastPlayedAt: "2025-01-15T10:00:00.000Z",
    topTracks: [
      {
        rank: 1,
        trackName: "Morning Light",
        artistName: "Example Artist",
        albumName: "Daybreak",
        trackUri: "spotify:track:morning-light",
        imageUrl: null,
        playCount: 7,
        listeningMs: 0,
        lastPlayedAt: "2025-01-15T10:00:00.000Z",
        eventId: 201,
      },
      {
        rank: 2,
        trackName: "Open Road",
        artistName: "Sample Band",
        albumName: "Sample Album",
        trackUri: "spotify:track:open-road",
        imageUrl: null,
        playCount: 5,
        listeningMs: 0,
        lastPlayedAt: "2025-01-14T18:30:00.000Z",
        eventId: 202,
      },
    ],
    topArtists: [
      {
        rank: 1,
        artistName: "Example Artist",
        playCount: 7,
        listeningMs: 0,
        lastPlayedAt: "2025-01-15T10:00:00.000Z",
        latestTrackName: "Morning Light",
        latestTrackUri: "spotify:track:morning-light",
        imageUrl: null,
        eventId: 201,
      },
    ],
  },
  "/api/music/recent": {
    recent: [
      {
        eventId: 201,
        timestamp: "2025-01-15T10:00:00.000Z",
        trackName: "Morning Light",
        artistName: "Example Artist",
        albumName: "Daybreak",
        trackUri: "spotify:track:morning-light",
        imageUrl: null,
      },
      {
        eventId: 202,
        timestamp: "2025-01-14T18:30:00.000Z",
        trackName: "Open Road",
        artistName: "Sample Band",
        albumName: "Sample Album",
        trackUri: "spotify:track:open-road",
        imageUrl: null,
      },
    ],
  },
  "/api/music/friends/latest": {
    friends: [
      {
        eventId: 101,
        person: "spotify:alice",
        spotifyId: "alice",
        contactId: 1,
        name: "Alice",
        avatarUrl: null,
        timestamp: "2025-01-15T10:00:00.000Z",
        trackName: "Morning Light",
        artistName: "Example Artist",
        albumName: "Daybreak",
        imageUrl: null,
      },
      {
        eventId: 102,
        person: "spotify:bob",
        spotifyId: "bob",
        contactId: null,
        name: "Bob",
        avatarUrl: null,
        timestamp: "2025-01-14T18:30:00.000Z",
        trackName: "Open Road",
        artistName: "Sample Band",
        albumName: "Sample Album",
        imageUrl: null,
      },
    ],
  },
};

async function mockApi(page: Page): Promise<string[]> {
  const unexpectedRequests: string[] = [];

  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const media = attachmentMedia[pathname];
    if (request.method() === "GET" && media !== undefined) {
      await route.fulfill({
        body: media,
        contentType: "image/svg+xml",
      });
      return;
    }
    const response = apiResponses[pathname];

    if (request.method() !== "GET" || response === undefined) {
      unexpectedRequests.push(`${request.method()} ${pathname}`);
      await route.fulfill({
        status: 500,
        json: { error: `Unexpected browser-test request: ${request.method()} ${pathname}` },
      });
      return;
    }

    await route.fulfill({ json: response });
  });

  return unexpectedRequests;
}

async function openApp(
  page: Page,
  path: string,
  options?: { fixedTime?: boolean },
): Promise<string[]> {
  const unexpectedRequests = await mockApi(page);
  if (options?.fixedTime !== false) {
    await page.clock.setFixedTime(new Date("2025-01-15T12:00:00.000Z"));
  }
  await page.goto(path);
  return unexpectedRequests;
}

async function expectAppReady(page: Page, unexpectedRequests: string[]): Promise<void> {
  await expect(page.getByRole("link", { name: "Timeline home" })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link")).toHaveCount(12);
  await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  expect(unexpectedRequests).toEqual([]);
}

async function expectChartsReady(page: Page): Promise<void> {
  const charts = page.locator("[data-chart]:visible");
  await expect(charts.first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
  await expect.poll(() => charts.evaluateAll((elements) => elements.length > 0 && elements.every((element) => {
    const canvases = [...element.querySelectorAll("canvas")];
    return element.getAttribute("aria-busy") === "false" && canvases.length > 0
      && canvases.every((canvas) => canvas.clientWidth === element.clientWidth && canvas.clientHeight === element.clientHeight);
  })), { message: "Visible charts must finish rendering at their current container size" }).toBe(true);
}

async function expectDisabledHoverStylesStable(button: Locator): Promise<void> {
  const styles = () => button.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      backgroundColor: computed.backgroundColor,
      color: computed.color,
    };
  });
  const before = await styles();
  await button.hover();
  await button.evaluate(async (element) => {
    await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
  });
  expect(await styles()).toEqual(before);
}

test("renders the app", async ({ page }) => {
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const unexpectedRequests = await openApp(page, `/?date=${TEST_DATE}`);

  await expect(page).toHaveTitle("Wed, 15 Jan 2025 · Timeline");
  await expect(page.getByRole("heading", { name: "Wednesday, 15 January 2025", level: 1 })).toBeVisible();
  await expect(page.getByText("No events for this day")).toBeVisible();
  await expect(page.locator('button[data-date="2025-01-14"]')).toBeVisible();
  await expect(page.locator('button[data-date="2025-01-13"]')).toBeVisible();
  const dateNavigation = page.getByRole("complementary", { name: "Date navigation" });
  await expect(dateNavigation.getByText("January 2025", { exact: true })).toBeVisible();
  await expect(dateNavigation.getByText("December 2024", { exact: true })).toBeVisible();
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("app-empty-state.png");
});

test("renders source icons on a populated timeline", async ({ page }) => {
  const unexpectedRequests = await mockApi(page);
  await page.route(
    (url) => url.pathname === "/api/day",
    async (route) => {
      await route.fulfill({
        json: {
          date: TEST_DATE,
          centerTimestamp: `${TEST_DATE}T12:00:00.000Z`,
          events: timelineSourceIconEvents,
          attachments: {},
          summary: {
            totalEvents: timelineSourceIconEvents.length,
            bySource: timelineSourceIconEvents.map((event) => ({ source: event.source, count: 1 })),
            byType: timelineSourceIconEvents.map((event) => ({ type: event.type, count: 1 })),
            timeRange: {
              earliest: timelineSourceIconEvents[0].timestamp,
              latest: timelineSourceIconEvents[timelineSourceIconEvents.length - 1].timestamp,
            },
          },
        },
      });
    },
  );
  await page.clock.setFixedTime(new Date("2025-01-15T12:00:00.000Z"));
  await page.goto(`/?date=${TEST_DATE}`);

  await expect(page.getByText("How suspension bridges stay standing")).toBeVisible();
  await expect(page.getByText("Bring a notebook")).toBeVisible();
  await expect(page.getByText("Night Drive", { exact: true })).toBeVisible();
  await expect(page.getByText("Reading list", { exact: true })).toBeVisible();
  await expect(page.locator(".timeline-section-content .source-icon svg")).toHaveCount(4);
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("timeline-source-icons.png");
});

test("renders the day vitals strip", async ({ page }) => {
  const unexpectedRequests = await mockApi(page);
  // Registered after mockApi so it wins the route match for the health payload.
  await page.route(
    (url) => url.pathname === `/api/day/${TEST_DATE}/health`,
    async (route) => {
      await route.fulfill({
        json: {
          date: TEST_DATE,
          hasData: true,
          activity: { steps: 9_500, caloriesOut: 2_450, activeMinutes: 42, floors: 12 },
          sleep: {
            duration: 27_000_000,
            efficiency: 92,
            deepMinutes: 85,
            lightMinutes: 230,
            remMinutes: 95,
            score: {
              score: 82,
              breakdown: { duration: 90, deepSleep: 80, remSleep: 85, continuity: 88, onsetLatency: 75 },
              hasStageData: true,
            },
          },
          healthMetrics: {
            restingHR: { value: 61, status: "in_range", personalRange: [56, 64] },
            hrv: { value: 45, status: "in_range", personalRange: [28, 52] },
            spo2: { value: 93.6, status: "below", personalRange: [94.5, 97.5] },
            breathingRate: { value: 16.2, status: "in_range", personalRange: [15, 18] },
            skinTempVariation: { value: 0.2, status: "in_range", personalRange: [-1, 1] },
          },
          outOfRangeCount: 1,
          totalMetricCount: 5,
        },
      });
    },
  );
  await page.clock.setFixedTime(new Date("2025-01-15T12:00:00.000Z"));
  await page.goto(`/?date=${TEST_DATE}`);

  await expect(page.getByText("Vitals", { exact: true })).toBeVisible();
  await expect(page.getByText("9,500")).toBeVisible();
  await expect(page.getByText("steps", { exact: true })).toBeVisible();
  await expect(page.getByText("2,450")).toBeVisible();
  await expect(page.getByText("active · 12 floors")).toBeVisible();
  await expect(page.getByTitle("Sleep score").getByText("82")).toBeVisible();
  await expect(page.getByText("7h 30m sleep · 92% eff")).toBeVisible();
  await expect(page.getByText("93.6%")).toBeVisible();
  await expect(page.getByText("SpO2 · 95–98")).toBeVisible();
  await expect(page.getByText("4 in range")).toBeVisible();
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("day-vitals.png");
});

test("adapts Timeline navigation and date controls for a compact window", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const unexpectedRequests = await openApp(page, `/?date=${TEST_DATE}`);

  const compactNavigation = page.getByRole("navigation", { name: "Primary" });
  const moreButton = compactNavigation.getByRole("button", { name: "More destinations" });
  await expect(compactNavigation).toBeVisible();
  await expect(compactNavigation.getByRole("link")).toHaveCount(4);
  await expect(moreButton).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Date navigation" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Wednesday, 15 January 2025", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose date, currently Wednesday, 15 January 2025" })).toBeVisible();
  await expect(page.getByText("No events for this day")).toBeVisible();

  const addEventButton = page.getByRole("button", { name: "Add event" });
  await addEventButton.click();
  const addEventMenu = page.getByRole("menu");
  await expect(addEventMenu).toBeVisible();
  const menuBounds = await addEventMenu.boundingBox();
  expect(menuBounds).not.toBeNull();
  if (!menuBounds) throw new Error("Add-event menu has no bounding box");
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(390);
  await addEventButton.click();
  await expect(addEventMenu).toBeHidden();

  await expect(page).toHaveScreenshot("app-compact.png");

  await moreButton.click();
  const moreDialog = page.getByRole("dialog", { name: "More destinations" });
  await expect(moreDialog).toBeVisible();
  await expect(moreDialog.getByRole("link", { name: "Search" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(moreDialog).toBeHidden();
  await expect(moreButton).toBeFocused();

  const hasRootOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasRootOverflow).toBe(false);

  await page.setViewportSize({ width: 700, height: 844 });
  await expect(page.getByRole("complementary", { name: "App navigation" })).toBeVisible();
  await expect(page.locator(".mobile-navigation-bar")).toBeHidden();
  await expect(page.getByRole("complementary", { name: "Date navigation" })).toBeHidden();

  await page.setViewportSize({ width: 1024, height: 844 });
  await expect(page.getByRole("complementary", { name: "Date navigation" })).toBeVisible();
  expect(unexpectedRequests).toEqual([]);
});

test("keeps the selected activity ring inside its scroll viewport", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/?date=2025-01-14");
  const selectedDate = page.locator('button[data-date="2025-01-14"]');

  await expect(selectedDate).toBeVisible();
  await expect(selectedDate).toHaveCSS("box-shadow", /inset/);
  await expectAppReady(page, unexpectedRequests);
});

test("renders search results", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/search?q=library");

  await expect(page).toHaveTitle("Search · Timeline");
  await expect(page.getByRole("combobox", { name: "Search timeline" })).toHaveValue("library");
  await expect(page.getByText("3 events loaded")).toBeVisible();
  await expect(page.getByText("Library study session")).toBeVisible();
  await expect(page.getByText("Library reading list")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Utilities" }).getByRole("link", { name: "Search", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("search.png");
});

test("renders attachments", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/attachments");

  await expect(page).toHaveTitle("Attachments · Timeline");
  await expect(page.getByRole("heading", { name: "Attachments", level: 1 })).toBeVisible();
  await expect(page.getByText("1,284")).toBeVisible();
  await expect(page.getByText("731 / 842", { exact: true })).toBeVisible();
  await page
    .getByRole("radiogroup", { name: "History range" })
    .getByText("All", { exact: true })
    .click();
  await expect(page.getByRole("img", { name: /Attachment description backlog by day/ })).toBeVisible();
  await expect(page.getByText("87%", { exact: true })).toBeVisible();
  await expect(page.getByText(/\+4 pts since/)).toBeVisible();
  const sourceFilter = page.getByRole("button", { name: "Filter sources, 1 hidden" });
  await sourceFilter.click();
  await expect(page.getByRole("menuitemcheckbox", { name: /Discord/ })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByRole("menuitemcheckbox", { name: /Recall/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await sourceFilter.click();
  await expect(page.getByRole("heading", { name: "January 2025", level: 2 })).toBeVisible();
  await expect(page.getByTitle("A winding coastal path beside blue water")).toBeVisible();
  await expect(page.getByRole("link", { name: "Attachments", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect
    .poll(() =>
      page.locator("img[alt]").evaluateAll((images) =>
        images.slice(0, 6).every((image) => (image as HTMLImageElement).complete),
      ),
    )
    .toBe(true);
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("attachments.png");
});

test("renders the sync overview", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/sync");

  await expect(page).toHaveTitle("Sync · Timeline");
  await expect(page.getByRole("heading", { name: "Sync", level: 2 })).toBeVisible();
  await expect(page.locator("a.source-card").filter({ hasText: "discord" })).toBeVisible();
  await expect(page.getByText("Recent Activity")).toBeVisible();
  await expect(page.getByText("Packaged build")).toHaveCount(0);
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("sync-overview.png");
});

test("renders sync action states", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  const unexpectedRequests = await mockApi(page);
  const baseStatus = apiResponses["/api/status"];
  const baseSource = baseStatus.scheduler.sources[0];
  const sources = [
    { ...baseSource, source: "discord", description: "Import chat history" },
    {
      ...baseSource,
      source: "spotify",
      description: "Import listening history",
      isRunning: true,
      lastRun: {
        ...baseSource.lastRun,
        time: "2025-01-15T11:59:00.000Z",
        isRunning: true,
        eventsAdded: 0,
        eventsUpdated: 0,
      },
      nextRunAt: "2025-01-15T13:00:00.000Z",
    },
    {
      ...baseSource,
      source: "github",
      description: "Import development activity",
      enabled: false,
      nextRunAt: null,
    },
    {
      ...baseSource,
      source: "backup-offsite",
      description: "Archive the timeline database",
      intervalMs: 21_600_000,
      nextRunAt: "2025-01-15T17:00:00.000Z",
    },
  ];
  const queuedJob = {
    id: 42,
    kind: "sync",
    source: "discord",
    payload: {},
    dedupeKey: "sync:discord",
    status: "queued",
    priority: 0,
    attempt: 0,
    maxAttempts: 3,
    enqueuedAt: "2025-01-15 11:58:00",
    notBefore: "2025-01-15 11:58:00",
    startedAt: null,
    finishedAt: null,
    workerId: null,
    workerLeaseUntil: null,
    result: null,
    error: null,
    trigger: "scheduler",
  };
  const runningJob = {
    ...queuedJob,
    id: 43,
    source: "spotify",
    dedupeKey: "sync:spotify",
    status: "running",
    priority: 10,
    startedAt: "2025-01-15 11:59:00",
    workerId: "worker-1",
    trigger: "manual",
  };

  await page.route(
    (url) => url.pathname === "/api/status",
    async (route) => {
      await route.fulfill({
        json: {
          ...baseStatus,
          scheduler: { ...baseStatus.scheduler, sources },
          queue: [queuedJob, runningJob],
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/sync/sources",
    async (route) => {
      await route.fulfill({
        json: {
          sources: sources.map((source) => ({
            name: source.source,
            description: source.description,
            configured: true,
            enabled: source.enabled,
            interval: null,
            effectiveInterval: "1h",
            effectiveIntervalMs: source.intervalMs,
            defaultInterval: "1h",
            settings: {},
            settingsSchema: [],
          })),
        },
      });
    },
  );

  await page.clock.setFixedTime(new Date("2025-01-15T12:00:00.000Z"));
  await page.goto("/sync");

  await expect(page.getByRole("button", { name: "Queued" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Running…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Disabled" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sync Now" })).toBeEnabled();
  await expectAppReady(page, unexpectedRequests);

  const syncSourcesSection = page.getByText("Sync Sources", { exact: true }).locator("..").locator("..");
  await expect(syncSourcesSection).toHaveScreenshot("sync-action-states.png");
});

test("renders settings", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/settings");

  await expect(page).toHaveTitle("Settings · Timeline");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Version & build", level: 2 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText("Packaged build")).toBeVisible();
  await expect(page.getByText("0.8.1")).toBeVisible();
  await expect(page.getByText("Package the Timeline service")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Updates & changes" })).toBeVisible();
  await expect(page.getByText("An update is available.")).toBeVisible();
  await expect(page.getByText("Faster timeline searches.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download for macOS" })).toHaveAttribute(
    "href", apiResponses["/api/releases/latest"].latest.downloadUrl,
  );
  await expect(page.getByRole("heading", { name: "Network", level: 2 })).toBeVisible();
  await expect(page.getByLabel("Blocked Wi-Fi networks")).toHaveValue("iPhone\nTrain WiFi");
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("settings.png");
});

test("reports a failed release check and retries from Settings", async ({ page }) => {
  const unexpectedRequests = await mockApi(page);
  let checks = 0;
  await page.route((url) => url.pathname === "/api/releases/latest", async (route) => {
    checks++;
    if (checks === 1) {
      await route.fulfill({ status: 503, json: { error: "GitHub denied release access." } });
    } else {
      await route.fulfill({ json: apiResponses["/api/releases/latest"] });
    }
  });
  await page.goto("/settings");
  await expect(page.getByText("Could not check releases.")).toBeVisible();
  await expect(page.getByText("GitHub denied release access.")).toBeVisible();
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.getByText("An update is available.")).toBeVisible();
  expect(checks).toBe(2);
  expect(unexpectedRequests).toEqual([]);
});

test("keeps packaged build identity inside a compact Settings window", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const unexpectedRequests = await openApp(page, "/settings");

  await expect(page.getByText("Packaged build")).toBeVisible();
  await expect(page.getByText("0.8.1")).toBeVisible();
  await expect(page.getByText("Package the Timeline service")).toBeVisible();
  await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  expect(unexpectedRequests).toEqual([]);

  const hasRootOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasRootOverflow).toBe(false);
});

test("renders a sync source", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/sync/discord");

  await expect(page).toHaveTitle("Sync · Timeline");
  await expect(page.getByRole("heading", { name: "Discord", level: 1 })).toBeVisible();
  await expect(page.getByText("Import Discord messages and reactions")).toBeVisible();
  await expect(page.getByText("Run history")).toBeVisible();
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("sync-discord.png");
});

test("hands a queued sync job off to persisted run history", async ({ page }) => {
  const unexpectedRequests = await mockApi(page);
  let jobCompleted = false;
  const job = {
    id: 42,
    kind: "sync",
    source: "discord",
    payload: {},
    dedupeKey: "sync:discord",
    status: "queued",
    priority: 10,
    attempt: 0,
    maxAttempts: 1,
    enqueuedAt: "2025-01-15 12:00:00",
    notBefore: "2025-01-15 12:00:00",
    startedAt: null,
    finishedAt: null,
    workerId: null,
    workerLeaseUntil: null,
    result: null,
    error: null,
    trigger: "manual",
  };
  const baseStatus = apiResponses["/api/status"] as Record<string, unknown>;

  await page.route(
    (url) => url.pathname === "/api/status/trigger-sync",
    async (route) => {
      await route.fulfill({
        json: { success: true, jobId: job.id, deduped: false, message: `Sync queued (job #${job.id})` },
      });
    },
  );
  await page.route(
    (url) => url.pathname === `/api/jobs/${job.id}`,
    async (route) => {
      await route.fulfill({
        json: {
          job: jobCompleted
            ? {
                ...job,
                status: "succeeded",
                startedAt: "2025-01-15 12:00:01",
                finishedAt: "2025-01-15 12:00:04",
                result: { success: true, eventsAdded: 2, eventsUpdated: 0 },
              }
            : job,
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/status",
    async (route) => {
      await route.fulfill({ json: { ...baseStatus, queue: jobCompleted ? [] : [job] } });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/status/sync-history",
    async (route) => {
      const entries = jobCompleted
        ? [{
            ...syncHistoryEntry,
            id: 2,
            job_id: job.id,
            started_at: "2025-01-15 12:00:01",
            finished_at: "2025-01-15 12:00:04",
            events_added: 2,
            events_updated: 0,
            duration_ms: 3_000,
            metadata: null,
          }]
        : [];
      await route.fulfill({ json: { entries, count: entries.length } });
    },
  );

  await page.clock.setFixedTime(new Date("2025-01-15T12:00:00.000Z"));
  await page.goto("/sync/discord");
  await expectAppReady(page, unexpectedRequests);

  await page.getByRole("button", { name: "Sync Now" }).click();
  const runRows = page.locator("tbody tr");
  await expect(runRows).toHaveCount(1);
  await expect(runRows.first()).toContainText("Queued");
  await expect(runRows.first()).toContainText("#42");

  jobCompleted = true;
  await expect(runRows).toHaveCount(1);
  await expect(runRows.first()).toContainText("OK");
  await expect(runRows.first()).toContainText("+2");
  await expect(runRows.first()).not.toContainText("#42");
  expect(unexpectedRequests).toEqual([]);
});

const backupSyncSource = {
  name: "backup",
  description: "Backup timeline database to NAS",
  configured: true,
  enabled: true,
  interval: null,
  effectiveInterval: "30m",
  effectiveIntervalMs: 1_800_000,
  defaultInterval: "30m",
  settings: { destination: "/mnt/backups", keep_count: 24, compress: true, mode: "full" },
  settingsSchema: [
    {
      key: "destination",
      type: "string",
      label: "Backup directory",
      description: "Directory backups are written to",
      required: true,
    },
    {
      key: "keep_count",
      type: "number",
      label: "Backups to retain",
      description: "Number of completed backups to keep",
      integer: true,
      min: 1,
      default: 24,
    },
    {
      key: "compress",
      type: "boolean",
      label: "Compress backups",
      description: "Gzip each backup after writing",
      default: true,
    },
    {
      key: "mode",
      type: "select",
      label: "Backup mode",
      description: "Full copy or incremental",
      options: ["full", "incremental"],
      default: "full",
    },
  ],
};

const backupOffsiteSyncSource = {
  name: "backup-offsite",
  description: "Encrypt and back up app-state.db offsite to R2",
  configured: true,
  enabled: true,
  interval: "6h",
  effectiveInterval: "6h",
  effectiveIntervalMs: 21_600_000,
  defaultInterval: "6h",
  settings: {
    keep_count: 14,
    blocked_ssids: ["Example Phone", "Train WiFi"],
    require_unmetered: true,
    on_unknown: "skip",
  },
  settingsSchema: [
    {
      key: "keep_count",
      type: "number",
      label: "Offsite backups to retain",
      description: "Number of uploaded snapshots to keep",
      integer: true,
      min: 1,
      default: 28,
    },
    {
      key: "blocked_ssids",
      type: "string-list",
      label: "Blocked Wi-Fi networks",
      description: "Skip when the active Wi-Fi network name contains one of these values",
      default: [],
    },
    {
      key: "require_unmetered",
      type: "boolean",
      label: "Require unmetered network",
      description: "Skip on expensive or constrained network connections",
      default: false,
    },
    {
      key: "on_unknown",
      type: "select",
      label: "When network status is unknown",
      description: "Choose whether to run when network checks cannot be determined",
      options: ["proceed", "skip"],
      default: "proceed",
    },
  ],
} satisfies SyncSourceInfo;

test("renders a schema-driven sync source", async ({ page }) => {
  const unexpectedRequests = await mockApi(page);
  const configurationPatches: unknown[] = [];
  let currentBackup: SyncSourceInfo = structuredClone(backupSyncSource);
  // Scope the schema'd source to this test so the /sync overview baseline stays
  // discord-only. Registered after mockApi so it wins the route match.
  const baseSources = (apiResponses["/api/sync/sources"] as { sources: unknown[] }).sources;
  await page.route(
    (url) => url.pathname === "/api/sync/sources",
    async (route) => {
      await route.fulfill({ json: { sources: [...baseSources, currentBackup] } });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/sync/sources/backup",
    async (route) => {
      const patch = route.request().postDataJSON() as {
        enabled?: boolean;
        interval?: string | null;
        settings?: Record<string, unknown>;
      };
      configurationPatches.push(patch);
      const settings = { ...currentBackup.settings };
      for (const [key, value] of Object.entries(patch.settings ?? {})) {
        if (value === null) delete settings[key];
        else settings[key] = value;
      }
      currentBackup = {
        ...currentBackup,
        enabled: patch.enabled ?? currentBackup.enabled,
        interval: patch.interval === undefined ? currentBackup.interval : patch.interval,
        settings,
      };
      await route.fulfill({ json: currentBackup });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/status/sync-history",
    async (route) => {
      await route.fulfill({ json: { entries: [], count: 0 } });
    },
  );
  await page.clock.setFixedTime(new Date("2025-01-15T12:00:00.000Z"));
  await page.goto("/sync/backup");

  await expect(page).toHaveTitle("Sync · Timeline");
  await expect(page.getByRole("heading", { name: "Backup", level: 1 })).toBeVisible();
  await expect(page.getByText("Backup directory")).toBeVisible();
  await expect(page.getByText("Backups to retain")).toBeVisible();
  await expect(page.getByText("Compress backups")).toBeVisible();
  await expect(page.getByText("Backup mode")).toBeVisible();
  await expect(page.getByLabel("Backup directory", { exact: true })).toHaveValue("/mnt/backups");
  await expect(page.getByRole("radio", { name: "full" })).toBeChecked();
  await expectAppReady(page, unexpectedRequests);

  const saveChanges = page.getByRole("button", { name: "Save changes" });
  const discardChanges = page.getByRole("button", { name: "Discard changes" });
  await expect(saveChanges).toBeDisabled();
  await expect(discardChanges).toBeDisabled();
  await expectDisabledHoverStylesStable(saveChanges);
  await expectDisabledHoverStylesStable(discardChanges);
  await page.getByRole("switch", { name: "Automatic sync" }).click();
  await page.getByLabel("Sync interval").fill("45m");
  await page.getByLabel("Backup directory", { exact: true }).fill("  /srv/timeline-backups  ");
  await page.getByLabel("Backups to retain", { exact: true }).fill("12");
  await page.getByRole("switch", { name: "Compress backups" }).click();
  await page.getByText("incremental", { exact: true }).click();

  expect(configurationPatches).toEqual([]);
  await expect(page.getByRole("status").filter({ hasText: "6 unsaved changes" })).toBeVisible();
  await expect(page).toHaveScreenshot("sync-backup.png");

  await saveChanges.click();
  await expect.poll(() => configurationPatches).toEqual([
    {
      enabled: false,
      interval: "45m",
      settings: {
        destination: "/srv/timeline-backups",
        keep_count: 12,
        compress: false,
        mode: "incremental",
      },
    },
  ]);
  await expect(saveChanges).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sync Now" })).toBeDisabled();

  const useSourceDefaults = page.getByRole("button", { name: "Use source defaults" });
  await expect(useSourceDefaults).toBeEnabled();
  await useSourceDefaults.click();
  await expect(page.getByRole("switch", { name: "Automatic sync" })).not.toBeChecked();
  await expect(page.getByLabel("Sync interval")).toHaveValue("");
  await expect(page.getByLabel("Backup directory", { exact: true })).toHaveValue(
    "/srv/timeline-backups"
  );
  await expect(page.getByLabel("Backups to retain")).toHaveValue("24");
  await expect(page.getByRole("switch", { name: "Compress backups" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "full" })).toBeChecked();
  expect(configurationPatches).toHaveLength(1);

  await saveChanges.click();
  await expect.poll(() => configurationPatches).toEqual([
    {
      enabled: false,
      interval: "45m",
      settings: {
        destination: "/srv/timeline-backups",
        keep_count: 12,
        compress: false,
        mode: "incremental",
      },
    },
    {
      interval: null,
      settings: {
        keep_count: null,
        compress: null,
        mode: null,
      },
    },
  ]);
  await expect(useSourceDefaults).toBeDisabled();
});

test("renders the offsite backup configuration form", async ({ page }) => {
  const unexpectedRequests = await mockApi(page);
  const baseSources = (apiResponses["/api/sync/sources"] as { sources: unknown[] }).sources;
  await page.route(
    (url) => url.pathname === "/api/sync/sources",
    async (route) => {
      await route.fulfill({ json: { sources: [...baseSources, backupOffsiteSyncSource] } });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/status/sync-history",
    async (route) => {
      await route.fulfill({ json: { entries: [], count: 0 } });
    },
  );
  await page.clock.setFixedTime(new Date("2025-01-15T12:00:00.000Z"));
  await page.goto("/sync/backup-offsite");

  await expect(page.getByRole("heading", { name: "Offsite Backup", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Offsite backups to retain", { exact: true })).toHaveValue("14");
  await expect(page.getByLabel("Blocked Wi-Fi networks", { exact: true })).toHaveValue(
    "Example Phone\nTrain WiFi",
  );
  await expect(page.getByRole("switch", { name: "Require unmetered network" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "skip" })).toBeChecked();
  await expectAppReady(page, unexpectedRequests);

  await expect(page.getByRole("form", { name: "Source configuration" })).toHaveScreenshot(
    "sync-backup-offsite.png",
  );
});

test("renders contacts", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/contacts");

  await expect(page).toHaveTitle("Contacts · Timeline");
  await expect(page.getByPlaceholder("Search contacts...")).toBeVisible();
  await expect(page.getByRole("button", { name: /Alice/ })).toBeVisible();
  await expect(page.getByText("You", { exact: true })).toBeVisible();
  await expect(page.getByText("Select a contact to view details")).toBeVisible();
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("contacts.png");
});

test("renders a contact detail", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/contacts?id=1");

  await expect(page).toHaveTitle("Contacts · Timeline");
  await expect(page.getByRole("heading", { name: "Alice", level: 1 })).toBeVisible();
  await expect(page.getByText("You", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Not me" })).toBeVisible();
  await expect(page.getByText("Met through the local book club.")).toBeVisible();
  await expect(page.getByText("alice@example.com")).toBeVisible();
  await expect(page.getByText("Enjoys science fiction novels.")).toBeVisible();
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("contact-detail.png");
});

test("switches to contacts while its list is still loading", async ({ page }) => {
  const unexpectedRequests = await openApp(page, `/?date=${TEST_DATE}`);
  await expect(page.getByText("No events for this day")).toBeVisible();
  const contactsResponse = Promise.withResolvers<void>();

  await page.route(
    (url) => url.pathname === "/api/contacts",
    async (route) => {
      await contactsResponse.promise;
      await route.fulfill({ json: apiResponses["/api/contacts"] });
    },
  );

  try {
    await page.getByRole("link", { name: "People", exact: true }).click();
    await expect(page).toHaveURL("/contacts");
    await expect(page.getByPlaceholder("Search contacts...")).toBeVisible();
    await expect(page.getByText("Loading contacts...")).toBeVisible();
  } finally {
    contactsResponse.resolve();
  }
  await expect(page.getByRole("button", { name: /Alice/ })).toBeVisible();
  expect(unexpectedRequests).toEqual([]);
});

test("switches to the timeline while its day is still loading", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/contacts");
  await expect(page.getByPlaceholder("Search contacts...")).toBeVisible();
  const dayResponse = Promise.withResolvers<void>();

  await page.route(
    (url) => url.pathname === "/api/day",
    async (route) => {
      await dayResponse.promise;
      await route.fulfill({ json: apiResponses["/api/day"] });
    },
  );

  try {
    await page.getByRole("link", { name: "Timeline", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("heading", { name: "Wednesday, 15 January 2025", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Loading events...")).toBeVisible();
  } finally {
    dayResponse.resolve();
  }
  await expect(page.getByText("No events for this day")).toBeVisible();
  expect(unexpectedRequests).toEqual([]);
});

test("renders conversations", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/conversations");

  await expect(page).toHaveTitle("Conversations · Timeline");
  await expect(page.getByPlaceholder("Search conversations...")).toBeVisible();
  await expect(page.getByText("1 conversation", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Study Group/ })).toBeVisible();
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("conversations.png");
});

test("renders conversation message states", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/conversation/discord/study-group");

  await expect(page).toHaveTitle("Study Group · Timeline");
  await expect(page.getByRole("heading", { name: "Study Group", level: 2 })).toBeVisible();
  await expect(page.locator("#event-1003").getByText("Yes — the quiet room is booked for ten.")).toBeVisible();
  await expect(page.getByText("Forwarded", { exact: true })).toBeVisible();
  await expect(page.getByText("Missed", { exact: false })).toBeVisible();
  await expect(page.getByText("deleted", { exact: true })).toBeVisible();
  await expect(page.getByText("(edited)")).toHaveAttribute(
    "title",
    "Edited · 1 earlier version captured",
  );
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("conversation-messages.png");
});

test("renders health", async ({ page }) => {
  const unexpectedRequests = await openApp(
    page,
    "/health?view=month&mode=calendar&anchor=2025-01-01",
    {
    fixedTime: false,
    },
  );

  await expect(page).toHaveTitle("Health · Timeline");
  await expect(page.getByRole("heading", { name: "Health Dashboard", level: 1 })).toBeVisible();
  await expect(page.getByText("January 2025", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset to recent" })).toBeEnabled();
  await expect(page.getByText("Avg Sleep", { exact: true })).toBeVisible();
  await expect(page.getByText("Avg Resting HR", { exact: true })).toBeVisible();
  await expect(page.getByText("Total Steps", { exact: true })).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
  await expectChartsReady(page);
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("health-overview.png");

  await page.getByRole("button", { name: "Weight", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Weight Trend", level: 3 })).toBeVisible();
  await expect(page.getByText("Latest Weight", { exact: true })).toBeVisible();
  await expect(page.getByText(/BMI/)).toHaveCount(0);
});

test("labels the year change on a rolling health chart", async ({ page }) => {
  const unexpectedRequests = await mockApi(page);
  // Registered after mockApi so it wins the route match for the rolling-year payload.
  await page.route(
    (url) => url.pathname === "/api/health/stats",
    async (route) => {
      await route.fulfill({ json: healthYearStats });
    },
  );
  await page.clock.setFixedTime(new Date("2026-08-12T12:00:00.000Z"));
  await page.goto(
    "/health?section=sleep&view=year&mode=recent&anchor=2026-08-12",
  );

  await expect(page).toHaveTitle("Health · Timeline");
  await expect(page.getByText("Sept 2025 - Aug 2026", { exact: true })).toBeVisible();
  const chart = page
    .getByRole("heading", { name: "Sleep Duration Over Time", level: 3 })
    .locator("..");
  await expect(chart.locator("canvas")).toBeVisible();
  await expectChartsReady(page);
  await expectAppReady(page, unexpectedRequests);

  await chart.scrollIntoViewIfNeeded();
  const chartBounds = await chart.boundingBox();
  if (!chartBounds) throw new Error("Health year chart has no visible bounds");
  const axisHeight = 64;
  await expect(page).toHaveScreenshot("health-year-axis.png", {
    clip: {
      x: chartBounds.x,
      y: chartBounds.y + chartBounds.height - axisHeight,
      width: chartBounds.width,
      height: axisHeight,
    },
  });
});

test("renders health in a compact window", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const unexpectedRequests = await openApp(
    page,
    "/health?view=month&mode=calendar&anchor=2025-01-01",
    {
      fixedTime: false,
    },
  );

  const compactNavigation = page.getByRole("navigation", { name: "Primary" });
  await expect(compactNavigation.getByRole("link", { name: "Health" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    compactNavigation.getByRole("button", { name: "More destinations" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(compactNavigation.getByRole("link", { name: "Search" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Health", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByText("Health Dashboard", { exact: true })).toBeHidden();
  await expect(page.getByRole("radio", { name: "Week" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Month" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Year" })).toBeVisible();
  await expectChartsReady(page);
  await expect(page.locator("[aria-busy='true']")).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  expect(unexpectedRequests).toEqual([]);

  const hasRootOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasRootOverflow).toBe(false);
  await expect(page).toHaveScreenshot("health-compact.png");
});


async function installHealthChartProbe(page: Page) {
  await page.addInitScript(() => {
    type TextBox = { text: string; left: number; right: number; top: number; bottom: number };
    const boxes = new Map<HTMLCanvasElement, Map<string, TextBox>>();
    const measuredWidths = new WeakMap<Element, number>();
    Object.assign(window, { chartMeasuredWidths: measuredWidths });
    Object.assign(window, { chartViewportResized: false });
    window.addEventListener("resize", () => Object.assign(window, { chartViewportResized: true }));
    const NativeResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          for (const entry of entries) measuredWidths.set(entry.target, entry.target.clientWidth);
          callback(entries, observer);
        });
      }
    };
    const paintSizes = new Map<HTMLCanvasElement, Set<string>>();
    Object.defineProperty(window, "chartTextBoxes", { value: boxes });
    Object.defineProperty(window, "chartPaintSizes", { value: paintSizes });
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      boxes.delete(this.canvas);
      clearRect.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      const sizes = paintSizes.get(this.canvas) ?? new Set<string>();
      sizes.add(`${this.canvas.width}x${this.canvas.height}`);
      paintSizes.set(this.canvas, sizes);
      const metrics = this.measureText(text);
      const transform = this.getTransform();
      const start = transform.transformPoint(new DOMPoint(x - metrics.actualBoundingBoxLeft, y - metrics.actualBoundingBoxAscent));
      const end = transform.transformPoint(new DOMPoint(x + metrics.actualBoundingBoxRight, y + metrics.actualBoundingBoxDescent));
      const entries = boxes.get(this.canvas) ?? new Map<string, TextBox>();
      entries.set(`${text}:${start.x}:${start.y}`, { text, left: start.x, right: end.x, top: start.y, bottom: end.y });
      boxes.set(this.canvas, entries);
      fillText.call(this, text, x, y, maxWidth);
    };
  });
}

for (const viewportWidth of [390, 1280, 2560]) {
  test(`keeps dense health dates readable at ${viewportWidth}px`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: viewportWidth, height: 1000 });
    await installHealthChartProbe(page);
    const unexpectedRequests = await mockApi(page);
    await page.route((url) => url.pathname === "/api/health/stats", async (route) => {
      const view = new URL(route.request().url()).searchParams.get("view");
      const count = view === "week" ? 7 : view === "year" ? 12 : 30;
      const dates = Array.from({ length: count }, (_, i) => {
        const date = view === "year" ? new Date(Date.UTC(2025, 8 + i, 15)) : new Date(Date.UTC(2026, 7, 30 + i));
        return date.toISOString().slice(0, 10);
      });
      await route.fulfill({ json: {
        ...healthStats,
        sleep: { ...healthStats.sleep, byDay: dates.map((date, i) => ({
          ...healthStats.sleep.byDay[i % 3], date,
          startTime: `${date}T01:00:00.000Z`, endTime: `${date}T08:00:00.000Z`,
        })) },
        heart: { ...healthStats.heart, byDay: dates.map(date => ({ date, restingHR: 60 })) },
        hrv: { ...healthStats.hrv, byDay: dates.map(date => ({ date, rmssd: 40 })) },
        activity: { ...healthStats.activity, byDay: dates.map(date => ({ date, steps: 6000 })) },
        weight: { ...healthStats.weight, byDay: dates.map(date => ({ date, weight: 70 })) },
      } });
    });
    await page.clock.setSystemTime(new Date("2026-09-28T12:00:00Z"));
    await page.goto("/health?view=month");
    for (const view of ["Month", "Week", "Year"]) {
      await page.locator("label").filter({ hasText: new RegExp(`^${view}$`) }).click();
      for (const section of ["Overview", "Sleep", "Heart", "Activity", "Weight"]) {
        await page.getByRole("button", { name: section, exact: true }).click();
        await expect(page.locator("canvas").first()).toBeVisible();
        await expectChartsReady(page);
        const charts = page.getByRole("region", { name: "Date chart" });
        expect(await charts.count()).toBeGreaterThan(0);
        for (const chart of await charts.all()) {
          const result = await chart.evaluate((element) => {
            type Box = { text: string; left: number; right: number; top: number; bottom: number };
            const probe = window as unknown as {
              chartTextBoxes: Map<HTMLCanvasElement, Map<string, Box>>;
              chartPaintSizes: Map<HTMLCanvasElement, Set<string>>;
            };
            const canvas = element.querySelector("canvas");
            if (!canvas) throw new Error("Missing chart canvas");
            const boxes = [...(probe.chartTextBoxes.get(canvas)?.values() ?? [])];
            const overlaps: string[] = [];
            for (let i = 0; i < boxes.length; i++) {
              const a = boxes[i];
              for (const b of boxes.slice(i + 1)) {
                if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
                  overlaps.push(`${a.text} / ${b.text}`);
                }
              }
            }
            const month = boxes.find(box => box.text === "Aug");
            const firstDateX = month ? (month.left + month.right) / 2 : Infinity;
            return { dateRows: [...new Set(boxes.filter(box => /^\d{1,2}$/.test(box.text) && box.right >= firstDateX && box.top > canvas.height * 0.65).map(box => box.top))], paintSizes: [...(probe.chartPaintSizes.get(canvas) ?? [])], text: boxes.map(box => box.text), overlaps, clipped: boxes.filter(box => box.left < 0 || box.right > canvas.width || box.top < 0 || box.bottom > canvas.height) };
          });
          expect(result.text.length).toBeGreaterThan(5);
          expect(result.overlaps, `${view} ${section}`).toEqual([]);
          expect(result.clipped, `${view} ${section}`).toEqual([]);
          if (view === "Month" && section === "Overview") expect(result.paintSizes).toHaveLength(1);
          if (view === "Month") {
            expect(result.dateRows, `${section} day numbers must share one baseline`).toHaveLength(1);
            expect(result.text).toContain("30");
            expect(result.text).toContain("Aug");
            expect(result.text).toContain("Sept");
          }
          if (view === "Week") expect(result.text).toContain("Sun");
          if (view === "Year") expect(result.text).toContain("2026");
          expect(await chart.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
        if (viewportWidth === 390 && view === "Month" && section === "Activity") {
          const bounds = await charts.first().boundingBox();
          if (!bounds) throw new Error("Missing activity chart bounds");
          // August 31 is between the compact axis ticks, but its data remains selectable.
          const secondDayX = await charts.first().evaluate(element => {
            type Box = { text: string; left: number; right: number };
            const probe = window as unknown as { chartTextBoxes: Map<HTMLCanvasElement, Map<string, Box>> };
            const canvas = element.querySelector("canvas");
            if (!canvas) throw new Error("Missing chart canvas");
            const labels = [...(probe.chartTextBoxes.get(canvas)?.values() ?? [])];
            const first = labels.find(label => label.text === "30");
            const last = labels.find(label => label.text === "28");
            if (!first || !last) throw new Error("Missing date endpoints");
            const firstX = (first.left + first.right) / 2;
            const lastX = (last.left + last.right) / 2;
            return (firstX + (lastX - firstX) / 29) * canvas.clientWidth / canvas.width;
          });
          await page.mouse.click(bounds.x + secondDayX, bounds.y + bounds.height / 2);
          await expect(page.getByText("2026-08-31: 6,000 steps", { exact: true })).toBeVisible();
        }
        if (view === "Month" && section === "Overview") {
          const pageBounds = await page.getByRole("heading", { name: /^Health(?: Dashboard)?$/, level: 1 }).evaluate(heading => {
            const page = heading.closest("[style*=chart-card-min-width]");
            if (!page?.parentElement) throw new Error("Missing health page container");
            const bounds = page.getBoundingClientRect();
            const parent = page.parentElement.getBoundingClientRect();
            const contentLeft = parent.left + page.parentElement.clientLeft;
            const contentRight = contentLeft + page.parentElement.clientWidth;
            return { width: bounds.width, leftGap: bounds.left - contentLeft, rightGap: contentRight - bounds.right };
          });
          expect(pageBounds.width).toBeLessThanOrEqual(1152);
          expect(Math.abs(pageBounds.leftGap - pageBounds.rightGap)).toBeLessThanOrEqual(1);
          if (viewportWidth >= 1280) expect(pageBounds.width).toBe(1152);
          const cards = await charts.evaluateAll(elements => elements.map(element => element.parentElement?.getBoundingClientRect().toJSON()));
          expect(cards).toHaveLength(4);
          for (let i = 1; i < cards.length; i++) {
            expect(cards[i].top).toBeGreaterThanOrEqual(cards[i - 1].bottom);
          }
          await expect(page).toHaveScreenshot(`health-dense-${viewportWidth}.png`);
        }
        if (view !== "Month" && section === "Overview" && viewportWidth >= 1280) {
          const cards = await charts.evaluateAll(elements => elements.map(element => element.parentElement?.getBoundingClientRect().toJSON()));
          expect(cards[1].top).toBe(cards[0].top);
          expect(cards[1].left).toBeGreaterThan(cards[0].right);
          expect(cards[2].top).toBeGreaterThanOrEqual(cards[0].bottom);
          expect(cards[3].top).toBe(cards[2].top);
        }
      }
    }
    expect(unexpectedRequests).toEqual([]);
  });
}

test("renders music", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/music");

  await expect(page).toHaveTitle("Music · Timeline");
  await expect(page.getByRole("heading", { name: "Music", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your listening", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Top tracks · Last 4 weeks", level: 3 })).toBeAttached();
  await expect(page.getByRole("heading", { name: "Recent plays", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Yesterday 1 plays", level: 4 })).toBeVisible();
  await expect(page.locator('a[href="/event/201"]').first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tracked playlists", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Friends listening", level: 2 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Focus Mix/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Alice", exact: true })).toBeVisible();
  await expect(page.locator('a[href="/event/101"]')).toBeVisible();
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("music-overview.png");
});

test("updates canvas text when Inter loads and inherits it in map controls", async ({ page }) => {
  type FontProbe = { chartFonts: string[] };
  await page.addInitScript(() => {
    const chartFonts: string[] = [];
    Object.defineProperty(window, "chartFonts", { value: chartFonts });
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      chartFonts.push(this.font);
      return fillText.apply(this, args);
    };
  });
  const fonts = Promise.withResolvers<void>();
  await page.route("**/inter-*.woff2", async (route) => {
    await fonts.promise;
    await route.continue();
  });
  try {
    const unexpectedRequests = await mockApi(page);
    await page.goto("/music/playlist/focus-mix", { waitUntil: "domcontentloaded" });
    await expect(page.locator("canvas")).toBeVisible();
    const chartFonts = () => page.evaluate(() => (window as unknown as FontProbe).chartFonts);
    await expect.poll(async () => (await chartFonts()).length).toBeGreaterThan(0);
    expect((await chartFonts()).some((font) => font.includes("Inter Variable"))).toBe(false);

    fonts.resolve();
    await expectAppReady(page, unexpectedRequests);
    await expect.poll(async () => (await chartFonts()).some((font) => font.includes("Inter Variable"))).toBe(true);

    const mapFonts = await page.evaluate(() => {
      const map = document.createElement("div");
      map.className = "maplibregl-map";
      const control = document.createElement("div");
      control.className = "maplibregl-ctrl maplibregl-ctrl-attrib";
      control.textContent = "Example attribution";
      const popup = document.createElement("div");
      popup.className = "maplibregl-popup";
      popup.textContent = "Example popup";
      map.append(control, popup);
      document.body.append(map);
      const result = [control, popup].map((element) => getComputedStyle(element).fontFamily);
      map.remove();
      return result;
    });
    for (const family of mapFonts) expect(family).toContain('"Inter Variable"');
  } finally {
    fonts.resolve();
  }
});

test("renders a music playlist", async ({ page }) => {
  const unexpectedRequests = await openApp(page, "/music/playlist/focus-mix", {
    fixedTime: false,
  });

  await expect(page).toHaveTitle("Music · Timeline");
  await expect(page.getByRole("heading", { name: "Focus Mix", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "← Music", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in Spotify", exact: true })).toBeVisible();
  await expect(page.getByText("Current saves", { exact: true })).toBeVisible();
  await expect(page.getByText("Past 12 months", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Backfilled from manual history" })).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await expectChartsReady(page);
  await expectAppReady(page, unexpectedRequests);

  await expect(page).toHaveScreenshot("music-playlist.png");
});


for (const deviceScaleFactor of [1, 2]) {
  test.describe.parallel(`chart resize DPR ${deviceScaleFactor}`, () => {
    test.use({ deviceScaleFactor });
    for (const view of ["month", "week", "year"] as const) {
      test(`health chart width sweep ${view}`, async ({ page }, testInfo) => {
        test.setTimeout(180_000);
        await installHealthChartProbe(page);
        await mockApi(page);
        const count = view === "month" ? 31 : view === "week" ? 7 : 12;
        const dates = Array.from({ length: count }, (_, i) => new Date(Date.UTC(2025, 11 + (view === "year" ? i : 0), view === "year" ? 15 : 31 + i)).toISOString().slice(0, 10));
        await page.route((url) => url.pathname === "/api/health/stats", route => route.fulfill({ json: {
          ...healthStats,
          sleep: { ...healthStats.sleep, byDay: dates.map((date, i) => ({ ...healthStats.sleep.byDay[i % 3], date,
            duration: (5 + i % 6) * 3600000, startTime: `${date}T01:00:00Z`, endTime: `${date}T08:00:00Z`,
          })), naps: [{ date: dates[1], duration: 3600000, startTime: `${dates[1]}T14:00:00Z`, endTime: `${dates[1]}T15:00:00Z` }] },
          heart: { ...healthStats.heart, byDay: dates.map((date, i) => ({ date, restingHR: 51 + i % 18 })) },
          hrv: { ...healthStats.hrv, byDay: dates.map((date, i) => ({ date, rmssd: 25 + i % 60 })) },
          activity: { ...healthStats.activity, byDay: dates.map((date, i) => ({ date, steps: 1800 + i * 850 })) },
          weight: { ...healthStats.weight, byDay: dates.map((date, i) => ({ date, weight: 168 + i * 0.1 })) },
        } }));
        await page.clock.setSystemTime(new Date("2026-12-15T12:00:00Z"));
        await page.goto(`/health?view=${view}`);
        const regressionWidths = [
          320, 360, 390, 599, 600, 601, 767, 768, 769, 1023, 1024, 1025,
          1094, 1095, 1096, 1097, 1098, 1239, 1240, 1241, 1279, 1280, 1281,
          1440, 1535, 1536, 1537, 1920, 2560,
        ];
        const widths = chartSweep === "smoke" ? regressionWidths : [...new Set([
          ...Array.from({ length: 54 }, (_, i) => 320 + i * 32),
          359, 360, 361, 374, 375, 376, 389, 390, 391,
          599, 600, 601, 639, 640, 641, 767, 768, 769,
          1023, 1024, 1025, 1094, 1095, 1096, 1097, 1098,
          1239, 1240, 1241, 1279, 1280, 1281, 1439, 1440, 1441, 1491, 1492, 1493, 1535, 1536, 1537, 1559, 1560, 1561, 1595, 1596, 1597, 1643, 1644, 1645, 1679, 1680, 1681, 1919, 1920, 1921, 2560,
        ])].sort((a, b) => a - b);
        const failures: { section: string; width: number; frame: number; errors: string[] }[] = [];
        const capturedWidths = new Set<number>();
        for (const section of ["Overview", "Sleep", "Heart", "Activity", "Weight"]) {
          await page.getByRole("button", { name: section, exact: true }).click();
          await expect(page.locator("canvas").first()).toBeVisible();
          await expectChartsReady(page);
          const sectionWidths = section === "Overview" ? [...widths, ...widths.toReversed()] : [320, 360, 390, 599, 600, 601, 768, 1024, 1095, 1096, 1097, 1280, 1440, 1535, 1536, 1537, 1920];
          for (const width of sectionWidths) {
            const resizing = page.viewportSize()?.width !== width;
            if (resizing) {
              await page.evaluate(() => Object.assign(window, { chartViewportResized: false }));
            }
            await page.setViewportSize({ width, height: 1000 });
            if (resizing) {
              // setViewportSize can return before Chromium dispatches the resize.
              // Sample frames for the requested viewport after that event arrives.
              await page.waitForFunction(
                (requestedWidth) => window.innerWidth === requestedWidth
                  && (window as unknown as { chartViewportResized: boolean }).chartViewportResized,
                width,
                { timeout: 5000 },
              );
            }
            const frames = await page.evaluate(async () => {
              type Box = { text: string; left: number; right: number; top: number; bottom: number };
              const probe = window as unknown as { chartTextBoxes: Map<HTMLCanvasElement, Map<string, Box>>; chartMeasuredWidths: WeakMap<Element, number> };
              const result: { frame: number; errors: string[] }[] = [];
              for (let frame = 0; frame < 8; frame++) {
                await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
                const errors: string[] = [];
                for (const [chartIndex, element] of [...document.querySelectorAll('[aria-label="Date chart"]')].entries()) {
                  // ResizeObserver callbacks can follow rAF; inspect the layout
                  // once the browser has delivered them before painting.
                  if (probe.chartMeasuredWidths.get(element) !== element.clientWidth) {
                    if (frame === 7) errors.push(`chart ${chartIndex}: resize was never delivered`);
                    continue;
                  }
                  const canvas = element.querySelector("canvas");
                  if (!canvas) { errors.push(`chart ${chartIndex}: missing canvas`); continue; }
                  const boxes = [...(probe.chartTextBoxes.get(canvas)?.values() ?? [])];
                  if (!boxes.length) errors.push(`chart ${chartIndex}: missing labels`);
                  for (let i = 0; i < boxes.length; i++) {
                    const a = boxes[i];
                    if (a.left < -0.5 || a.top < -0.5 || a.right > canvas.width + 0.5 || a.bottom > canvas.height + 0.5) errors.push(`chart ${chartIndex}: clipped ${a.text}`);
                    for (const b of boxes.slice(i + 1)) {
                      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) errors.push(`chart ${chartIndex}: overlap ${a.text}/${b.text}`);
                    }
                  }
                  if (element.scrollWidth > element.clientWidth) errors.push(`chart ${chartIndex}: overflow (current ${element.clientWidth}, measured ${probe.chartMeasuredWidths.get(element)}, canvas ${canvas.clientWidth})`);
                }
                if (errors.length) result.push({ frame, errors });
              }
              return result;
            });
            failures.push(...frames.map(frame => ({ section, width, ...frame })));
            if (deviceScaleFactor === 1 && view === "month" && section === "Overview"
              && [1095, 1096, 1535, 1536].includes(width) && !capturedWidths.has(width)) {
              capturedWidths.add(width);
              await page.screenshot({ path: testInfo.outputPath(`health-breakpoint-${width}.png`) });
            }
          }
        }
        await testInfo.attach(`width-sweep-${view}`, { body: JSON.stringify({ chartSweep, widths, failures }, null, 2), contentType: "application/json" });
        expect(failures.slice(0, 12), `${failures.length} failing frames`).toEqual([]);
      });
    }
  });
}

for (const width of [390, 1096, 1536]) {
  test(`switches health resolution atomically at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await installHealthChartProbe(page);
    await mockApi(page);
    const release = new Map<string, () => Promise<void>>();
    await page.route(url => url.pathname === "/api/health/stats", async route => {
      const view = new URL(route.request().url()).searchParams.get("view");
      const count = view === "week" ? 7 : view === "year" ? 12 : 31;
      const value = view === "week" ? 2222 : view === "year" ? 3333 : 1111;
      const respond = () => route.fulfill({ json: {
        ...healthStats,
        activity: { ...healthStats.activity, avgSteps: value, totalSteps: value * count,
          byDay: Array.from({ length: count }, (_, i) => ({
            date: new Date(Date.UTC(2026, view === "year" ? i : 0, view === "year" ? 15 : i + 1)).toISOString().slice(0, 10),
            steps: value,
          })),
        },
      } });
      if (view === "month") await respond();
      else release.set(view ?? "", respond);
    });
    await page.goto("/health?view=month&section=activity");
    await expect(page.getByText("1,111", { exact: true })).toBeVisible();
    await expect(page.locator("canvas")).toBeVisible();
    await expectChartsReady(page);
    const readChart = () => page.evaluate(() => {
      type Box = { text: string; left: number; right: number; top: number; bottom: number };
      const probe = window as unknown as { chartTextBoxes: Map<HTMLCanvasElement, Map<string, Box>> };
      const region = document.querySelector<HTMLElement>('[aria-label="Date chart"]');
      const canvas = region?.querySelector("canvas");
      if (!region || !canvas) throw new Error("Missing date chart");
      const boxes = [...(probe.chartTextBoxes.get(canvas)?.values() ?? [])];
      const errors: string[] = [];
      for (const [i, a] of boxes.entries()) {
        if (a.left < -0.5 || a.right > canvas.width + 0.5 || a.top < -0.5 || a.bottom > canvas.height + 0.5) errors.push(`clipped ${a.text}`);
        for (const b of boxes.slice(i + 1)) {
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) errors.push(`overlap ${a.text}/${b.text}`);
        }
      }
      return { boxes, errors, height: region.clientHeight, canvasHeight: canvas.clientHeight, canvasWidth: canvas.clientWidth };
    });
    const month = await readChart();
    expect(month.boxes.length).toBeGreaterThan(0);
    for (const view of ["week", "year"]) {
      const before = await readChart();
      await page.locator("label").filter({ hasText: view === "week" ? /^Week$/ : /^Year$/ }).click();
      await expect.poll(() => release.has(view)).toBe(true);
      await expect(page.getByRole("status")).toHaveText("Loading health data...");
      for (let frame = 0; frame < 4; frame++) {
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(await readChart()).toEqual(before);
      }
      const respond = release.get(view);
      if (!respond) throw new Error(`Missing ${view} request`);
      await respond();
      await expect(page.getByText(view === "week" ? "2,222" : "3,333", { exact: true })).toBeVisible();
      let settled: Awaited<ReturnType<typeof readChart>> | undefined;
      for (let frame = 0; frame < 8; frame++) {
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))));
        const current = await readChart();
        expect(current.errors).toEqual([]);
        expect(current.canvasHeight).toBe(current.height);
        expect(current.boxes.some(box => box.text === (view === "week" ? "Thu" : "Mar"))).toBe(true);
        if (settled) expect(current).toEqual(settled);
        settled = current;
      }
    }
    await page.locator("label").filter({ hasText: /^Month$/ }).click();
    await expect(page.getByText("1,111", { exact: true })).toBeVisible();
    expect(await readChart()).toEqual(month);
  });
}
