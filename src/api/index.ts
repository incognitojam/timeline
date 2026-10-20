import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { timing, setMetric, startTime as timingStart, endTime as timingEnd } from "hono/timing";
import { existsSync, readFileSync } from "fs";
import { join, extname } from "path";
import { loadConfig } from "../config";
import { getDb, initDb, type TimelineEvent, type Attachment, type DiscordEmoji } from "../db/schema";
import { fetchEmojiOnDemand } from "../platforms/discord/emoji-downloader";
import {
  DbPool,
  type QueryExecutor,
  waitForQueryAbort,
  withQueryAbortSignal,
  withoutQueryAbortSignal,
  wrapDatabase,
} from "../db/pool";
import { getTimelineDbPath } from "../db/paths";
import {
  getAppStateDb,
  getTrackImageUrls,
  getPlaylistImageUrl,
  getCachedJournalSession,
} from "../db/app-state";
import { getTrackedPlaylists, getPlaylistObservations, getPlaylistMeta } from "../db/playlist-follows";
import { getMusicRankings, getRecentMusicPlays, isMusicPeriod } from "../db/music";
import { streamJournalQuestions, streamJournalReflection } from "../journal/questions";
import { statusRoutes } from "./status";
import { jobsRoutes } from "./jobs";
import { evalRoutes } from "./eval";
import { createSettingsRoutes } from "./settings";
import { createSyncSourceRoutes } from "./sync-sources";
import { AsyncTtlCache } from "./async-ttl-cache";
import {
  addDiscordForwardTargets,
  resolveDiscordForwardTargets,
} from "./discord-forward-references";
import {
  addDiscordReplyTargets,
  resolveDiscordReplyTargets,
} from "../lib/discord-reply-references";
import { mcpRoutes } from "./mcp";
import { generateStatusMarkdown, renderMarkdownToHtml } from "./status-md";
import { authMiddleware, authRoutes, isAuthEnabled, assertApiAuthConfigured } from "./auth";
import { createMcpHandler } from "./mcp-http";
import { configureBunSqliteForSqliteVec } from "../embeddings/sqlite-vec";
import { notConfiguredMessage } from "../embeddings/config";
import { getEmbeddingsDbPath } from "../embeddings/db";
import {
  DEFAULT_SEARCH_EXCLUDED_SOURCES,
  getSemanticSearchCandidateIds,
  openOnFirstUse,
  postProcessSemanticSearch,
  type SemanticSearch,
  searchEmbeddings,
} from "../embeddings/search";
import { convertLegacyEmoji } from "../db/emoji";
import { latestAttachmentDescriptionSelect } from "../export/attachment-descriptions";
import { getConfiguredAttachmentDescriptionModels } from "../sync/sources/attachment-descriptions";
import { getAttachmentDescriptionHistory } from "../sync/log";
import { getAttachmentDetail, getAttachmentsStats, listAttachments } from "../db/attachments";
import { listDateActivity, listDateActivityIndex } from "../db/date-activity";
import {
  ATTACHMENT_STATUSES,
  isAttachmentDescriptionImageDimension,
  MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION,
  MANUAL_ATTACHMENT_DESCRIPTION_PATH_PATTERN,
  MANUAL_ATTACHMENT_DESCRIPTION_TIMEOUT_MS,
  type AttachmentDescriptionEntry,
  type AttachmentStatus,
  type DescribeAttachmentRequest,
  type DescribeAttachmentResponse,
} from "../shared/attachments";
import {
  attachmentDescriptionEligibilityFilters,
  generateAttachmentDescription,
} from "../media/describe-attachments";
import { getMediaStore, readOrRestore } from "../media/storage";
import { streamDaySummary, SUMMARY_EXCLUDED_SOURCES } from "../summary/day-summary";
import { waitForModels, initProviders, getDefaultModel, getVisionAvailability, resolveLanguageModel } from "../llm";
import { PERSONAL_SOURCES } from "../shared/grouping";
import type { EventParticipant } from "../shared/types";
import { type ConversationRangeExportFormat, parseConversationRangeExportFormat } from "../shared/conversation-export";
import {
  HEALTH_WINDOW_ERROR,
  parseHealthWindow,
} from "../shared/health-periods";
import { runningVersionInfo } from "../version";
import { createReleaseRoutes } from "./releases";
import { loadConfig as loadGitHubConfig } from "../parsers/github-api";
import { findWebDistPath } from "../runtime-paths";
import {
  searchTimeline,
  hydrateEventsById,
  getEvents,
  getEventContext,
  getDayContext,
  getRecentEvents,
  listSources,
  getStats,
  getSummary,
  searchByLocation,
  getConversation,
  exportConversationRange,
  getConversationAround,
  getConversationMetadata,
  getConversationStats,
  getConversationMedia,
  listConversations,
  listConversationSources,
  listDiscordServers,
  getDiscordServer,
  createCursor,
  // Contact management
  createContact,
  updateContact,
  deleteContact,
  getContact,
  listContacts,
  countContacts,
  resolveAlias,
  searchByAlias,
  searchByContact,
  getContactSpotifySummary,
  getContactConversations,
  refreshStatsCache,
  invalidateStatsCache,
  invalidateHiddenClauseCaches,
  // Skipped identities
  skipIdentityByAlias,
  unskipIdentityByAlias,
  countSkippedIdentities,
  // Platform identities
  resolveIdentities,
  type ResolvedIdentity,
  getUnlinkedIdentities,
  countUnlinkedIdentities,
  linkIdentityToContact,
  batchLinkIdentitiesToContact,
  unlinkIdentity,
  skipIdentity,
  unskipIdentity,
  listSkippedIdentities,
  getIdentitiesForContact,
  getSuggestedContactsForIdentity,
  getIdentityLinkSuggestions,
  parseIdentifier,
  getIdentityByIdentifier,
  pickBestAvatar,
  // WakaTime / Coding Activity
  getWakaTimeStats,
  getWakaTimeProject,
  getWakaTimeProjectSessions,
  // Coding project AI conversations (cross-source)
  getCodingProjectConversations,
  getCodingProjects,
  // Map
  getMapEventsForDay,
  // Health
  getHealthStats,
  getBiomarkerResults,
  getDayHealthStats,
  // Manual events
  createManualEvent,
  updateManualEvent,
  updateJournalEvent,
  deleteManualEvent,
  // Transport events
  createTransportEvent,
  updateTransportEvent,
  TRANSPORT_MODES,
  // Contact memories
  createContactMemory,
  deleteContactMemory,
  getContactMemories,
} from "../db/queries";

// Fail before initializing databases or transports if the API would bind
// without authentication outside development.
if (process.env.NODE_ENV !== "test") {
  assertApiAuthConfigured();
  // Database init below can take a while (cold reads against a large
  // timeline.db) when this process owns it; log before it so a slow start isn't
  // mistaken for a hang. Under the service, init already happened.
  console.log("Starting Timeline API...");
}

// The semantic_search MCP tool loads sqlite-vec into embeddings.db, which requires
// selecting a sqlite-vec-capable SQLite library before any bun:sqlite database is
// opened in this process. Do it before getDb(). No-op unless
// TIMELINE_SQLITE_LIBRARY_PATH is set, so hosts without embeddings are unaffected.
configureBunSqliteForSqliteVec();

const db = getDb();
// The service initialises the database before starting the scheduler worker and
// sets this, so repeating it here would run schema work while syncs are already
// writing. Standalone runs (no flag) still initialise normally.
if (!process.env.TIMELINE_DB_INITIALIZED) {
  initDb(db);
}
// This bounded summary-table read stays on the main connection so it cannot
// queue behind unrelated long-running reads in the shared worker pool.
const dateActivityDb = wrapDatabase(db);
const readDbPool = await DbPool.create(getTimelineDbPath());
const readDb: QueryExecutor = readDbPool;
const apiConfig = await loadConfig();
// Vector search scans the whole index, so it runs on its own worker rather than
// the API thread or the shared read pool.
let embeddingsDbPool: DbPool | undefined;
const semanticSearch: SemanticSearch | undefined = apiConfig.embeddings && {
  config: apiConfig.embeddings,
  embeddingsDb: openOnFirstUse(async () => {
    embeddingsDbPool = await DbPool.create(getEmbeddingsDbPath(), { workers: 1, vectorSearch: true });
    return embeddingsDbPool;
  }),
};
const { handleMcpRequest, isMcpHttpEnabled, getMcpSessionCount } = createMcpHandler(readDb, db, {
  publicUrl: apiConfig.server.public_url,
  semanticSearch,
});

const CACHE_TTL_MS = 60 * 1000; // 1 minute
const cache = new AsyncTtlCache(CACHE_TTL_MS);

async function withServerTiming<T>(
  c: Context,
  name: string,
  description: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  timingStart(c, name, description);
  try {
    return await operation();
  } finally {
    timingEnd(c, name);
  }
}

async function getCached<T>(key: string, compute: () => T | Promise<T>, c?: Context): Promise<T> {
  // A cache fill can be shared by several requests, so it must outlive the
  // request that started it. Each caller still stops awaiting it on abort.
  const lookup = withoutQueryAbortSignal(() => cache.get(key, compute));
  if (lookup.status === "hit") {
    if (c) setMetric(c, "cache", `HIT ${key}`);
    return waitForQueryAbort(lookup.value);
  }

  if (c) timingStart(c, "cache", `${lookup.status === "miss" ? "MISS" : "COALESCED"} ${key}`);
  try {
    return await waitForQueryAbort(lookup.value);
  } finally {
    if (c) timingEnd(c, "cache");
  }
}

/** Parse a string as a strict integer — returns NaN for non-numeric strings like "4abc". */
function parseIntStrict(value: string): number {
  return /^\d+$/.test(value) ? Number(value) : NaN;
}

function invalidateContactsCaches() {
  cache.deleteWhere((key) => key.startsWith("contacts"));
}

/**
 * A contact or identity mapping changed (rename, link, unlink, hide, skip,
 * delete). Discord server pages resolve participants and emoji uploaders
 * through contacts (and drop hidden ones), so cached guild pages go stale
 * too. Event CRUD only needs the contact-list caches.
 */
function invalidateContactMappingCaches() {
  invalidateContactsCaches();
  cache.deleteWhere((key) => key.startsWith("discord-server"));
}

/** The set of hidden events changed: every hidden-filtered aggregate is stale. */
function invalidateHiddenVisibilityCaches() {
  invalidateHiddenClauseCaches();
  invalidateStatsCache(db);
  cache.delete("stats");
  cache.delete("sources");
}

function summarizeQueryForLogs(url: URL): { queryKeys: string[]; query: Record<string, number> } {
  const queryKeys = [...new Set(url.searchParams.keys())].sort();
  const query: Record<string, number> = {};
  for (const key of ["limit", "offset"]) {
    const value = url.searchParams.get(key);
    if (value && /^\d+$/.test(value)) {
      query[key] = Number(value);
    }
  }
  return { queryKeys, query };
}

// Track service start time for uptime
const startTime = Date.now();

if (runningVersionInfo) {
  const release = runningVersionInfo.version
    ? `${runningVersionInfo.version}${runningVersionInfo.build ? ` build ${runningVersionInfo.build}` : ""}, `
    : "";
  console.log(`Running version: ${release}${runningVersionInfo.commit} (${runningVersionInfo.branch})`);
}

const webDistPath = findWebDistPath();
if (process.env.NODE_ENV !== "test") {
  if (webDistPath) {
    console.log(`Serving static files from ${webDistPath}`);
  } else {
    console.log("No web/dist found - frontend not available (run: cd web && bun run build)");
  }
}


// Create Hono app
const app = new Hono();

app.onError((error, c) => {
  if (c.req.raw.signal.aborted && error.name === "AbortError") {
    return new Response(JSON.stringify({ error: "Request cancelled" }), {
      status: 499,
      headers: { "Content-Type": "application/json" },
    });
  }
  console.error(error);
  return c.text("Internal Server Error", 500);
});

// Server-Timing header (visible in browser DevTools > Network > Timing)
app.use("*", timing());

const SLOW_REQUEST_MS = 100;
let activeApiRequests = 0;

// Log structured API request completions to journald-friendly stdout.
app.use("*", async (c, next) => {
  const isApiRequest = c.req.path.startsWith("/api/");
  const activeAtStart = isApiRequest ? ++activeApiRequests : activeApiRequests;
  const start = performance.now();
  try {
    await next();
  } finally {
    const durationMs = Math.round(performance.now() - start);

    if (isApiRequest) {
      const activeAtEnd = activeApiRequests - 1;
      activeApiRequests = activeAtEnd;
      const url = new URL(c.req.url);
      const querySummary = summarizeQueryForLogs(url);
      const dbPool = readDbPool.getStats();
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "request.complete",
          method: c.req.method,
          path: url.pathname,
          queryKeys: querySummary.queryKeys,
          query: querySummary.query,
          status: c.res.status,
          durationMs,
          slow: durationMs > SLOW_REQUEST_MS,
          slowThresholdMs: SLOW_REQUEST_MS,
          activeAtStart,
          activeAtEnd,
          dbPool,
        }),
      );
      setMetric(c, "dbpool.pending", dbPool.pending, "pending query count");
      setMetric(c, "requests.active", activeAtEnd, "active API request count");
    }
  }
});

// Associate every database dispatch with the originating HTTP request. Aborting
// the request stops the handler from awaiting current work and prevents its
// later queries from being dispatched; SQLite execution itself is not interrupted.
app.use("*", async (c, next) => {
  await withQueryAbortSignal(c.req.raw.signal, next);
});

// Auth middleware (must be before cors so it runs first on API routes)
app.use("/api/*", authMiddleware);
for (const path of ["/status", "/status.md"]) {
  app.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    return authMiddleware(c, next);
  });
}

// CORS middleware
app.use("*", cors());

// Mount sub-routes
app.route("/", authRoutes);
app.route("/", statusRoutes);
app.route("/", jobsRoutes);
app.route("/", mcpRoutes);
app.route("/", evalRoutes);
app.route("/", createSyncSourceRoutes(apiConfig.scheduler.default_interval));
app.route("/", createSettingsRoutes());
app.route("/", createReleaseRoutes({
  repository: process.env.TIMELINE_RELEASE_REPOSITORY ?? "incognitojam/timeline",
  token: () => process.env.GITHUB_TOKEN ?? loadGitHubConfig()?.token,
  runningVersion: runningVersionInfo,
}));

// MCP HTTP endpoint - NOT under /api/ so it bypasses cookie auth.
// Supports bearer auth at /mcp and legacy token-in-URL auth at /mcp/<token>.
app.all("/mcp/:token", async (c) => {
  const token = c.req.param("token");
  return handleMcpRequest(c.req.raw, token);
});

app.all("/mcp", async (c) => handleMcpRequest(c.req.raw));
app.all("/mcp/", async (c) => handleMcpRequest(c.req.raw));

// Health check endpoint
app.get("/api/health", async (c) => {
  return c.json({
    status: "healthy",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    database: "connected",
    mcp: isMcpHttpEnabled() ? { enabled: true, sessions: getMcpSessionCount() } : { enabled: false },
    version: runningVersionInfo,
  });
});

// Search endpoints
// exclude_sources absent → default noisy-source excludes; present (even empty,
// meaning "exclude nothing") → the caller's comma-separated list. Sources the
// caller explicitly filters to are never excluded — an explicit filter wins.
function resolveExcludedSources(excludeParam: string | undefined, sourceParam?: string): string[] {
  const excluded = excludeParam === undefined
    ? [...DEFAULT_SEARCH_EXCLUDED_SOURCES]
    : excludeParam.split(",").map((source) => source.trim()).filter(Boolean);
  if (!sourceParam) return excluded;
  const requested = new Set(sourceParam.split(",").map((source) => source.trim()).filter(Boolean));
  return excluded.filter((source) => !requested.has(source));
}

app.get("/api/search", async (c) => {
  const query = c.req.query();
  const limit = query.limit ? parseInt(query.limit) : 50;
  const cursor = query.cursor;

  timingStart(c, "db", "SQLite Search");
  const events = await searchTimeline(readDb, {
    query: query.q,
    source: query.source,
    type: query.type,
    startDate: query.startDate,
    endDate: query.endDate,
    chat: query.chat,
    limit,
    cursor: cursor,
    sort: query.sort as "asc" | "desc" | undefined,
    excludeSources: resolveExcludedSources(query.exclude_sources, query.source),
  });
  timingEnd(c, "db");

  // Generate next cursor from last event
  const lastEvent = events[events.length - 1];
  const nextCursor = events.length === limit && lastEvent ? createCursor(lastEvent) : null;

  return c.json({ events, count: events.length, nextCursor });
});

// Semantic (vector) search over the embeddings index. Unlike /api/search there
// is no cursor pagination: KNN returns the top-k nearest in one shot.
app.get("/api/search/semantic", async (c) => {
  const query = c.req.query("q")?.trim();
  if (!query) {
    return c.json({ error: "q is required" }, 400);
  }
  const limitParam = c.req.query("limit");
  const limit = limitParam === undefined ? 25 : parseIntStrict(limitParam);
  if (Number.isNaN(limit) || limit < 1 || limit > 50) {
    return c.json({ error: "limit must be an integer between 1 and 50" }, 400);
  }
  if (!semanticSearch) {
    return c.json({ error: notConfiguredMessage() }, 503);
  }

  const excludedSources = new Set(resolveExcludedSources(c.req.query("exclude_sources")));

  // Over-fetch: KNN bounds documents (which can map to several events), stale
  // ids are dropped after hydration, and excluded sources can dominate a
  // neighbourhood, so the top-k documents may yield far fewer visible events.
  const candidateLimit = Math.min(limit * 10, 250);
  timingStart(c, "embed", "Embed query + KNN");
  let hits: Awaited<ReturnType<typeof searchEmbeddings>>;
  try {
    hits = await searchEmbeddings(semanticSearch, query, candidateLimit);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: `Semantic search failed: ${message}` }, 500);
  }
  timingEnd(c, "embed");

  timingStart(c, "db", "Hydrate events");
  const { events: candidates } = await hydrateEventsById(readDb, getSemanticSearchCandidateIds(hits));
  timingEnd(c, "db");

  const events = postProcessSemanticSearch(hits, candidates, excludedSources, limit);

  return c.json({ events, count: events.length });
});

app.get("/api/events", async (c) => {
  const query = c.req.query();
  timingStart(c, "db", "Events");
  const events = await getEvents(readDb, {
    date: query.date,
    startDate: query.startDate,
    endDate: query.endDate,
    source: query.source,
    type: query.type,
    limit: query.limit ? parseInt(query.limit) : 100,
  });
  timingEnd(c, "db");
  return c.json({ events, count: events.length });
});

app.get("/api/events/:id", async (c) => {
  const id = c.req.param("id");
  const event = await readDb.get<TimelineEvent>("SELECT * FROM events WHERE id = ?", parseInt(id));
  if (!event) {
    return c.json({ error: "Event not found" }, 404);
  }
  return c.json({
    event: {
      ...event,
      title: convertLegacyEmoji(event.title),
      content: convertLegacyEmoji(event.content),
    },
  });
});

app.get("/api/events/:id/context", async (c) => {
  const id = c.req.param("id");
  const query = c.req.query();
  const events = await getEventContext(readDb, {
    eventId: parseInt(id),
    hoursWindow: query.hours ? parseInt(query.hours) : 2,
    limit: query.limit ? parseInt(query.limit) : 50,
  });
  return c.json({ events, count: events.length });
});

app.get("/api/events/:id/attachments", (c) => {
  const id = c.req.param("id");
  const descriptionSelect = latestAttachmentDescriptionSelect("ad.description", preferredAttachmentDescriptionModels());
  const attachments = db
    .prepare(`
      SELECT a.*, ${descriptionSelect.sql} AS description
      FROM attachments a
      WHERE a.event_id = ?
      ORDER BY a.id
    `)
    .all(...descriptionSelect.params, parseInt(id)) as Array<Attachment & { description: string | null }>;
  return c.json({ attachments, count: attachments.length });
});

app.get("/api/attachments", async (c) => {
  const query = c.req.query();
  const limit = query.limit === undefined ? 100 : parseIntStrict(query.limit);
  if (Number.isNaN(limit) || limit < 1 || limit > 500) {
    return c.json({ error: "limit must be an integer between 1 and 500" }, 400);
  }
  if (query.mime !== undefined && !["image", "video", "audio"].includes(query.mime)) {
    return c.json({ error: "mime must be image, video, or audio" }, 400);
  }
  if (query.described !== undefined && query.described !== "true" && query.described !== "false") {
    return c.json({ error: "described must be true or false" }, 400);
  }
  if (query.status !== undefined && !ATTACHMENT_STATUSES.includes(query.status as AttachmentStatus)) {
    return c.json({ error: "status must be pending, stored, failed, or unrecoverable" }, 400);
  }

  try {
    return c.json(await withServerTiming(c, "attachments.list", "List Attachments", () => listAttachments(readDb, {
      limit,
      cursor: query.cursor,
      mime: query.mime as "image" | "video" | "audio" | undefined,
      source: query.source,
      // Attachments have no implicit noisy-source exclusions. The gallery sends
      // its chosen exclusions explicitly so direct API callers still get all sources.
      excludeSources: resolveExcludedSources(query.exclude_sources ?? "", query.source),
      described: query.described === undefined ? undefined : query.described === "true",
      status: query.status as AttachmentStatus | undefined,
      preferredDescriptionModels: preferredAttachmentDescriptionModels(),
    })));
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid attachments cursor") {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }
});

app.get("/api/attachments/stats", async (c) =>
  c.json(await withServerTiming(c, "attachments.stats", "Attachment Stats", () => getAttachmentsStats(readDb))),
);

app.get("/api/attachments/description-history", async (c) =>
  c.json(await withServerTiming(
    c,
    "attachments.description-history",
    "Attachment Description History",
    () => ({ points: getAttachmentDescriptionHistory(getAppStateDb()) }),
  )),
);

app.get("/api/attachments/:id", async (c) => {
  const id = parseIntStrict(c.req.param("id"));
  if (!Number.isSafeInteger(id)) return c.json({ error: "Attachment not found" }, 404);
  const detail = await getAttachmentDetail(readDb, id, preferredAttachmentDescriptionModels());
  if (!detail) return c.json({ error: "Attachment not found" }, 404);
  return c.json(detail);
});

interface DescribableAttachment {
  content_hash: string;
  storage_path: string | null;
  mime_type: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attachmentDescriptionOptionsError(request: Partial<DescribeAttachmentRequest>): string | undefined {
  if (request.reasoningEffort !== undefined && typeof request.reasoningEffort !== "string") {
    return "reasoningEffort must be a string";
  }
  if (request.maxImageDimension !== undefined && !isAttachmentDescriptionImageDimension(request.maxImageDimension)) {
    return `maxImageDimension must be an integer between 1 and ${MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION}`;
  }
}

app.post("/api/attachments/:id/describe", async (c) => {
  const id = parseIntStrict(c.req.param("id"));
  if (!Number.isSafeInteger(id)) return c.json({ error: "Attachment not found" }, 404);
  if (!db.prepare("SELECT 1 FROM attachments WHERE id = ?").get(id)) {
    return c.json({ error: "Attachment not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Expected JSON object body" }, 400);
  }
  const request = body as Partial<DescribeAttachmentRequest>;
  if (typeof request.model !== "string" || !request.model.trim()) {
    return c.json({ error: "model is required and must be a non-empty string" }, 400);
  }
  const optionsError = attachmentDescriptionOptionsError(request);
  if (optionsError) return c.json({ error: optionsError }, 400);

  const attachment = db.prepare(`
    SELECT content_hash, storage_path, mime_type
    FROM attachments a
    WHERE a.id = ? AND ${attachmentDescriptionEligibilityFilters("a").join(" AND ")}
  `).get(id) as DescribableAttachment | undefined;
  if (!attachment) {
    return c.json({
      error: "Attachment is not eligible for description: it must be a stored image with a content hash",
    }, 400);
  }
  if (!attachment.storage_path) {
    return c.json({ error: "Attachment media file is missing" }, 404);
  }

  const model = request.model.trim();
  const visionAvailability = await getVisionAvailability(apiConfig.llm, model);
  if (visionAvailability === "not-vision") {
    return c.json({ error: `Model ${model} is not vision-capable` }, 400);
  }
  if (visionAvailability === "unavailable") {
    return c.json({ error: `Model ${model} is unavailable` }, 503);
  }

  let mediaFile: Awaited<ReturnType<typeof readOrRestore>>;
  try {
    const store = await getMediaStore();
    mediaFile = await readOrRestore(store, attachment.storage_path, () => attachment.content_hash);
  } catch (error) {
    return c.json({ error: `Failed to read attachment media: ${errorMessage(error)}` }, 502);
  }
  if (!mediaFile) return c.json({ error: "Attachment media file is missing" }, 404);

  const timeout = AbortSignal.timeout(MANUAL_ATTACHMENT_DESCRIPTION_TIMEOUT_MS);
  const startedAt = Date.now();
  let description: string;
  try {
    description = await generateAttachmentDescription({
      model: resolveLanguageModel(model),
      image: Buffer.from(mediaFile.content),
      mediaType: attachment.mime_type,
      reasoningEffort: request.reasoningEffort,
      maxImageDimension: request.maxImageDimension,
      abortSignal: timeout,
    });
  } catch (error) {
    if (timeout.aborted) return c.json({ error: "Description generation timed out" }, 504);
    return c.json({ error: `Description generation failed: ${errorMessage(error)}` }, 502);
  }
  if (!description) return c.json({ error: "Model returned an empty description" }, 502);

  const durationMs = Date.now() - startedAt;
  db.prepare(`
    INSERT OR REPLACE INTO attachment_descriptions (content_hash, model, description, duration_ms)
    VALUES (?, ?, ?, ?)
  `).run(attachment.content_hash, model, description, durationMs);
  const row = db.prepare(`
    SELECT
      model,
      description,
      strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS createdAt,
      duration_ms AS durationMs
    FROM attachment_descriptions
    WHERE content_hash = ? AND model = ?
  `).get(attachment.content_hash, model) as AttachmentDescriptionEntry | undefined;
  if (!row) throw new Error("Description write did not return a row");
  return c.json<DescribeAttachmentResponse>(row, 201);
});

// Media file serving endpoint
app.get("/api/media/*", async (c) => {
  const rawPath = c.req.path.replace("/api/media/", "");
  // Decode URL encoding and check for path traversal
  const path = decodeURIComponent(rawPath);
  if (!path || path.includes("..") || path.startsWith("/")) {
    return c.json({ error: "Invalid path" }, 400);
  }

  try {
    const store = await getMediaStore();
    // Local miss: restore from the durable backend if it has this blob. The
    // remote is keyed by content hash, so map the storage path via the
    // attachments row (indexed). The lookup runs only on a miss, keeping local
    // hits fast.
    const mediaFile = await readOrRestore(
      store,
      path,
      () =>
        (
          db
            .prepare(
              "SELECT content_hash FROM attachments WHERE storage_path = ? AND content_hash IS NOT NULL LIMIT 1",
            )
            .get(path) as { content_hash: string } | undefined
        )?.content_hash,
    );
    if (!mediaFile) {
      return c.json({ error: "File not found" }, 404);
    }

    // Determine content type from extension
    const ext = extname(path).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".m4a": "audio/mp4",
      ".aac": "audio/aac",
      ".pdf": "application/pdf",
      ".txt": "text/plain; charset=utf-8",
      ".md": "text/markdown; charset=utf-8",
      ".csv": "text/csv; charset=utf-8",
      ".json": "application/json",
      ".zip": "application/zip",
    };
    const contentType = mimeTypes[ext] || "application/octet-stream";

    return c.body(mediaFile.content, 200, {
      "Content-Type": contentType,
      "Content-Length": String(mediaFile.fileSize),
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  } catch (error) {
    console.error("Error serving media file:", error);
    return c.json({ error: "Failed to serve file" }, 500);
  }
});

// Discord custom emoji image serving. The :id may include an extension
// (`.png`/`.gif`) for legibility; it's stripped — the stored row's `ext`
// determines the actual file served.
app.get("/api/discord/emoji/:id", async (c) => {
  const rawId = c.req.param("id");
  const emojiId = rawId.replace(/\.(png|gif|webp)$/i, "");
  if (!/^\d+$/.test(emojiId)) {
    return c.json({ error: "Invalid emoji id" }, 400);
  }

  let row = db
    .prepare("SELECT * FROM discord_emojis WHERE emoji_id = ?")
    .get(emojiId) as DiscordEmoji | null;

  // Proxy-on-miss: pending or unknown rows trigger a single CDN fetch + store.
  // Subsequent requests fall through to the fast read path below.
  if (!row || row.status === "pending") {
    try {
      await fetchEmojiOnDemand(db, emojiId);
      row = db
        .prepare("SELECT * FROM discord_emojis WHERE emoji_id = ?")
        .get(emojiId) as DiscordEmoji | null;
    } catch (err) {
      console.error(`[discord] On-demand emoji fetch failed for ${emojiId}:`, err);
      return c.json({ error: "Emoji fetch failed" }, 502);
    }
  }

  if (!row) return c.json({ error: "Not found" }, 404);

  if (row.status === "tombstoned") {
    return c.body(null, 404, {
      "Cache-Control": "public, max-age=86400",
    });
  }

  if (row.status !== "stored" || !row.storage_path || !row.ext) {
    return c.json({ error: "Emoji not available" }, 404);
  }

  try {
    // Stored emoji are written through to R2, so restore from it on a local
    // miss (the row already carries the content hash) instead of 404ing.
    const store = await getMediaStore();
    const mediaFile = await readOrRestore(store, row.storage_path, () => row.content_hash);
    if (!mediaFile) {
      return c.json({ error: "File not found" }, 404);
    }
    return c.body(mediaFile.content, 200, {
      "Content-Type": row.ext === "gif" ? "image/gif" : "image/png",
      "Content-Length": String(mediaFile.fileSize),
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  } catch (err) {
    console.error(`[discord] Failed to serve emoji ${emojiId}:`, err);
    return c.json({ error: "Failed to serve emoji" }, 500);
  }
});

// Spotify track image URL lookups from cached spotify_resources
app.get("/api/spotify/track-images", (c) => {
  const urisParam = c.req.query("uris");
  if (!urisParam) return c.json({});
  const uris = urisParam.split(",").filter(Boolean).slice(0, 200);
  const appDb = getAppStateDb();
  const imageMap = getTrackImageUrls(appDb, uris);
  return c.json(Object.fromEntries(imageMap));
});

app.get("/api/music/recent", (c) => {
  const limitParam = parseIntStrict(c.req.query("limit") ?? "10");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 10;
  const recent = getRecentMusicPlays(db, limit);
  const uris = recent.map((play) => play.trackUri).filter((uri): uri is string => uri !== null);
  const cachedImages = getTrackImageUrls(getAppStateDb(), uris);
  return c.json({
    recent: recent.map((play) => ({
      ...play,
      imageUrl: play.imageUrl ?? (play.trackUri ? cachedImages.get(play.trackUri) ?? null : null),
    })),
  });
});

app.get("/api/music/rankings", (c) => {
  const periodParam = c.req.query("period") ?? "4w";
  if (!isMusicPeriod(periodParam)) {
    return c.json({ error: "Invalid music period. Expected 4w, 6m, 12m, or all." }, 400);
  }

  const overview = getMusicRankings(db, periodParam);
  const uris = Array.from(new Set([
    ...overview.topTracks.map((track) => track.trackUri),
    ...overview.topArtists.map((artist) => artist.latestTrackUri),
  ].filter((uri): uri is string => uri !== null)));
  const cachedImages = getTrackImageUrls(getAppStateDb(), uris);
  const withCachedImage = <T extends { imageUrl: string | null }>(item: T, uri: string | null): T => ({
    ...item,
    imageUrl: item.imageUrl ?? (uri ? cachedImages.get(uri) ?? null : null),
  });

  return c.json({
    ...overview,
    topTracks: overview.topTracks.map((track) => withCachedImage(track, track.trackUri)),
    topArtists: overview.topArtists.map((artist) => withCachedImage(artist, artist.latestTrackUri)),
  });
});

interface LatestFriendListenRow {
  eventId: number;
  person: string;
  spotifyId: string;
  contactId: number | null;
  contactName: string | null;
  identityName: string | null;
  identityAvatarUrl: string | null;
  rawUserName: string | null;
  timestamp: string;
  trackName: string;
  artistName: string | null;
  albumName: string | null;
  imageUrl: string | null;
}

app.get("/api/music/friends/latest", (c) => {
  const limitParam = parseIntStrict(c.req.query("limit") ?? "50");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 50;
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT
        e.id,
        ep.person,
        e.timestamp,
        e.title,
        e.tags,
        e.raw_data,
        ROW_NUMBER() OVER (PARTITION BY ep.person ORDER BY e.timestamp DESC, e.id DESC) AS rn
      FROM event_people ep
      JOIN events e ON e.id = ep.event_id
      WHERE ep.source = 'spotify-friends'
        AND e.source = 'spotify-friends'
        AND e.type = 'listen:track:friend'
        AND ep.person LIKE 'spotify:%'
        AND e.timestamp IS NOT NULL
    )
    SELECT
      ranked.id AS eventId,
      ranked.person AS person,
      substr(ranked.person, length('spotify:') + 1) AS spotifyId,
      c.id AS contactId,
      c.display_name AS contactName,
      i.display_name AS identityName,
      i.avatar_url AS identityAvatarUrl,
      json_extract(ranked.raw_data, '$.user.name') AS rawUserName,
      ranked.timestamp AS timestamp,
      ranked.title AS trackName,
      (
        SELECT substr(tag.value, length('artist:') + 1)
        FROM json_each(ranked.tags) tag
        WHERE tag.value LIKE 'artist:%'
        LIMIT 1
      ) AS artistName,
      json_extract(ranked.raw_data, '$.track.album.name') AS albumName,
      json_extract(ranked.raw_data, '$.track.imageUrl') AS imageUrl
    FROM ranked
    LEFT JOIN identities i
      ON i.platform = 'spotify'
      AND i.platform_id = substr(ranked.person, length('spotify:') + 1)
    LEFT JOIN contacts c ON c.id = i.contact_id
    WHERE ranked.rn = 1
      AND (c.hidden IS NULL OR c.hidden = 0)
    ORDER BY ranked.timestamp DESC, ranked.id DESC
    LIMIT ?
  `).all(limit) as LatestFriendListenRow[];

  return c.json({
    friends: rows.map((row) => ({
      eventId: row.eventId,
      person: row.person,
      spotifyId: row.spotifyId,
      contactId: row.contactId,
      name: row.contactName ?? row.identityName ?? row.rawUserName ?? row.spotifyId,
      avatarUrl: row.identityAvatarUrl,
      timestamp: row.timestamp,
      trackName: row.trackName,
      artistName: row.artistName,
      albumName: row.albumName,
      imageUrl: row.imageUrl,
    })),
  });
});

// Tracked playlists with their follower-count time series (the "saves"/likes
// number). Each playlist includes a compact series for sparklines; the overview
// derives deltas client-side. See the spotify-playlists sync source.
app.get("/api/playlists", (c) => {
  const appDb = getAppStateDb();
  const playlists = getTrackedPlaylists(db).map((p) => {
    const series = getPlaylistObservations(db, p.playlist_id).map((o) => ({
      date: o.observed_date,
      count: o.follower_count,
    }));
    return {
      playlistId: p.playlist_id,
      name: p.name,
      imageUrl: getPlaylistImageUrl(appDb, p.playlist_id),
      latestCount: p.latest_count,
      latestDate: p.latest_date,
      firstDate: p.first_date,
      // Best-effort creation date (earliest track add), to YYYY-MM-DD for the
      // UI's date formatter; null until the sync has resolved it.
      createdDate: p.created_at ? p.created_at.slice(0, 10) : null,
      observations: p.observations,
      series,
    };
  });
  return c.json({ playlists });
});

// Full follower-count history for one playlist (oldest first), for the
// drilldown chart + table. Returns an empty series for untracked IDs.
app.get("/api/playlists/:id", (c) => {
  const id = c.req.param("id");
  const rows = getPlaylistObservations(db, id);
  const latest = rows.at(-1);
  const meta = getPlaylistMeta(db, id);
  return c.json({
    playlistId: id,
    name: latest?.name ?? null,
    imageUrl: getPlaylistImageUrl(getAppStateDb(), id),
    // Best-effort creation date (earliest track add), date-only for the UI's
    // formatter; null until the sync has resolved it. Drives the chart's
    // artificial 0-saves anchor and the creation-anchored estimates.
    createdDate: meta?.created_at ? meta.created_at.slice(0, 10) : null,
    observations: rows.map((o) => ({
      date: o.observed_date,
      count: o.follower_count,
      origin: o.origin,
    })),
  });
});

// Sources whose attachments should be sent inline with /api/day responses so
// the dashboard can render rich media cards without a per-event fetch.
const DAY_ATTACHMENT_SOURCES = new Set(["recall"]);

app.get("/api/day", async (c) => {
  const query = c.req.query();
  timingStart(c, "db", "Day Context");
  const result = await getDayContext(readDb, {
    eventId: query.eventId ? parseInt(query.eventId) : undefined,
    timestamp: query.timestamp,
    date: query.date,
  });
  timingEnd(c, "db");

  if (!result) {
    return c.json({ error: "Could not determine date from provided parameters" }, 400);
  }

  // Inline attachments for media-bearing sources (e.g. recall screen captures).
  // Limiting by source keeps the payload small; other sources fetch on demand.
  const mediaEventIds = result.events
    .filter((e) => DAY_ATTACHMENT_SOURCES.has(e.source))
    .map((e) => e.id);
  const attachments: Record<number, Attachment[]> = {};
  if (mediaEventIds.length > 0) {
    timingStart(c, "db-att", "Day Attachments");
    const attachmentMap = getAttachmentsForEvents(mediaEventIds, preferredAttachmentDescriptionModels());
    for (const [eventId, atts] of attachmentMap) {
      attachments[eventId] = atts;
    }
    timingEnd(c, "db-att");
  }

  return c.json({ ...result, attachments });
});

app.get("/api/summary/models", async (c) => {
  return c.json({ models: await waitForModels() });
});

app.get("/api/day/:date/summary", (c) => {
  const date = c.req.param("date");
  const query = c.req.query();
  const model = query.model || getDefaultModel();
  const regenerate = query.regenerate === "true";

  const appDb = getAppStateDb();
  const stream = streamDaySummary(readDb, appDb, {
    date,
    model,
    forceRegenerate: regenerate,
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});

// Journal endpoints
app.post("/api/journal/:date/questions", async (c) => {
  const date = c.req.param("date");
  const body = await c.req.json().catch(() => ({}));
  const model = body.model || getDefaultModel();
  const regenerate = body.regenerate === true;

  const appDb = getAppStateDb();
  const stream = streamJournalQuestions(readDb, appDb, {
    date,
    model,
    regenerate,
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});

app.get("/api/journal/:date", async (c) => {
  const date = c.req.param("date");
  const model = c.req.query("model") || getDefaultModel();

  const appDb = getAppStateDb();
  const session = getCachedJournalSession(appDb, date, model);

  // Get existing journal events for this date
  const journalEvents = await getEvents(readDb, { date, source: "journal", limit: 1000 });
  const latestQaEvents = new Map<string, TimelineEvent>();
  let latestReflectionEvent: TimelineEvent | null = null;
  for (const event of journalEvents) {
    if (event.type === "journal:qa" && event.title) {
      const existing = latestQaEvents.get(event.title);
      if (!existing || event.id > existing.id) {
        latestQaEvents.set(event.title, event);
      }
    } else if (event.type === "journal:reflection") {
      if (!latestReflectionEvent || event.id > latestReflectionEvent.id) {
        latestReflectionEvent = event;
      }
    }
  }

  // Build context groups for cited group_ids
  const allCitedGroupIds = new Set<string>();
  for (const q of session?.questions ?? []) {
    if (q.group_ids) {
      for (const id of q.group_ids) allCitedGroupIds.add(id);
    }
  }

  let contextGroups: Record<string, { id: string; source: string; label: string; summary: string; eventCount: number; timeRange: { start: string | null; end: string | null }; participants?: string[] }> = {};
  if (allCitedGroupIds.size > 0) {
    // Re-derive groups from day events
    const dayEvents = (await getEvents(readDb, { date, limit: 10000 })).filter(
      (e) => !SUMMARY_EXCLUDED_SOURCES.has(e.source),
    );
    const { groupEvents } = await import("../shared/grouping");
    const groups = groupEvents(dayEvents);
    for (const group of groups) {
      if (allCitedGroupIds.has(group.id)) {
        contextGroups[group.id] = {
          id: group.id,
          source: group.source,
          label: group.label,
          summary: group.summary,
          eventCount: group.events.length,
          timeRange: group.timeRange,
          participants: group.participants,
        };
      }
    }
  }

  // Match cached questions with existing answers
  const questions = (session?.questions ?? []).map((q) => {
    const answered = latestQaEvents.get(q.question);
    return {
      ...q,
      answered: !!answered,
      answer: answered?.content ?? undefined,
      event_id: answered?.id ?? undefined,
    };
  });

  return c.json({
    date,
    questions,
    contextGroups,
    reflection: latestReflectionEvent
      ? { content: latestReflectionEvent.content, event_id: latestReflectionEvent.id }
      : null,
    cached: !!session,
  });
});

app.post("/api/journal/:date/answer", async (c) => {
  const date = c.req.param("date");
  const body = await c.req.json();

  if (!body.question || typeof body.question !== "string") {
    return c.json({ error: "question is required" }, 400);
  }
  if (!body.answer || typeof body.answer !== "string" || body.answer.trim() === "") {
    return c.json({ error: "answer is required" }, 400);
  }
  if (
    body.event_id !== undefined &&
    (!Number.isInteger(body.event_id) || body.event_id <= 0)
  ) {
    return c.json({ error: "event_id must be a positive integer" }, 400);
  }

  const importBatch = `journal_${date}`;
  const sourceId = `journal_${date}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  const rawData = {
    journal: {
      date,
      question_index: body.question_index ?? 0,
      question_category: body.question_category ?? "open",
      group_ids: Array.isArray(body.group_ids) ? body.group_ids : undefined,
      model: body.model ?? getDefaultModel(),
    },
    origin: {
      type: "user",
      created_via: "web-ui",
      created_at: new Date().toISOString(),
    },
  };

  try {
    const eventType = body.type === "journal:reflection" ? "journal:reflection" : "journal:qa";
    const timestamp = `${date}T23:59:00.000Z`;
    const isUpdate = typeof body.event_id === "number";
    let event: TimelineEvent | null;

    if (isUpdate) {
      event = updateJournalEvent(db, body.event_id, {
        type: eventType,
        timestamp,
        title: body.question,
        content: body.answer.trim(),
        importBatch,
        rawData,
      });
      if (!event) {
        return c.json({ error: "Event not found" }, 404);
      }
    } else {
      const result = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp,
          title, content, import_batch, raw_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "journal",
        sourceId,
        "user",
        eventType,
        timestamp,
        body.question,
        body.answer.trim(),
        importBatch,
        JSON.stringify(rawData),
      );

      const eventId = Number(result.lastInsertRowid);
      event = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as TimelineEvent | null;
    }

    cache.delete("stats");
    cache.delete("sources");
    return c.json({ event }, isUpdate ? 200 : 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save answer";
    return c.json({ error: message }, 500);
  }
});

app.post("/api/journal/:date/reflection", async (c) => {
  const date = c.req.param("date");
  const body = await c.req.json().catch(() => ({}));
  const model = body.model || getDefaultModel();

  // Fetch existing Q&A answers
  const journalEvents = await getEvents(readDb, { date, source: "journal", limit: 1000 });
  const latestQaEvents = new Map<string, TimelineEvent>();
  for (const event of journalEvents) {
    if (event.type !== "journal:qa" || !event.content || !event.title) continue;
    const existing = latestQaEvents.get(event.title);
    if (!existing || event.id > existing.id) {
      latestQaEvents.set(event.title, event);
    }
  }
  const qaEvents = Array.from(latestQaEvents.values());

  if (qaEvents.length === 0) {
    return c.json({ error: "No journal answers found for this date" }, 400);
  }

  const qaPairs = qaEvents.map((e) => ({
    question: e.title ?? "",
    answer: e.content ?? "",
  }));

  const stream = streamJournalReflection(readDb, { date, model, qaPairs });
  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
});

// Map endpoints
app.get("/api/map/day/:date", async (c) => {
  const date = c.req.param("date");
  const query = c.req.query();

  // Parse types filter (comma-separated)
  const types = query.types ? query.types.split(",").map((t) => t.trim()) : undefined;

  const events = await getMapEventsForDay(readDb, date, { types });
  return c.json({ events, count: events.length });
});

// Health endpoints
app.get("/api/health/stats", async (c) => {
  const query = c.req.query();

  const window = parseHealthWindow({
    view: query.view,
    mode: query.mode,
    anchor: query.anchor,
  });
  if (!window) return c.json({ error: HEALTH_WINDOW_ERROR }, 400);

  const stats = await getHealthStats(readDb, {
    view: window.view,
    mode: window.mode,
    startDate: window.range.start,
    endDate: window.range.end,
  });
  return c.json(stats);
});

app.get("/api/health/biomarkers", async (c) => {
  const biomarkers = await getBiomarkerResults(readDb);
  return c.json({ biomarkers });
});

app.get("/api/day/:date/health", async (c) => {
  const date = c.req.param("date");
  const stats = await getDayHealthStats(readDb, date);
  return c.json(stats);
});

app.get("/api/recent", async (c) => {
  const query = c.req.query();
  const limit = query.limit ? parseInt(query.limit) : 50;
  const events = await getRecentEvents(readDb, {
    source: query.source,
    type: query.type,
    limit,
    cursor: query.cursor,
    excludeSources: resolveExcludedSources(query.exclude_sources, query.source),
  });

  const lastEvent = events[events.length - 1];
  const nextCursor = events.length === limit && lastEvent ? createCursor(lastEvent) : null;

  return c.json({ events, count: events.length, nextCursor });
});

app.get("/api/sources", async (c) => {
  return c.json(
    await getCached("sources", async () => {
      const sources = await listSources(readDb);

      // Group by source for a nicer structure
      const grouped: Record<string, { types: Record<string, number>; total: number }> = {};
      for (const s of sources) {
        if (!grouped[s.source]) {
          grouped[s.source] = { types: {}, total: 0 };
        }
        grouped[s.source].types[s.type] = s.count;
        grouped[s.source].total += s.count;
      }

      return { sources: grouped };
    }, c)
  );
});

app.get("/api/stats", async (c) => {
  return c.json(await getCached("stats", () => getStats(readDb, db), c));
});

app.get("/api/summary", async (c) => {
  const query = c.req.query();
  const summary = await getSummary(readDb, {
    date: query.date,
    startDate: query.startDate,
    endDate: query.endDate,
  });
  return c.json({ summary });
});

app.get("/api/location", async (c) => {
  const query = c.req.query();
  const events = await searchByLocation(readDb, {
    locationName: query.name,
    latitude: query.lat ? parseFloat(query.lat) : undefined,
    longitude: query.lng ? parseFloat(query.lng) : undefined,
    radiusKm: query.radius ? parseFloat(query.radius) : 1,
    limit: query.limit ? parseInt(query.limit) : 50,
  });
  return c.json({ events, count: events.length });
});

// Catches getAppStateDb() itself failing; the callee handles its own read errors.
function preferredAttachmentDescriptionModels(): readonly string[] | undefined {
  try {
    return getConfiguredAttachmentDescriptionModels(getAppStateDb());
  } catch {
    return undefined;
  }
}

// Helper to fetch attachments for multiple events at once
function getAttachmentsForEvents(
  eventIds: number[],
  preferredDescriptionModels?: readonly string[],
): Map<number, Attachment[]> {
  const result = new Map<number, Attachment[]>();
  if (eventIds.length === 0) return result;

  const placeholders = eventIds.map(() => "?").join(",");
  const descriptionSelect = latestAttachmentDescriptionSelect("ad.description", preferredDescriptionModels);
  const attachments = db
    .prepare(`
      SELECT a.*, ${descriptionSelect.sql} AS description
      FROM attachments a
      WHERE a.event_id IN (${placeholders})
      ORDER BY a.event_id, a.id
    `)
    .all(...descriptionSelect.params, ...eventIds) as Array<Attachment & { description: string | null }>;

  for (const att of attachments) {
    let arr = result.get(att.event_id);
    if (!arr) {
      arr = [];
      result.set(att.event_id, arr);
    }
    arr.push(att);
  }
  return result;
}

async function addConversationReferenceTargets(events: TimelineEvent[]) {
  const forwardTargets = await resolveDiscordForwardTargets(readDb, events);
  const withForwards = addDiscordForwardTargets(events, forwardTargets);
  const replyTargets = await resolveDiscordReplyTargets(readDb, withForwards);
  return addDiscordReplyTargets(withForwards, replyTargets);
}

function fallbackNameFromIdentifier(identifier: string): string {
  const parsed = parseIdentifier(identifier);
  if (!parsed) return identifier;
  if (parsed.platformId.startsWith("name:")) {
    return parsed.platformId.slice("name:".length);
  }
  return parsed.platformId || identifier;
}

app.get("/api/conversations", async (c) => {
  const query = c.req.query();
  setMetric(c, "dbpool.pending.before", readDbPool.getStats().pending, "pending query count before handler");
  timingStart(c, "conversations.list", "List Conversations");
  try {
    const result = await listConversations(readDb, {
      search: query.search || undefined,
      source: query.source || undefined,
      limit: query.limit ? parseInt(query.limit) : 50,
      offset: query.offset ? parseInt(query.offset) : 0,
      timing: {
        start: (name, description) => timingStart(c, name, description),
        end: (name) => timingEnd(c, name),
      },
    });
    return c.json(result);
  } finally {
    timingEnd(c, "conversations.list");
  }
});

app.get("/api/conversations/sources", async (c) => {
  const sources = await listConversationSources(readDb);
  return c.json({ sources });
});

app.get("/api/conversation", async (c) => {
  const query = c.req.query();
  if (!query.conversationId || !query.source) {
    return c.json({ error: "conversationId and source are required", events: [], count: 0, nextCursor: null, attachments: {} }, 400);
  }

  const limit = query.limit ? parseInt(query.limit) : 100;
  const order = query.order === "desc" ? "desc" : "asc";

  setMetric(c, "dbpool.pending.before", readDbPool.getStats().pending, "pending query count before handler");
  const events = await withServerTiming(c, "conversation.events", "Conversation Event Page", () =>
    getConversation(readDb, {
      conversationId: query.conversationId,
      source: query.source,
      sourceAccount: query.sourceAccount,
      limit,
      cursor: query.cursor,
      order,
    })
  );
  const metadata = await withServerTiming(c, "conversation.metadata", "Conversation Metadata", () =>
    getConversationMetadata(readDb, {
      conversationId: query.conversationId,
      source: query.source,
      sourceAccount: query.sourceAccount,
    })
  );

  const lastEvent = events[events.length - 1];
  const nextCursor = events.length === limit && lastEvent ? createCursor(lastEvent) : null;

  const responseEvents = await withServerTiming(
    c,
    "conversation.references",
    "Conversation References",
    () => addConversationReferenceTargets(events),
  );

  // Fetch attachments for all events in the response
  const attachments = await withServerTiming(c, "conversation.attachments", "Conversation Attachments", () => {
    const attachmentMap = getAttachmentsForEvents(events.map(e => e.id), preferredAttachmentDescriptionModels());
    const result: Record<number, Attachment[]> = {};
    for (const [eventId, atts] of attachmentMap) {
      result[eventId] = atts;
    }
    return result;
  });

  const participants = await withServerTiming(c, "conversation.participants", "Conversation Participants", async () => {
    const participantSet = new Set<string>();
    for (const event of events) {
      if (!event.people) continue;
      try {
        const people = JSON.parse(event.people) as string[];
        for (const person of people) {
          if (person) participantSet.add(person);
        }
      } catch {
        // Skip invalid JSON
      }
    }

    const identifiers = Array.from(participantSet);
    const resolved = await resolveIdentities(readDb, identifiers);
    const result: Record<string, EventParticipant> = {};
    for (const identifier of identifiers) {
      const identity = resolved[identifier];
      const name = identity?.name || identity?.username || fallbackNameFromIdentifier(identifier);
      result[identifier] = {
        name,
        contactId: identity?.contactId ?? null,
        avatarUrl: identity?.avatarUrl ?? null,
        isSelf: identity?.isSelf ?? false,
      };
    }
    return result;
  });

  return c.json({ events: responseEvents, count: events.length, nextCursor, attachments, participants, ...metadata });
});

app.post("/api/conversation/export-range", async (c) => {
  let body: { startEventId?: unknown; endEventId?: unknown; format?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON body is required" }, 400);
  }

  const startEventId = typeof body.startEventId === "number" ? body.startEventId : NaN;
  const endEventId = typeof body.endEventId === "number" ? body.endEventId : NaN;
  if (!Number.isInteger(startEventId) || !Number.isInteger(endEventId)) {
    return c.json({ error: "startEventId and endEventId are required integer event ids" }, 400);
  }

  let format: ConversationRangeExportFormat;
  try {
    format = parseConversationRangeExportFormat(body.format);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid export format" }, 400);
  }

  try {
    return c.json(await exportConversationRange(readDb, {
      startEventId,
      endEventId,
      format,
      preferredDescriptionModels: preferredAttachmentDescriptionModels(),
    }));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to export conversation range" }, 400);
  }
});

app.get("/api/conversation/around", async (c) => {
  const query = c.req.query();
  if (!query.conversationId || !query.source || !query.eventId) {
    return c.json({
      error: "conversationId, source, and eventId are required",
      events: [],
      targetIndex: -1,
      hasBefore: false,
      hasAfter: false,
      beforeCursor: null,
      afterCursor: null,
      attachments: {},
    }, 400);
  }

  const result = await getConversationAround(readDb, {
    conversationId: query.conversationId,
    source: query.source,
    sourceAccount: query.sourceAccount,
    eventId: parseInt(query.eventId),
    before: query.before ? parseInt(query.before) : 50,
    after: query.after ? parseInt(query.after) : 50,
  });
  const metadata = await getConversationMetadata(readDb, {
    conversationId: query.conversationId,
    source: query.source,
    sourceAccount: query.sourceAccount,
  });

  const responseEvents = await addConversationReferenceTargets(result.events);

  // Fetch attachments for all events in the response
  const attachmentMap = getAttachmentsForEvents(result.events.map(e => e.id), preferredAttachmentDescriptionModels());
  const attachments: Record<number, Attachment[]> = {};
  for (const [eventId, atts] of attachmentMap) {
    attachments[eventId] = atts;
  }

  // Resolve participants
  const participantSet = new Set<string>();
  for (const event of result.events) {
    if (!event.people) continue;
    try {
      const people = JSON.parse(event.people) as string[];
      for (const person of people) {
        if (person) participantSet.add(person);
      }
    } catch {
      // Skip invalid JSON
    }
  }

  const identifiers = Array.from(participantSet);
  const resolved = await resolveIdentities(readDb, identifiers);
  const participants: Record<string, EventParticipant> = {};
  for (const identifier of identifiers) {
    const identity = resolved[identifier];
    const name = identity?.name || identity?.username || fallbackNameFromIdentifier(identifier);
    participants[identifier] = {
      name,
      contactId: identity?.contactId ?? null,
      avatarUrl: identity?.avatarUrl ?? null,
      isSelf: identity?.isSelf ?? false,
    };
  }

  return c.json({ ...result, events: responseEvents, attachments, participants, ...metadata });
});

app.get("/api/conversation/stats", async (c) => {
  const query = c.req.query();
  if (!query.conversationId || !query.source) {
    return c.json({ error: "conversationId and source are required" }, 400);
  }

  setMetric(c, "dbpool.pending.before", readDbPool.getStats().pending, "pending query count before handler");
  return c.json(await getConversationStats(readDb, {
    conversationId: query.conversationId,
    source: query.source,
    sourceAccount: query.sourceAccount,
    timing: {
      start: (name, description) => timingStart(c, name, description),
      end: (name) => timingEnd(c, name),
    },
  }));
});

app.get("/api/conversation/media", async (c) => {
  const query = c.req.query();
  if (!query.conversationId || !query.source) {
    return c.json({ error: "conversationId and source are required", attachments: [], nextCursor: null }, 400);
  }

  const limit = query.limit ? parseInt(query.limit) : 60;
  const attachments = await getConversationMedia(readDb, {
    conversationId: query.conversationId,
    source: query.source,
    sourceAccount: query.sourceAccount,
    mime: query.mime,
    limit,
    cursor: query.cursor,
    preferredDescriptionModels: preferredAttachmentDescriptionModels(),
  });

  const lastAttachment = attachments[attachments.length - 1];
  const nextCursor = attachments.length === limit && lastAttachment ? String(lastAttachment.id) : null;

  return c.json({ attachments, nextCursor });
});

// Discord servers (guilds): a server-level view over synced channels.
// Channel/guild metadata lives in raw_data; both endpoints derive it from one
// representative row per channel, so they're cheap enough to cache briefly.
app.get("/api/discord/servers", async (c) => {
  const servers = await getCached("discord-servers", () => listDiscordServers(readDb), c);
  return c.json({ servers });
});

app.get("/api/discord/servers/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^\d+$/.test(id)) {
    return c.json({ error: "Invalid guild id" }, 400);
  }
  const server = await getCached(`discord-server:${id}`, () => getDiscordServer(readDb, id), c);
  if (!server) {
    return c.json({ error: "Server not found" }, 404);
  }
  return c.json(server);
});

// Contact management endpoints
app.get("/api/contacts", async (c) => {
  const query = c.req.query();
  // Only cache default requests (no search, not includeHidden)
  if (!query.search && query.includeHidden !== "true") {
    return c.json(await getCached("contacts", async () => ({
      contacts: await listContacts(readDb, { includeHidden: false }),
    }), c));
  }
  const contacts = await listContacts(readDb, {
    includeHidden: query.includeHidden === "true",
    search: query.search,
  });
  return c.json({ contacts });
});

app.get("/api/contacts/count", async (c) => {
  return c.json(await getCached("contacts:count", async () => ({ count: await countContacts(readDb) }), c));
});

app.get("/api/contacts/resolve", async (c) => {
  const query = c.req.query();
  if (!query.alias) {
    return c.json({ error: "alias is required" }, 400);
  }
  const contact = await resolveAlias(readDb, query.alias, query.source);
  return c.json({ contact });
});

// Find aliases that normalize to the same value (e.g., "Alice Example" and "alice_example")
app.get("/api/contacts/suggestions", async (c) => {
  const query = c.req.query();
  const limit = query.limit ? parseInt(query.limit) : 50;

  return c.json(await getCached(`contacts:suggestions:${limit}`, async () => {
    // Find unlinked aliases that normalize to the same value
    const suggestions = await readDb.query<{
      alias_a: string;
      source_a: string;
      alias_b: string;
      source_b: string;
      normalized: string;
    }>(`
      WITH unlinked AS (
        SELECT DISTINCT
          ep.person,
          ep.source,
          TRIM(LOWER(REPLACE(REPLACE(REPLACE(
            CASE
              WHEN i.display_name IS NOT NULL AND LENGTH(TRIM(i.display_name)) > 0 THEN i.display_name
              WHEN i.username IS NOT NULL AND LENGTH(TRIM(i.username)) > 0 THEN i.username
              WHEN i.platform_id LIKE 'name:%' THEN substr(i.platform_id, 6)
              WHEN i.platform_id IS NOT NULL AND LENGTH(TRIM(i.platform_id)) > 0 THEN i.platform_id
              ELSE ep.person
            END
          , '_', ' '), '.', ' '), '-', ' '))) as normalized
        FROM event_people ep
        LEFT JOIN identities i ON ep.person = (i.platform || ':' || i.platform_id)
        WHERE ep.source IN (${PERSONAL_SOURCES.map(() => "?").join(",")})
          AND (i.id IS NULL OR (i.contact_id IS NULL AND i.skipped = 0))
          AND length(ep.person) > 2
      )
      SELECT
        a.person as alias_a,
        a.source as source_a,
        b.person as alias_b,
        b.source as source_b,
        a.normalized
      FROM unlinked a
      JOIN unlinked b ON a.normalized = b.normalized
      WHERE (a.source, a.person) < (b.source, b.person)
      ORDER BY a.normalized, a.source, b.source
      LIMIT ?
    `, ...PERSONAL_SOURCES, limit);

    return { suggestions, count: suggestions.length };
  }, c));
});

app.get("/api/identities/events", async (c) => {
  const query = c.req.query();
  if (!query.identifier) {
    return c.json({ error: "identifier is required" }, 400);
  }
  const result = await searchByAlias(readDb, query.identifier, query.platform, {
    limit: query.limit ? parseInt(query.limit) : undefined,
    cursor: query.cursor,
  });
  return c.json(result);
});

app.post("/api/cache/refresh", async (c) => {
  // Refresh caches - event_people is kept in sync via triggers
  await refreshStatsCache(db);
  invalidateContactMappingCaches();
  return c.json({ success: true, message: "Cache refreshed" });
});

app.get("/api/contacts/:id", async (c) => {
  const id = c.req.param("id");
  const contact = await getContact(readDb, parseInt(id));
  if (!contact) {
    return c.json({ error: "Contact not found" }, 404);
  }
  const identities = await getIdentitiesForContact(readDb, contact.id);
  const avatarUrl = pickBestAvatar(identities);
  const memories = await getContactMemories(readDb, contact.id);
  return c.json({ contact, identities, avatarUrl, memories });
});

app.post("/api/contacts", async (c) => {
  const body = await c.req.json();
  const id = createContact(db, body.displayName, body.notes);
  const contact = await getContact(readDb, id);
  invalidateContactsCaches();
  return c.json({ contact });
});

app.patch("/api/contacts/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json();
  const existing = await getContact(readDb, id);
  if (!existing) {
    return c.json({ error: "Contact not found" }, 404);
  }
  if (body.dateOfBirth != null) {
    const fullDate = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
    const dayMonth = /^--(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
    if (!fullDate.test(body.dateOfBirth) && !dayMonth.test(body.dateOfBirth)) {
      return c.json({ error: "Invalid dateOfBirth format. Use YYYY-MM-DD or --MM-DD" }, 400);
    }
  }
  if (body.isSelf !== undefined && typeof body.isSelf !== "boolean") {
    return c.json({ error: "isSelf must be a boolean" }, 400);
  }
  updateContact(db, id, {
    displayName: body.displayName,
    notes: body.notes,
    hidden: body.hidden,
    dateOfBirth: body.dateOfBirth,
    isSelf: body.isSelf,
  });
  const contact = await getContact(readDb, id);
  invalidateContactMappingCaches();
  if (body.hidden !== undefined) {
    invalidateHiddenVisibilityCaches();
  }
  return c.json({ contact });
});

app.delete("/api/contacts/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const existing = await getContact(readDb, id);
  if (!existing) {
    return c.json({ error: "Contact not found" }, 404);
  }
  deleteContact(db, id);
  invalidateContactMappingCaches();
  // Deleting a hidden contact makes its events visible again.
  if (existing.hidden) {
    invalidateHiddenVisibilityCaches();
  }
  return c.json({ success: true });
});

// Contact memories
app.post("/api/contacts/:id/memories", async (c) => {
  const contactId = parseIntStrict(c.req.param("id"));
  if (isNaN(contactId)) return c.json({ error: "Invalid contact ID" }, 400);
  const contact = await getContact(readDb, contactId);
  if (!contact) {
    return c.json({ error: "Contact not found" }, 404);
  }
  const body = await c.req.json();
  if (!body || typeof body !== "object" || typeof body.content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }
  const content = body.content.trim();
  if (!content) {
    return c.json({ error: "content is required" }, 400);
  }
  const memory = createContactMemory(db, contactId, content);
  return c.json({ memory }, 201);
});

app.delete("/api/contacts/:id/memories/:memoryId", async (c) => {
  const contactId = parseIntStrict(c.req.param("id"));
  const memoryId = parseIntStrict(c.req.param("memoryId"));
  if (isNaN(contactId) || isNaN(memoryId)) return c.json({ error: "Invalid ID" }, 400);
  const contact = await getContact(readDb, contactId);
  if (!contact) {
    return c.json({ error: "Contact not found" }, 404);
  }
  const deleted = deleteContactMemory(db, contactId, memoryId);
  if (!deleted) return c.json({ error: "Memory not found" }, 404);
  return c.json({ success: true });
});

app.get("/api/contacts/:id/events", async (c) => {
  const contactId = parseInt(c.req.param("id"));
  const query = c.req.query();
  const contact = await getContact(readDb, contactId);
  if (!contact) {
    return c.json({ error: "Contact not found", events: [], count: 0, nextCursor: null }, 404);
  }

  const limit = query.limit ? parseInt(query.limit) : 50;
  const events = await searchByContact(readDb, contactId, {
    query: query.q,
    source: query.source,
    type: query.type,
    startDate: query.startDate,
    endDate: query.endDate,
    chat: query.chat,
    limit,
    cursor: query.cursor,
    sort: query.sort as "asc" | "desc" | undefined,
  });

  const lastEvent = events[events.length - 1];
  const nextCursor = events.length === limit && lastEvent ? createCursor(lastEvent) : null;

  return c.json({ events, count: events.length, nextCursor });
});

app.get("/api/contacts/:id/spotify-summary", async (c) => {
  const contactId = parseInt(c.req.param("id"));
  const contact = await getContact(readDb, contactId);
  if (!contact) {
    return c.json({ error: "Contact not found", summary: null }, 404);
  }
  const summary = await getContactSpotifySummary(readDb, contactId);
  return c.json({ summary });
});

app.get("/api/contacts/:id/conversations", async (c) => {
  const contactId = parseInt(c.req.param("id"));
  const contact = await getContact(readDb, contactId);
  if (!contact) {
    return c.json({ error: "Contact not found", conversations: [] }, 404);
  }
  const conversations = await getContactConversations(readDb, contactId);
  return c.json({ conversations });
});

// Manual event management
app.post("/api/events/manual", async (c) => {
  const body = await c.req.json();

  // Validate required fields
  if (!body.timestamp) {
    return c.json({ error: "timestamp is required" }, 400);
  }
  if (!body.title || typeof body.title !== "string" || body.title.trim() === "") {
    return c.json({ error: "title is required" }, 400);
  }

  // Validate timestamp format
  const ts = new Date(body.timestamp);
  if (isNaN(ts.getTime())) {
    return c.json({ error: "Invalid timestamp format" }, 400);
  }

  // Validate people array if provided
  if (body.people !== undefined) {
    if (!Array.isArray(body.people)) {
      return c.json({ error: "people must be an array of contact IDs" }, 400);
    }
    for (const id of body.people) {
      if (typeof id !== "number" || !Number.isInteger(id)) {
        return c.json({ error: "people must be an array of integer contact IDs" }, 400);
      }
      const contact = await getContact(readDb, id);
      if (!contact) {
        return c.json({ error: `Contact not found: ${id}` }, 400);
      }
    }
  }

  try {
    const event = createManualEvent(db, {
      timestamp: body.timestamp,
      title: body.title.trim(),
      content: body.content,
      people: body.people,
      source_account: body.source_account,
      origin: body.origin,
    });
    cache.delete("stats");
    cache.delete("sources");
    invalidateContactsCaches();
    return c.json({ event }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create event";
    return c.json({ error: message }, 500);
  }
});

// Transport event management
app.post("/api/events/transport", async (c) => {
  const body = await c.req.json();

  // Validate mode
  if (!body.mode || !TRANSPORT_MODES.includes(body.mode)) {
    return c.json({ error: `mode must be one of: ${TRANSPORT_MODES.join(", ")}` }, 400);
  }

  // Validate origin and destination - at least name or code required
  for (const field of ["origin", "destination"] as const) {
    const loc = body[field];
    if (!loc || typeof loc !== "object") {
      return c.json({ error: `${field} is required` }, 400);
    }
    if (!loc.name && !loc.code) {
      return c.json({ error: `${field} must have at least a name or code` }, 400);
    }
  }

  // Validate departure
  if (!body.departure) {
    return c.json({ error: "departure is required" }, 400);
  }
  const depTs = new Date(body.departure);
  if (isNaN(depTs.getTime())) {
    return c.json({ error: "Invalid departure timestamp" }, 400);
  }

  // Validate arrival if provided
  if (body.arrival) {
    const arrTs = new Date(body.arrival);
    if (isNaN(arrTs.getTime())) {
      return c.json({ error: "Invalid arrival timestamp" }, 400);
    }
  }

  // Validate people
  if (body.people !== undefined && body.people !== null) {
    if (!Array.isArray(body.people)) {
      return c.json({ error: "people must be an array of contact IDs" }, 400);
    }
    for (const contactId of body.people) {
      if (typeof contactId !== "number" || !Number.isInteger(contactId)) {
        return c.json({ error: "people must be an array of integer contact IDs" }, 400);
      }
      const contact = await getContact(readDb, contactId);
      if (!contact) {
        return c.json({ error: `Contact not found: ${contactId}` }, 400);
      }
    }
  }

  try {
    const event = createTransportEvent(db, {
      mode: body.mode,
      origin: { name: body.origin.name, code: body.origin.code },
      destination: { name: body.destination.name, code: body.destination.code },
      departure: body.departure,
      arrival: body.arrival,
      service: body.service,
      operator: body.operator,
      people: body.people,
      notes: body.notes,
    });
    cache.delete("stats");
    cache.delete("sources");
    invalidateContactsCaches();
    return c.json({ event }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create transport event";
    return c.json({ error: message }, 500);
  }
});

app.patch("/api/events/transport/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) {
    return c.json({ error: "Invalid event ID" }, 400);
  }

  const body = await c.req.json();

  // Validate mode if provided
  if (body.mode !== undefined && !TRANSPORT_MODES.includes(body.mode)) {
    return c.json({ error: `mode must be one of: ${TRANSPORT_MODES.join(", ")}` }, 400);
  }

  // Validate origin/destination if provided
  for (const field of ["origin", "destination"] as const) {
    if (body[field] !== undefined) {
      const loc = body[field];
      if (!loc || typeof loc !== "object") {
        return c.json({ error: `${field} must be an object` }, 400);
      }
      if (!loc.name && !loc.code) {
        return c.json({ error: `${field} must have at least a name or code` }, 400);
      }
    }
  }

  // Validate timestamps if provided
  if (body.departure) {
    const ts = new Date(body.departure);
    if (isNaN(ts.getTime())) {
      return c.json({ error: "Invalid departure timestamp" }, 400);
    }
  }
  if (body.arrival) {
    const ts = new Date(body.arrival);
    if (isNaN(ts.getTime())) {
      return c.json({ error: "Invalid arrival timestamp" }, 400);
    }
  }

  // Validate people if provided
  if (body.people !== undefined && body.people !== null) {
    if (!Array.isArray(body.people)) {
      return c.json({ error: "people must be an array of contact IDs" }, 400);
    }
    for (const contactId of body.people) {
      if (typeof contactId !== "number" || !Number.isInteger(contactId)) {
        return c.json({ error: "people must be an array of integer contact IDs" }, 400);
      }
      const contact = await getContact(readDb, contactId);
      if (!contact) {
        return c.json({ error: `Contact not found: ${contactId}` }, 400);
      }
    }
  }

  try {
    const event = updateTransportEvent(db, id, body);
    if (!event) {
      return c.json({ error: "Event not found" }, 404);
    }
    cache.delete("stats");
    cache.delete("sources");
    invalidateContactsCaches();
    return c.json({ event });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update transport event";
    if (message.includes("non-manual") || message.includes("not a transport")) {
      return c.json({ error: message }, 403);
    }
    return c.json({ error: message }, 500);
  }
});

app.patch("/api/events/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) {
    return c.json({ error: "Invalid event ID" }, 400);
  }

  const body = await c.req.json();

  // Validate timestamp if provided
  if (body.timestamp !== undefined) {
    const ts = new Date(body.timestamp);
    if (isNaN(ts.getTime())) {
      return c.json({ error: "Invalid timestamp format" }, 400);
    }
  }

  // Validate title if provided
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.trim() === "")) {
    return c.json({ error: "title cannot be empty" }, 400);
  }

  // Validate people array if provided
  if (body.people !== undefined && body.people !== null) {
    if (!Array.isArray(body.people)) {
      return c.json({ error: "people must be an array of contact IDs" }, 400);
    }
    for (const contactId of body.people) {
      if (typeof contactId !== "number" || !Number.isInteger(contactId)) {
        return c.json({ error: "people must be an array of integer contact IDs" }, 400);
      }
      const contact = await getContact(readDb, contactId);
      if (!contact) {
        return c.json({ error: `Contact not found: ${contactId}` }, 400);
      }
    }
  }

  try {
    const event = updateManualEvent(db, id, {
      timestamp: body.timestamp,
      title: body.title?.trim(),
      content: body.content,
      people: body.people,
    });
    if (!event) {
      return c.json({ error: "Event not found" }, 404);
    }
    cache.delete("stats");
    cache.delete("sources");
    invalidateContactsCaches();
    return c.json({ event });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update event";
    if (message === "Cannot update non-manual events") {
      return c.json({ error: message }, 403);
    }
    return c.json({ error: message }, 500);
  }
});

app.delete("/api/events/:id", (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) {
    return c.json({ error: "Invalid event ID" }, 400);
  }

  try {
    const deleted = deleteManualEvent(db, id);
    if (!deleted) {
      return c.json({ error: "Event not found" }, 404);
    }
    cache.delete("stats");
    cache.delete("sources");
    invalidateContactsCaches();
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete event";
    if (message === "Cannot delete non-manual events") {
      return c.json({ error: message }, 403);
    }
    return c.json({ error: message }, 500);
  }
});

app.get("/api/identities/skipped/count", async (c) => {
  const count = await countSkippedIdentities(readDb);
  return c.json({ count });
});

app.post("/api/identities/skip", async (c) => {
  const body = await c.req.json();
  try {
    skipIdentityByAlias(db, body.identifier, body.platform);
    invalidateContactMappingCaches();
    invalidateHiddenVisibilityCaches();
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid identity";
    return c.json({ error: message }, 400);
  }
});

app.post("/api/identities/unskip", async (c) => {
  const body = await c.req.json();
  try {
    unskipIdentityByAlias(db, body.identifier, body.platform);
    invalidateContactMappingCaches();
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid identity";
    return c.json({ error: message }, 400);
  }
});

// Platform identity endpoints
// These work with platform-specific identifiers like "discord:123456789"

app.post("/api/identities/resolve", async (c) => {
  // Batch resolve platform identifiers to display names and contact IDs
  const body: unknown = await c.req.json();
  const identifiers: unknown = body && typeof body === "object" ? (body as Record<string, unknown>).identifiers : undefined;
  if (!Array.isArray(identifiers) || !identifiers.every((id): id is string => typeof id === "string")) {
    return c.json({ error: "identifiers must be an array of strings" }, 400);
  }
  const resolved = await resolveIdentities(readDb, identifiers);
  // Public shape: `isSelf` is part of the contract (the web client renders
  // "You" from it); `hidden` is internal filtering state and is stripped.
  const publicResolved: Record<string, Omit<ResolvedIdentity, "hidden">> = {};
  for (const [identifier, { hidden: _hidden, ...identity }] of Object.entries(resolved)) {
    publicResolved[identifier] = identity;
  }
  return c.json({ resolved: publicResolved });
});

app.get("/api/identities/unlinked", async (c) => {
  const query = c.req.query();
  const identities = await getUnlinkedIdentities(readDb, {
    platform: query.platform,
    limit: query.limit ? parseInt(query.limit) : undefined,
  });
  return c.json({ identities, count: identities.length });
});

app.get("/api/identities/unlinked/count", async (c) => {
  const count = await countUnlinkedIdentities(readDb);
  return c.json({ count });
});

app.get("/api/identities/skipped", async (c) => {
  const identities = await listSkippedIdentities(readDb);
  return c.json({ identities, count: identities.length });
});

// Find unlinked identities that have matching contacts (for bulk linking suggestions)
// IMPORTANT: This must be defined BEFORE /api/identities/:identifier to avoid route conflicts
app.get("/api/identities/link-suggestions", async (c) => {
  const query = c.req.query();
  const rawLimit = query.limit ? parseInt(query.limit) : 10;
  // Clamp limit to sensible range (1-100)
  const limit = Math.max(1, Math.min(100, isNaN(rawLimit) ? 10 : rawLimit));
  const suggestions = await getIdentityLinkSuggestions(readDb, limit);
  return c.json({ suggestions });
});

// Batch link multiple identities to contacts in a single transaction
// IMPORTANT: This must be defined BEFORE /api/identities/:identifier to avoid route conflicts
app.post("/api/identities/batch-link", async (c) => {
  const body = await c.req.json();
  const links = body.links as Array<{ identifier: string; contactId: number }>;

  if (!Array.isArray(links) || links.length === 0) {
    return c.json({ error: "links array is required and must not be empty" }, 400);
  }

  // Validate all inputs upfront
  const parsedLinks: Array<{ platform: string; platformId: string; contactId: number }> = [];
  const validationErrors: Array<{ identifier: string; error: string }> = [];

  for (const link of links) {
    if (!link.identifier || !link.contactId) {
      validationErrors.push({
        identifier: link.identifier || "unknown",
        error: "identifier and contactId are required",
      });
      continue;
    }

    const parsed = parseIdentifier(link.identifier);
    if (!parsed) {
      validationErrors.push({
        identifier: link.identifier,
        error: "Invalid identifier format",
      });
      continue;
    }

    parsedLinks.push({
      platform: parsed.platform,
      platformId: parsed.platformId,
      contactId: link.contactId,
    });
  }

  if (parsedLinks.length === 0) {
    return c.json({
      success: false,
      linked: 0,
      errors: validationErrors,
    }, 400);
  }

  const result = batchLinkIdentitiesToContact(db, parsedLinks);
  invalidateContactMappingCaches();
  invalidateHiddenVisibilityCaches();

  return c.json({
    success: result.errors.length === 0 && validationErrors.length === 0,
    linked: result.linked,
    errors: [...validationErrors, ...result.errors],
  });
});

app.get("/api/identities/:identifier", async (c) => {
  const identifier = decodeURIComponent(c.req.param("identifier"));
  const identity = await getIdentityByIdentifier(readDb, identifier);
  if (!identity) {
    return c.json({ error: "Identity not found" }, 404);
  }
  return c.json({ identity });
});

app.post("/api/identities/:identifier/link", async (c) => {
  const identifier = decodeURIComponent(c.req.param("identifier"));
  const body = await c.req.json();
  const contactId = body.contactId as number;
  if (!contactId) {
    return c.json({ error: "contactId is required" }, 400);
  }
  const parsed = parseIdentifier(identifier);
  if (!parsed) {
    return c.json({ error: "Invalid identifier format" }, 400);
  }
  const contact = await getContact(readDb, contactId);
  if (!contact) {
    return c.json({ error: "Contact not found" }, 404);
  }
  const identity = await getIdentityByIdentifier(readDb, identifier);
  if (!identity) {
    return c.json({ error: "Identity not found" }, 404);
  }
  linkIdentityToContact(db, parsed.platform, parsed.platformId, contactId);
  invalidateContactMappingCaches();
  invalidateHiddenVisibilityCaches();
  return c.json({ success: true });
});
app.post("/api/identities/:identifier/unlink", async (c) => {
  const identifier = decodeURIComponent(c.req.param("identifier"));
  const parsed = parseIdentifier(identifier);
  if (!parsed) {
    return c.json({ error: "Invalid identifier format" }, 400);
  }
  unlinkIdentity(db, parsed.platform, parsed.platformId);
  invalidateContactMappingCaches();
  invalidateHiddenVisibilityCaches();
  return c.json({ success: true });
});

app.post("/api/identities/:identifier/skip", async (c) => {
  const identifier = decodeURIComponent(c.req.param("identifier"));
  const parsed = parseIdentifier(identifier);
  if (!parsed) {
    return c.json({ error: "Invalid identifier format" }, 400);
  }
  skipIdentity(db, parsed.platform, parsed.platformId);
  invalidateContactMappingCaches();
  invalidateHiddenVisibilityCaches();
  return c.json({ success: true });
});

app.post("/api/identities/:identifier/unskip", async (c) => {
  const identifier = decodeURIComponent(c.req.param("identifier"));
  const parsed = parseIdentifier(identifier);
  if (!parsed) {
    return c.json({ error: "Invalid identifier format" }, 400);
  }
  unskipIdentity(db, parsed.platform, parsed.platformId);
  invalidateContactMappingCaches();
  return c.json({ success: true });
});

// Find contacts whose identities match a given unlinked identity via name normalization
app.get("/api/identities/:identifier/suggested-contacts", async (c) => {
  const identifier = decodeURIComponent(c.req.param("identifier"));
  const suggestions = await getSuggestedContactsForIdentity(readDb, identifier);
  return c.json({ suggestions });
});

app.get("/api/contacts/:id/identities", async (c) => {
  const contactId = parseInt(c.req.param("id"));
  const contact = await getContact(readDb, contactId);
  if (!contact) {
    return c.json({ error: "Contact not found" }, 404);
  }
  const identities = await getIdentitiesForContact(readDb, contactId);
  return c.json({ identities });
});

// Find suggestions for a specific contact - aliases that match their existing aliases
app.get("/api/contacts/:id/suggestions", async (c) => {
  const contactId = parseInt(c.req.param("id"));
  const query = c.req.query();
  const limit = query.limit ? parseInt(query.limit) : 20;

  const contact = await getContact(readDb, contactId);
  if (!contact) {
    return c.json({ error: "Contact not found" }, 404);
  }

  // Find unlinked identities with matching normalized names to this contact's identities
  const suggestions = await readDb.query<{
    alias: string;
    source: string;
    normalized: string;
    matched_alias: string;
    matched_source: string | null;
  }>(`
    SELECT
      (u.platform || ':' || u.platform_id) as alias,
      u.platform as source,
      u.normalized_name as normalized,
      (l.platform || ':' || l.platform_id) as matched_alias,
      l.platform as matched_source
    FROM identities u
    JOIN identities l ON u.normalized_name = l.normalized_name
    WHERE l.contact_id = ?
      AND u.contact_id IS NULL
      AND u.skipped = 0
      AND u.event_count > 0
      AND LENGTH(u.normalized_name) > 2
    ORDER BY u.platform, u.platform_id
    LIMIT ?
  `, contactId, limit);

  return c.json({ contact, suggestions, count: suggestions.length });
});

// Timeline view - date activity summaries
app.get("/api/timeline/date-index", async (c) => {
  const dates = await withServerTiming(
    c,
    "timeline.date-index",
    "Timeline Date Activity Index",
    () => listDateActivityIndex(dateActivityDb),
  );

  return c.json({ dates });
});

app.get("/api/timeline/dates", async (c) => {
  const query = c.req.query();
  const { startDate, endDate } = query;

  if (!startDate || !endDate) {
    return c.json({ error: "startDate and endDate are required" }, 400);
  }

  setMetric(
    c,
    "dbpool.pending.before",
    readDbPool.getStats().pending,
    "pending query count before handler",
  );
  const dates = await withServerTiming(
    c,
    "timeline.dates",
    "Timeline Date Activity",
    () => listDateActivity(dateActivityDb, startDate, endDate),
  );

  return c.json({ dates });
});

// WakaTime / Coding Activity endpoints
app.get("/api/wakatime/stats", async (c) => {
  const query = c.req.query();
  const preset = query.preset as "today" | "yesterday" | "7d" | "30d" | "year" | "all" | undefined;
  return c.json(
    await getWakaTimeStats(readDb, {
      startDate: query.startDate,
      endDate: query.endDate,
      preset,
    })
  );
});

app.get("/api/wakatime/projects/:name", async (c) => {
  const name = decodeURIComponent(c.req.param("name"));
  const query = c.req.query();
  const result = await getWakaTimeProject(readDb, name, {
    startDate: query.startDate,
    endDate: query.endDate,
  });
  if (!result) {
    return c.json({ error: "Project not found" }, 404);
  }
  return c.json(result);
});

app.get("/api/wakatime/projects/:name/sessions", async (c) => {
  const name = decodeURIComponent(c.req.param("name"));
  const query = c.req.query();
  const limit = query.limit ? parseInt(query.limit) : 50;
  const order = query.order === "asc" ? "asc" : "desc";

  return c.json(
    await getWakaTimeProjectSessions(readDb, name, {
      startDate: query.startDate,
      endDate: query.endDate,
      limit,
      cursor: query.cursor,
      order,
    })
  );
});

// Unified coding project list across WakaTime sessions and AI conversations
// (conductor, t3code, claude-code, amp, opencode). Backs the Coding tab.
app.get("/api/coding/projects", async (c) => {
  const query = c.req.query();
  return c.json(
    await getCodingProjects(readDb, {
      search: query.search,
      limit: query.limit ? parseInt(query.limit) : undefined,
    })
  );
});

// AI coding conversations for a project (cross-source: conductor, t3code,
// claude-code, amp, opencode). Lives under /api/coding/ because it spans multiple sources
// rather than being WakaTime-specific.
app.get("/api/coding/projects/:name/conversations", async (c) => {
  const name = decodeURIComponent(c.req.param("name"));
  const query = c.req.query();
  const limit = query.limit ? parseInt(query.limit) : 50;
  const offset = query.offset ? parseInt(query.offset) : 0;

  return c.json(
    await getCodingProjectConversations(readDb, name, { limit, offset })
  );
});

// Markdown-first status page with content negotiation
// Serves HTML by default for browsers, markdown for agents
// Must be defined before SPA fallback to take precedence
app.get("/status", async (c) => {
  const markdown = await generateStatusMarkdown({ authenticated: true });
  const accept = c.req.header("Accept") || "";

  // Serve raw markdown if explicitly requested
  if (accept.includes("text/markdown")) {
    return c.text(markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  }

  // Default: HTML for browsers
  const html = renderMarkdownToHtml(markdown);
  return c.html(html);
});

// Explicit markdown endpoint for agents/curl
app.get("/status.md", async (c) => {
  const markdown = await generateStatusMarkdown({ authenticated: true });
  return c.text(markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
});

// Add static file serving if web/dist exists
if (webDistPath) {
  const indexHtmlPath = join(webDistPath, "index.html");

  // Serve index.html for root (read fresh each time to pick up deploys without restart)
  app.get("/", (c) => {
    const indexHtml = readFileSync(indexHtmlPath, "utf-8");
    return c.html(indexHtml);
  });

  // Serve static assets from /assets/*
  app.get("/assets/*", async (c) => {
    const path = c.req.path.replace("/assets/", "");
    const filePath = join(webDistPath, "assets", path);
    if (!existsSync(filePath)) {
      return c.json({ error: "Not found" }, 404);
    }
    const file = Bun.file(filePath);
    const content = await file.arrayBuffer();
    return c.body(content, 200, {
      "Content-Type": file.type,
      "Content-Length": String(file.size),
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  });

  // SPA fallback - serve index.html for non-API routes
  app.get("/*", (c) => {
    const path = c.req.path;
    // Don't intercept API routes or files with extensions
    if (path.startsWith("/api/") || path.includes(".")) {
      return c.json({ error: "Not found" }, 404);
    }
    const indexHtml = readFileSync(indexHtmlPath, "utf-8");
    return c.html(indexHtml);
  });
}

// Export app for testing
export { app };

type RequestTimeoutServer = Pick<Bun.Server<undefined>, "timeout">;
const manualAttachmentDescriptionPath = new RegExp(MANUAL_ATTACHMENT_DESCRIPTION_PATH_PATTERN, "u");

/**
 * Manual description generation has its own bounded model-call timeout. Disable
 * Bun's shorter connection idle timeout for that route so provider cold starts
 * can use the full allowance without changing the limit for other requests.
 */
export function fetchApiRequest(request: Request, server: RequestTimeoutServer) {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && manualAttachmentDescriptionPath.test(path)) {
    server.timeout(request, 0);
  }
  return app.fetch(request);
}

let apiServer: Bun.Server<undefined> | null = null;

export async function shutdownApi(): Promise<void> {
  const server = apiServer;
  apiServer = null;
  if (server) {
    await server.stop(true);
  }
  await readDbPool.closeAndWait();
  await embeddingsDbPool?.closeAndWait();
}

// Start server unless we're in test mode
if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.TIMELINE_PORT || process.env.PORT || 3001);
  const hostname = process.env.TIMELINE_HOST || "127.0.0.1";

  // Install configured LLM providers and discover their models (non-blocking)
  initProviders(apiConfig.llm);

  apiServer = Bun.serve({
    port,
    hostname,
    fetch: fetchApiRequest,
    idleTimeout: 30, // seconds; default 10s is too short for slow DB queries
  });

  // performance.now() is measured from process start, so this covers module
  // loading and database init, not just the stretch since the log line above.
  console.log(
    `Timeline API running at http://${hostname}:${port} (ready in ${(performance.now() / 1000).toFixed(1)}s)`,
  );
  if (isAuthEnabled()) {
    console.log("Authentication enabled (AUTH_PASSWORD is set)");
  } else {
    console.log("Authentication disabled for development (AUTH_PASSWORD is not set)");
  }
  if (isMcpHttpEnabled()) {
    console.log("MCP HTTP enabled (MCP_TOKENS is set) - endpoints: /mcp (Bearer), /mcp/<token>");
  } else {
    console.log("MCP HTTP disabled (set MCP_TOKENS to enable)");
  }
}
