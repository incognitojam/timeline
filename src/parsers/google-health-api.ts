/**
 * Google Health API parser — sleep, daily metrics, activity and weight import.
 *
 * Google is turning down the legacy Fitbit Web API (api.fitbit.com) in late
 * October 2026 and replacing it with the Google Health API
 * (https://health.googleapis.com/v4). This parser pulls health data from the new
 * API and writes it under a NEW source: `google-health`.
 *
 * Why a new source rather than reusing `fitbit`: it keeps the migration isolated
 * and reversible, avoids UNIQUE(source, source_id, source_account) collisions with
 * existing Fitbit rows on overlapping dates, and lets us parity-check the two
 * pipelines. The new `/users/me/identity` endpoint returns `legacyUserId` (the old
 * Fitbit user id), so the two sources are joinable when we validate.
 *
 * Sync imports sleep, daily HRV, SpO2, breathing rate, resting heart rate,
 * skin temperature, activity, active zone minutes, and weight under the same
 * event types the `fitbit` source uses. Auth is standard Google OAuth 2.0 via the shared
 * createOAuth2Client + loopback callback (creds in
 * ~/.config/timeline/google-health.json).
 *
 * CLI:
 *   bun run src/parsers/google-health-api.ts auth            # interactive consent
 *   bun run src/parsers/google-health-api.ts probe [healthMetricsDailyDataType] [since] [until]
 *       # identity + profile + sleep sample + daily summary sample
 *   bun run src/parsers/google-health-api.ts sync            # last 30 days
 *   bun run src/parsers/google-health-api.ts sync 2025-07-01 2025-10-01   # explicit window
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../db/schema";
import { sanitizeAccountName } from "../lib/account";
import { formatDuration } from "../lib/format";
import {
  createOAuth2Client,
  type OAuth2ProviderConfig,
  type OAuth2TokenResponse,
} from "../lib/oauth2-client";
import { createTokenManager, type OAuthTokens } from "../lib/oauth-tokens";

const SOURCE = "google-health";
const CONFIG_PATH = join(homedir(), ".config", "timeline", "google-health.json");
const API_BASE = "https://health.googleapis.com/v4";
const STATE_KEY = "google-health";
const HEALTH_METRICS_SCOPE =
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly";
const HEALTH_METRICS_DAILY_SUMMARY_DATA_TYPES = [
  "daily-heart-rate-variability",
  "daily-heart-rate-zones",
  "daily-oxygen-saturation",
  "daily-respiratory-rate",
  "daily-resting-heart-rate",
  "daily-sleep-temperature-derivations",
] as const;
type HealthMetricsDailySummaryDataType = (typeof HEALTH_METRICS_DAILY_SUMMARY_DATA_TYPES)[number];
const HEALTH_METRICS_DAILY_SUMMARY_DATA_TYPE_SET = new Set<string>(
  HEALTH_METRICS_DAILY_SUMMARY_DATA_TYPES,
);
const DEFAULT_DAILY_SUMMARY_DATA_TYPE: HealthMetricsDailySummaryDataType =
  "daily-heart-rate-variability";

const ACTIVITY_AND_FITNESS_SCOPE =
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly";

const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  HEALTH_METRICS_SCOPE,
  ACTIVITY_AND_FITNESS_SCOPE,
];

interface GoogleHealthConfig {
  client_id: string;
  client_secret: string;
}

interface GoogleHealthTokens extends OAuthTokens {
  scope?: string;
  account_name?: string;
}

// ============================================================================
// Config + OAuth
// ============================================================================

function loadConfig(): GoogleHealthConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Google Health credentials not found. Create ${CONFIG_PATH} with:\n` +
        `{\n  "client_id": "YOUR_CLIENT_ID",\n  "client_secret": "YOUR_CLIENT_SECRET"\n}\n\n` +
        `Enable the API + create an OAuth client at ` +
        `https://console.cloud.google.com/apis/library/health.googleapis.com`,
    );
  }
  const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  if (!saved.client_id || !saved.client_secret) {
    throw new Error(
      `Google Health credentials incomplete. Ensure ${CONFIG_PATH} contains both client_id and client_secret`,
    );
  }
  return { client_id: saved.client_id, client_secret: saved.client_secret };
}

// Google only returns refresh_token on first consent; preserve it (and the cached
// account name) across refreshes.
function googleTokenExtractor(
  response: OAuth2TokenResponse,
  previous?: GoogleHealthTokens,
): GoogleHealthTokens {
  return {
    access_token: response.access_token,
    refresh_token: response.refresh_token ?? previous?.refresh_token,
    expires_at: Date.now() + response.expires_in * 1000,
    scope: response.scope ?? previous?.scope,
    account_name: previous?.account_name,
  };
}

const GOOGLE_HEALTH_OAUTH: OAuth2ProviderConfig = {
  name: "Google Health",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  authMethod: "body",
  contentType: "form",
  pkce: true,
  scopes: SCOPES,
  // Required to receive a refresh_token from Google.
  extraAuthParams: { access_type: "offline", prompt: "consent" },
};

function createGoogleHealthOAuthClient(config: GoogleHealthConfig) {
  return createOAuth2Client<GoogleHealthTokens>({
    provider: GOOGLE_HEALTH_OAUTH,
    credentials: { clientId: config.client_id, clientSecret: config.client_secret },
    stateKey: STATE_KEY,
    tokenExtractor: googleTokenExtractor,
  });
}

// ============================================================================
// API helpers
// ============================================================================

async function parseGhResponse(response: Response, path: string): Promise<unknown> {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Google Health API ${response.status} on ${path}:\n${body}`);
  }
  return body ? JSON.parse(body) : null;
}

async function ghGet(
  tokens: GoogleHealthTokens,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${API_BASE}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
  });
  return parseGhResponse(response, path);
}

async function ghPost(tokens: GoogleHealthTokens, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return parseGhResponse(response, path);
}

interface Identity {
  name?: string;
  legacyUserId?: string;
  healthUserId?: string;
}

async function getIdentity(tokens: GoogleHealthTokens): Promise<Identity> {
  return (await ghGet(tokens, "/users/me/identity")) as Identity;
}

/**
 * Derive a stable source_account. Prefer the profile display name (matches the
 * existing Fitbit account label); fall back to the Fitbit legacy user id from the
 * identity endpoint. Cached on the token so we only resolve it once.
 */
async function ensureAccountName(tokens: GoogleHealthTokens): Promise<string> {
  if (tokens.account_name) return tokens.account_name;

  let name: string | undefined;
  try {
    const profile = (await ghGet(tokens, "/users/me/profile")) as Record<string, unknown>;
    const displayName =
      typeof profile.displayName === "string" ? profile.displayName : undefined;
    if (displayName) name = sanitizeAccountName(displayName) || undefined;
  } catch {
    // Profile endpoint optional for account naming; fall back to identity below.
  }

  if (!name) {
    const identity = await getIdentity(tokens);
    name = identity.legacyUserId ?? identity.healthUserId;
  }
  if (!name) throw new Error("Could not derive a Google Health account name");

  createTokenManager<GoogleHealthTokens>(STATE_KEY).save({ ...tokens, account_name: name });
  return name;
}

// ============================================================================
// Time helpers
// ============================================================================

const DATE_BOUND_RE = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

function toDailyDateBound(value: string): string {
  const match = DATE_BOUND_RE.exec(value);
  if (!match) {
    throw new Error(`Expected YYYY-MM-DD date bound, got: ${value}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date bound: ${value}`);
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseOffsetSeconds(offset?: string): number {
  if (offset === undefined) return 0;
  if (!/^-?\d+(?:\.\d{1,9})?s$/.test(offset)) throw new Error(`Google Health utcOffset is invalid: ${JSON.stringify(offset)}`);
  const seconds = Number(offset.slice(0, -1));
  if (!Number.isSafeInteger(seconds)) throw new Error(`Google Health utcOffset is invalid: ${JSON.stringify(offset)}`);
  return seconds;
}

/** Convert a UTC RFC3339 time + a "<seconds>s" offset into local ISO with a numeric zone. */
export function toLocalIso(utc: string, offset?: string): string {
  const offsetSec = parseOffsetSeconds(offset);
  const local = new Date(Date.parse(utc) + offsetSec * 1000);
  const wall = local.toISOString().replace("Z", ""); // wall-clock as if UTC == local
  const sign = offsetSec < 0 ? "-" : "+";
  const abs = Math.abs(offsetSec);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  return `${wall}${sign}${hh}:${mm}`;
}

// ============================================================================
// Sleep
// ============================================================================

interface SleepInterval {
  startTime: string;
  endTime: string;
  startUtcOffset?: string;
  endUtcOffset?: string;
}
interface StageSummary {
  type: string;
  minutes: string;
  count: string;
}
interface SleepSummary {
  minutesInSleepPeriod?: string;
  minutesAsleep?: string;
  minutesAwake?: string;
  stagesSummary?: StageSummary[];
}
interface SleepPayload {
  interval: SleepInterval;
  type?: string;
  summary?: SleepSummary;
}
interface SleepDataPoint {
  name: string;
  sleep: SleepPayload;
}
interface DataPointsResponse<T> {
  dataPoints?: T[];
}

async function fetchPages<T>(
  context: string,
  field: string,
  request: (pageToken: string | undefined) => Promise<unknown>,
): Promise<T[]> {
  const all: T[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const response = asObject(await request(pageToken), `${context} response`);
    const points = response[field];
    if (points !== undefined) {
      if (!Array.isArray(points)) throw new Error(`Google Health ${context} ${field} is not an array`);
      all.push(...points as T[]);
    }
    const next = response.nextPageToken;
    if (next !== undefined && typeof next !== "string") throw new Error(`Google Health ${context} page token is invalid`);
    pageToken = next || undefined;
    if (pageToken) {
      if (seenTokens.has(pageToken)) throw new Error(`Google Health ${context} pagination did not advance`);
      seenTokens.add(pageToken);
    }
  } while (pageToken);
  return all;
}

export interface GoogleHealthSyncStats {
  apiRecords: number;
  imported: number;
  skipped: number;
  sleep: number;
  naps: number;
  dailyMetrics: number;
  activity: number;
  azm: number;
  weight: number;
}

function dataPointId(name: string): string {
  const parts = name.split("/");
  return parts[parts.length - 1] || name;
}

type DailySummaryParams = Record<string, string>;

interface DailySummaryDataPoint {
  name: string;
  dataSource?: unknown;
  [key: string]: unknown;
}

interface DailySummaryOptions {
  pageSize?: number;
  pageToken?: string;
}

function dataTypeField(dataType: string): string {
  // Google's generated list docs show lower-camel JSON union fields here, but
  // the live filter parser rejected `dailyHeartRateVariability.date` on
  // 2026-06-18 and accepted the proto-style snake_case restriction field.
  return dataType.replaceAll("-", "_");
}

export function buildDailySummaryParams(
  dataType: string,
  startDate: string,
  endDate: string,
  options: DailySummaryOptions = {},
): DailySummaryParams {
  const field = dataTypeField(dataType);
  const params: DailySummaryParams = {
    filter: `${field}.date >= "${toDailyDateBound(startDate)}" AND ${field}.date < "${toDailyDateBound(endDate)}"`,
    pageSize: String(options.pageSize ?? 100),
  };
  if (options.pageToken) params.pageToken = options.pageToken;
  return params;
}

export function resolveProbeDailySummaryDataType(
  dataType: string | undefined = DEFAULT_DAILY_SUMMARY_DATA_TYPE,
): HealthMetricsDailySummaryDataType {
  if (HEALTH_METRICS_DAILY_SUMMARY_DATA_TYPE_SET.has(dataType)) {
    return dataType as HealthMetricsDailySummaryDataType;
  }
  throw new Error(
    `Unsupported daily summary data type "${dataType}". This probe only requests ` +
      `${HEALTH_METRICS_SCOPE} and supports: ${HEALTH_METRICS_DAILY_SUMMARY_DATA_TYPES.join(", ")}`,
  );
}

async function fetchDailySummary(
  tokens: GoogleHealthTokens,
  dataType: HealthMetricsDailySummaryDataType,
  startDate: string,
  endDate: string,
  options: Omit<DailySummaryOptions, "pageToken"> = {},
): Promise<DataPointsResponse<DailySummaryDataPoint>> {
  const dataPoints = await fetchPages<DailySummaryDataPoint>("daily summary", "dataPoints", pageToken => ghGet(
      tokens,
      `/users/me/dataTypes/${encodeURIComponent(dataType)}/dataPoints`,
      buildDailySummaryParams(dataType, startDate, endDate, {
        ...options,
        pageToken,
      }),
    ));
  return { dataPoints };
}

function tokenHasScope(tokens: GoogleHealthTokens, scope: string): boolean {
  return tokens.scope?.split(/\s+/).includes(scope) ?? false;
}

function stageMinutes(summary: SleepSummary | undefined, type: string): number | undefined {
  const entry = summary?.stagesSummary?.find((s) => s.type === type);
  return entry ? Number(entry.minutes) : undefined;
}

function durationMs(dp: SleepDataPoint): number {
  return Date.parse(dp.sleep.interval.endTime) - Date.parse(dp.sleep.interval.startTime);
}

/**
 * Fetch all sleep data points whose local (civil) WAKE date falls in [startDate, endDate).
 * Sleep is a "session" data type: it filters on `civil_end_time` (the wake time,
 * which matches Fitbit's dateOfSleep grouping), not start time. Bounds are plain
 * local dates (YYYY-MM-DD). Paginates via nextPageToken.
 */
async function fetchSleep(
  tokens: GoogleHealthTokens,
  startDate: string,
  endDate: string,
): Promise<SleepDataPoint[]> {
  return fetchPages<SleepDataPoint>("sleep", "dataPoints", pageToken => {
    const params: Record<string, string> = {
      filter: `sleep.interval.civil_end_time >= "${startDate}" AND sleep.interval.civil_end_time < "${endDate}"`,
      page_size: "100",
    };
    if (pageToken) params.page_token = pageToken;
    return ghGet(tokens, "/users/me/dataTypes/sleep/dataPoints", params);
  });
}

/**
 * The new API dropped Fitbit's `isMainSleep` flag. Classify the longest sleep
 * period of each local night as the main `sleep`; any shorter period that night
 * is a `sleep:nap`. Nights are keyed by the local wake date (end of the period),
 * matching Fitbit's `dateOfSleep` grouping.
 */
export function mainSleepIds(points: SleepDataPoint[]): Set<string> {
  const byNight = new Map<string, SleepDataPoint[]>();
  for (const dp of points) {
    const night = toLocalIso(dp.sleep.interval.endTime, dp.sleep.interval.endUtcOffset).slice(0, 10);
    const existing = byNight.get(night);
    if (existing) existing.push(dp);
    else byNight.set(night, [dp]);
  }
  const main = new Set<string>();
  for (const group of byNight.values()) {
    let best = group[0];
    for (const dp of group) {
      if (durationMs(dp) > durationMs(best)) best = dp;
    }
    main.add(best.name);
  }
  return main;
}

function syncSleep(
  db: Database,
  account: string,
  points: SleepDataPoint[],
  importBatch: string,
  stats: GoogleHealthSyncStats,
): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp,
      duration_ms, title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const mainIds = mainSleepIds(points);
  stats.apiRecords += points.length;

  for (const dp of points) {
    const { interval, summary } = dp.sleep;
    const isMain = mainIds.has(dp.name);
    const type = isMain ? "sleep" : "sleep:nap";
    const dur = durationMs(dp);

    const deep = stageMinutes(summary, "DEEP");
    const light = stageMinutes(summary, "LIGHT");
    const rem = stageMinutes(summary, "REM");
    const awake = stageMinutes(summary, "AWAKE");

    const asleep = summary?.minutesAsleep ? Number(summary.minutesAsleep) : undefined;
    const inBed = summary?.minutesInSleepPeriod ? Number(summary.minutesInSleepPeriod) : undefined;
    const efficiency =
      asleep && inBed ? Math.round((asleep / inBed) * 100) : undefined;

    let title = `Sleep: ${formatDuration(dur)}`;
    if (efficiency !== undefined) title += ` (${efficiency}% efficiency)`;

    const stageParts: string[] = [];
    if (deep !== undefined) stageParts.push(`Deep: ${deep}m`);
    if (light !== undefined) stageParts.push(`Light: ${light}m`);
    if (rem !== undefined) stageParts.push(`REM: ${rem}m`);
    if (awake !== undefined) stageParts.push(`Awake: ${awake}m`);
    const contentParts: string[] = [];
    if (stageParts.length) contentParts.push(stageParts.join(", "));
    if (inBed !== undefined) contentParts.push(`Time in bed: ${inBed}m`);
    const content = contentParts.join("\n");

    const tags: string[] = [SOURCE, "api"];
    if (deep !== undefined) tags.push(`deep:${deep}`);
    if (light !== undefined) tags.push(`light:${light}`);
    if (rem !== undefined) tags.push(`rem:${rem}`);
    if (awake !== undefined) tags.push(`wake:${awake}`);

    try {
      const result = insert.run(
        SOURCE,
        `sleep:${dataPointId(dp.name)}`,
        account,
        type,
        toLocalIso(interval.startTime, interval.startUtcOffset),
        toLocalIso(interval.endTime, interval.endUtcOffset),
        dur,
        title,
        content,
        JSON.stringify(tags),
        JSON.stringify(dp),
        importBatch,
      );
      if (result.changes > 0) {
        stats.imported++;
        if (isMain) stats.sleep++;
        else stats.naps++;
      } else {
        stats.skipped++;
      }
    } catch {
      stats.skipped++;
    }
  }
}

// ============================================================================
// Daily metrics
// ============================================================================

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

function civilDateToIso(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Google Health daily summary has no date: ${JSON.stringify(value)}`);
  }
  const { year, month, day } = value as Partial<CivilDate>;
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return toDailyDateBound(date);
}

/** Proto3 JSON encodes non-finite doubles as these strings; they carry no measurement. */
const NON_FINITE_DOUBLES = new Set(["NaN", "Infinity", "-Infinity"]);

/** Read a numeric field that the API may encode as a number or a decimal string. */
function numberField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  if (value == null) return undefined;
  if (typeof value === "string" && NON_FINITE_DOUBLES.has(value)) return undefined;
  if ((typeof value !== "string" && typeof value !== "number") || (typeof value === "string" && value.trim() === "")) {
    throw new Error(`Google Health field ${key} is not numeric: ${JSON.stringify(value)}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Google Health field ${key} is not numeric: ${JSON.stringify(value)}`);
  }
  return n;
}

interface DailyMetricText {
  title: string;
  content: string;
}

interface DailyMetricImport {
  dataType: HealthMetricsDailySummaryDataType;
  /** Event type shared with the legacy `fitbit` source. */
  eventType: string;
  /** Title and content for a payload, or null when the day carries no value. */
  describe(payload: Record<string, unknown>): DailyMetricText | null;
}

export const DAILY_METRIC_IMPORTS: readonly DailyMetricImport[] = [
  {
    dataType: "daily-heart-rate-variability",
    eventType: "daily:hrv",
    describe(payload) {
      const rmssd = numberField(payload, "averageHeartRateVariabilityMilliseconds");
      if (rmssd === undefined) return null;
      const deep = numberField(payload, "deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds");
      const parts = [`Daily RMSSD: ${rmssd.toFixed(1)} ms`];
      if (deep !== undefined) parts.push(`Deep sleep RMSSD: ${deep.toFixed(1)} ms`);
      return { title: `HRV: ${rmssd.toFixed(1)}ms RMSSD`, content: parts.join(", ") };
    },
  },
  {
    dataType: "daily-oxygen-saturation",
    eventType: "daily:spo2",
    describe(payload) {
      const avg = numberField(payload, "averagePercentage");
      if (avg === undefined) return null;
      const min = numberField(payload, "lowerBoundPercentage");
      const max = numberField(payload, "upperBoundPercentage");
      let content = `Average: ${avg.toFixed(1)}%`;
      if (min !== undefined && max !== undefined) {
        content += ` (range: ${min.toFixed(1)}% - ${max.toFixed(1)}%)`;
      }
      return { title: `SpO2: ${avg.toFixed(1)}%`, content };
    },
  },
  {
    dataType: "daily-respiratory-rate",
    eventType: "daily:breathing",
    describe(payload) {
      const rate = numberField(payload, "breathsPerMinute");
      if (rate === undefined) return null;
      return {
        title: `Breathing Rate: ${rate.toFixed(1)} breaths/min`,
        content: `Sleep breathing rate: ${rate.toFixed(1)} breaths per minute`,
      };
    },
  },
  {
    dataType: "daily-resting-heart-rate",
    eventType: "daily:heart",
    describe(payload) {
      const bpm = numberField(payload, "beatsPerMinute");
      if (bpm === undefined) return null;
      return { title: `Resting HR: ${bpm} bpm`, content: `Resting heart rate: ${bpm} bpm` };
    },
  },
  {
    dataType: "daily-sleep-temperature-derivations",
    eventType: "daily:temperature",
    describe(payload) {
      // Fitbit reported the nightly deviation from baseline; Google Health
      // reports both absolute values.
      const nightly = numberField(payload, "nightlyTemperatureCelsius");
      const baseline = numberField(payload, "baselineTemperatureCelsius");
      if (nightly === undefined || baseline === undefined) return null;
      const deviation = nightly - baseline;
      const signed = `${deviation >= 0 ? "+" : ""}${deviation.toFixed(2)}°C`;
      return {
        title: `Temperature: ${signed}`,
        content: `Skin temperature deviation from baseline: ${signed}`,
      };
    },
  },
];

export interface DailyMetricEvent extends DailyMetricText {
  sourceId: string;
  timestamp: string;
  tags: string[];
}

/** "daily-resting-heart-rate" → "dailyRestingHeartRate", the payload's JSON field. */
function payloadField(dataType: string): string {
  return dataType.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Map a daily summary data point to a `daily:*` event, or null when the day has
 * no value. The civil date is stored as UTC midnight so its date prefix and
 * SQLite's DATE() agree.
 */
export function dailyMetricEvent(
  metric: DailyMetricImport,
  dp: DailySummaryDataPoint,
): DailyMetricEvent | null {
  const payload = dp[payloadField(metric.dataType)];
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`Google Health ${metric.dataType} data point has no payload: ${dp.name}`);
  }
  const fields = payload as Record<string, unknown>;
  const date = civilDateToIso(fields.date);
  const text = metric.describe(fields);
  if (!text) return null;
  const kind = metric.eventType.replace(/^daily:/, "");
  return {
    ...text,
    sourceId: `${kind}:${date}`,
    timestamp: `${date}T00:00:00Z`,
    tags: [SOURCE, "api", kind],
  };
}

function syncDailyMetric(
  db: Database,
  account: string,
  metric: DailyMetricImport,
  points: DailySummaryDataPoint[],
  importBatch: string,
  stats: GoogleHealthSyncStats,
): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stats.apiRecords += points.length;
  for (const dp of points) {
    const event = dailyMetricEvent(metric, dp);
    if (!event) {
      stats.skipped++;
      continue;
    }
    insert.run(
      SOURCE,
      event.sourceId,
      account,
      metric.eventType,
      event.timestamp,
      event.title,
      event.content,
      JSON.stringify(event.tags),
      JSON.stringify(dp),
      importBatch,
    );
    stats.imported++;
    stats.dailyMetrics++;
  }
}

// ============================================================================
// Activity rollups and weight samples
// ============================================================================

const ACTIVITY_ROLLUPS = [
  "steps", "distance", "floors", "total-calories", "active-minutes", "sedentary-period",
] as const;
type ActivityRollup = (typeof ACTIVITY_ROLLUPS)[number];
type RollupType = ActivityRollup | "active-zone-minutes";

interface RollupPoint {
  civilStartTime?: { date?: unknown };
  civilEndTime?: { date?: unknown };
  [key: string]: unknown;
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Google Health ${context} is not an object: ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function requiredNumber(payload: Record<string, unknown>, key: string, context: string): number {
  const value = numberField(payload, key);
  if (value === undefined) throw new Error(`Google Health ${context} has no ${key}`);
  return value;
}

function rollupDate(point: RollupPoint): string {
  const date = civilDateToIso(point.civilStartTime?.date);
  if (!point.civilEndTime?.date) throw new Error(`Google Health rollup has no civil end date`);
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  if (civilDateToIso(point.civilEndTime.date) !== next.toISOString().slice(0, 10)) {
    throw new Error(`Google Health rollup does not cover one civil day: ${date}`);
  }
  return date;
}

function civilDateObject(date: string): CivilDate {
  const [year, month, day] = toDailyDateBound(date).split("-").map(Number);
  return { year, month, day };
}

export async function fetchDailyRollups(
  tokens: GoogleHealthTokens,
  dataType: RollupType,
  startDate: string,
  endDate: string,
): Promise<RollupPoint[]> {
  const all: RollupPoint[] = [];
  const end = new Date(`${toDailyDateBound(endDate)}T00:00:00Z`);
  for (let cursor = new Date(`${toDailyDateBound(startDate)}T00:00:00Z`); cursor < end;) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + 14 * 86_400_000, end.getTime()));
    const range = {
      start: { date: civilDateObject(cursor.toISOString().slice(0, 10)) },
      end: { date: civilDateObject(chunkEnd.toISOString().slice(0, 10)) },
    };
    const points = await fetchPages<RollupPoint>(dataType, "rollupDataPoints", pageToken => {
      const path = `/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`;
      return ghPost(tokens, path, {
        range, windowSizeDays: 1, pageSize: 100, ...(pageToken ? { pageToken } : {}),
      });
    });
    all.push(...points);
    cursor = chunkEnd;
  }
  return all;
}

interface MappedHealthEvent extends DailyMetricEvent {
  rawData: unknown;
}

function activeMinutes(payload: Record<string, unknown>): Record<string, number> {
  const entries = payload.activeMinutesRollupByActivityLevel;
  const levels: Record<string, number> = { LIGHT: 0, MODERATE: 0, VIGOROUS: 0 };
  if (entries === undefined) return levels;
  if (!Array.isArray(entries)) throw new Error("Google Health activeMinutes activity levels are invalid");
  for (const entry of entries) {
    const value = asObject(entry, "activity level");
    const level = value.activityLevel;
    if (typeof level !== "string" || !Object.hasOwn(levels, level)) throw new Error(`Google Health activity level is invalid: ${JSON.stringify(level)}`);
    levels[level] += requiredNumber(value, "activeMinutesSum", "activity level");
  }
  return levels;
}

function activityValue(type: ActivityRollup, payload: Record<string, unknown>): number | Record<string, number> | undefined {
  const field = type === "distance" ? "millimetersSum" : type === "total-calories" ? "kcalSum" : type === "sedentary-period" ? "durationSum" : "countSum";
  if (type === "active-minutes") return activeMinutes(payload);
  if (payload[field] == null) return undefined;
  if (type === "sedentary-period") {
    const duration = payload.durationSum;
    if (typeof duration !== "string" || !/^-?\d+(?:\.\d+)?s$/.test(duration)) throw new Error(`Google Health sedentary duration is invalid: ${JSON.stringify(duration)}`);
    return Number(duration.slice(0, -1)) / 60;
  }
  return requiredNumber(payload, field, type);
}

export function activityEvents(rollups: Record<ActivityRollup, RollupPoint[]>): MappedHealthEvent[] {
  const byDate = new Map<string, Record<string, unknown>>();
  for (const type of ACTIVITY_ROLLUPS) {
    for (const point of rollups[type]) {
      const date = rollupDate(point);
      const field = payloadField(type);
      if (point[field] === undefined) continue;
      const payload = asObject(point[field], `${type} payload`);
      activityValue(type, payload);
      const merged = byDate.get(date) ?? { date: civilDateObject(date) };
      if (merged[field] !== undefined) throw new Error(`Google Health duplicate ${type} rollup for ${date}`);
      merged[field] = payload;
      byDate.set(date, merged);
    }
  }
  const events: MappedHealthEvent[] = [];
  for (const [date, merged] of byDate) {
    const value = (type: ActivityRollup) => {
      const payload = merged[payloadField(type)];
      return payload ? activityValue(type, payload as Record<string, unknown>) : undefined;
    };
    const steps = value("steps") as number | undefined;
    const calories = value("total-calories") as number | undefined;
    const distance = value("distance") as number | undefined;
    const floors = value("floors") as number | undefined;
    const minutes = value("active-minutes") as Record<string, number> | undefined;
    const sedentary = value("sedentary-period") as number | undefined;
    if (steps === undefined || steps === 0) continue;
    const parts: string[] = [`Steps: ${steps.toLocaleString()}`];
    if (calories !== undefined) parts.push(`Calories: ${Math.round(calories).toLocaleString()}`);
    if (distance !== undefined) parts.push(`Distance: ${(distance / 1_000_000).toFixed(2)} km`);
    if (floors !== undefined) parts.push(`Floors: ${floors}`);
    if (sedentary !== undefined) parts.push(`Sedentary: ${Math.round(sedentary)}min`);
    if (minutes) parts.push(`Light: ${minutes.LIGHT}min, Fairly Active: ${minutes.MODERATE}min, Very Active: ${minutes.VIGOROUS}min`);
    events.push({
      sourceId: `activity:${date}`,
      timestamp: `${date}T00:00:00Z`,
      title: `${steps.toLocaleString()} steps, ${Math.round(calories ?? 0).toLocaleString()} cal`,
      content: parts.join(", "),
      tags: [SOURCE, "api", "activity"],
      rawData: merged,
    });
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function azmEvent(point: RollupPoint): MappedHealthEvent | null {
  const date = rollupDate(point);
  if (point.activeZoneMinutes === undefined) return null;
  const payload = asObject(point.activeZoneMinutes, "active-zone-minutes payload");
  const fields = ["sumInFatBurnHeartZone", "sumInCardioHeartZone", "sumInPeakHeartZone"];
  if (fields.every(field => payload[field] == null)) return null;
  const total = fields.reduce((sum, field) => sum + (payload[field] == null ? 0 : requiredNumber(payload, field, "active-zone-minutes")), 0);
  if (total === 0) return null;
  return {
    sourceId: `azm:${date}`,
    timestamp: `${date}T00:00:00Z`,
    title: `Active Zone Minutes: ${total}`,
    content: `Fat burn: ${payload.sumInFatBurnHeartZone ?? 0}min, Cardio: ${payload.sumInCardioHeartZone ?? 0}min, Peak: ${payload.sumInPeakHeartZone ?? 0}min`,
    tags: [SOURCE, "api", "azm"],
    rawData: point,
  };
}

interface SamplePoint {
  name?: string;
  weight?: unknown;
  height?: unknown;
}

async function fetchSamples(tokens: GoogleHealthTokens, type: "weight" | "height", startDate: string, endDate: string): Promise<SamplePoint[]> {
  return fetchPages<SamplePoint>(type, "dataPoints", pageToken => {
    const params: Record<string, string> = {
      filter: `${type}.sample_time.civil_time >= "${toDailyDateBound(startDate)}" AND ${type}.sample_time.civil_time < "${toDailyDateBound(endDate)}"`,
      pageSize: "100",
    };
    if (pageToken) params.pageToken = pageToken;
    return ghGet(tokens, `/users/me/dataTypes/${type}/dataPoints`, params);
  });
}

function sampleTime(payload: Record<string, unknown>, type: string): { physicalTime: string; utcOffset: string; epoch: number } {
  const sample = asObject(payload.sampleTime, `${type} sampleTime`);
  const physicalTime = sample.physicalTime;
  const utcOffset = sample.utcOffset;
  if (typeof physicalTime !== "string" || !Number.isFinite(Date.parse(physicalTime))) throw new Error(`Google Health ${type} physicalTime is invalid`);
  if (typeof utcOffset !== "string") throw new Error(`Google Health ${type} utcOffset is invalid`);
  parseOffsetSeconds(utcOffset);
  return { physicalTime, utcOffset, epoch: Date.parse(physicalTime) };
}

interface HeightSample { epoch: number; mm: number }

export function parseHeightSamples(points: SamplePoint[]): HeightSample[] {
  return points.map(point => {
    const height = asObject(point.height, "height payload");
    const time = sampleTime(height, "height");
    const mm = requiredNumber(height, "heightMillimeters", "height");
    if (mm <= 0) throw new Error("Google Health height must be positive");
    return { epoch: time.epoch, mm };
  });
}

export function weightEvent(point: SamplePoint, heights: HeightSample[]): MappedHealthEvent {
  if (!point.name || point.name.endsWith("/")) throw new Error("Google Health weight point has no name");
  const payload = asObject(point.weight, "weight payload");
  const time = sampleTime(payload, "weight");
  const grams = requiredNumber(payload, "weightGrams", "weight");
  const kg = grams / 1000;
  let latestHeight: HeightSample | undefined;
  for (const height of heights) {
    if (height.epoch <= time.epoch && (!latestHeight || height.epoch > latestHeight.epoch)) {
      latestHeight = height;
    }
  }
  const bmi = latestHeight ? kg / (latestHeight.mm / 1000) ** 2 : undefined;
  return {
    sourceId: `weight:${dataPointId(point.name)}`,
    timestamp: toLocalIso(time.physicalTime, time.utcOffset),
    title: `Weight: ${kg.toFixed(1)} kg`,
    content: bmi === undefined ? "Weight measurement" : `BMI: ${bmi.toFixed(1)}`,
    tags: [SOURCE, "api", "weight"],
    rawData: point,
  };
}

function insertMappedEvents(db: Database, account: string, type: string, events: MappedHealthEvent[], importBatch: string): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of events) {
    insert.run(SOURCE, event.sourceId, account, type, event.timestamp, event.title, event.content,
      JSON.stringify(event.tags), JSON.stringify(event.rawData), importBatch);
  }
}

// ============================================================================
// Entry point
// ============================================================================

export interface GoogleHealthSyncOptions {
  verbose?: boolean;
  headless?: boolean;
  /** ISO/date lower bound (inclusive). Defaults to 30 days ago. */
  since?: string;
  /** ISO/date upper bound (exclusive). Defaults to now. */
  until?: string;
}

/** Local date bound (YYYY-MM-DD) for the civil-date filters. */
function toDateBound(value: string | undefined, fallback: Date): string {
  return (value ?? fallback.toISOString()).slice(0, 10);
}

function defaultProbeBounds(now = new Date()): { since: string; until: string } {
  return {
    since: toDateBound(undefined, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)),
    until: toDateBound(undefined, new Date(now.getTime() + 24 * 60 * 60 * 1000)),
  };
}

export async function syncGoogleHealth(
  options: GoogleHealthSyncOptions = {},
): Promise<GoogleHealthSyncStats> {
  const config = loadConfig();
  const client = createGoogleHealthOAuthClient(config);
  const tokens = await client.ensureValidToken({ headless: options.headless });
  if (!tokenHasScope(tokens, HEALTH_METRICS_SCOPE)) {
    throw new Error(
      `Google Health token lacks ${HEALTH_METRICS_SCOPE}. Re-run: bun run src/parsers/google-health-api.ts auth`,
    );
  }
  if (!tokenHasScope(tokens, ACTIVITY_AND_FITNESS_SCOPE)) {
    throw new Error(
      `Google Health token lacks ${ACTIVITY_AND_FITNESS_SCOPE}. Re-run: bun run src/parsers/google-health-api.ts auth`,
    );
  }
  const account = await ensureAccountName(tokens);

  const since = toDateBound(options.since, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  // Upper bound is exclusive; default to tomorrow so last night's sleep is included.
  const until = toDateBound(options.until, new Date(Date.now() + 24 * 60 * 60 * 1000));

  const stats: GoogleHealthSyncStats = {
    apiRecords: 0,
    imported: 0,
    skipped: 0,
    sleep: 0,
    naps: 0,
    dailyMetrics: 0,
    activity: 0,
    azm: 0,
    weight: 0,
  };

  const db = getDb();
  try {
    initDb(db);
    const importBatch = `google-health-${new Date().toISOString()}`;
    const points = await fetchSleep(tokens, since, until);
    if (options.verbose) {
      console.log(`[google-health] sleep ${since}..${until}: ${points.length} records`);
    }
    syncSleep(db, account, points, importBatch, stats);

    for (const metric of DAILY_METRIC_IMPORTS) {
      const { dataPoints = [] } = await fetchDailySummary(tokens, metric.dataType, since, until);
      if (options.verbose) {
        console.log(`[google-health] ${metric.dataType} ${since}..${until}: ${dataPoints.length} records`);
      }
      syncDailyMetric(db, account, metric, dataPoints, importBatch, stats);
    }

    const activityRollups = {} as Record<ActivityRollup, RollupPoint[]>;
    for (const type of ACTIVITY_ROLLUPS) {
      const rollups = await fetchDailyRollups(tokens, type, since, until);
      activityRollups[type] = rollups;
      stats.apiRecords += rollups.length;
      if (options.verbose) console.log(`[google-health] ${type} ${since}..${until}: ${rollups.length} rollups`);
    }
    const activity = activityEvents(activityRollups);
    const activityDates = new Set(ACTIVITY_ROLLUPS.flatMap(type => activityRollups[type].map(rollupDate)));
    stats.skipped += activityDates.size - activity.length;
    insertMappedEvents(db, account, "daily:activity", activity, importBatch);
    stats.activity += activity.length;
    stats.imported += activity.length;

    const zoneRollups = await fetchDailyRollups(tokens, "active-zone-minutes", since, until);
    stats.apiRecords += zoneRollups.length;
    const azm = zoneRollups.flatMap(point => {
      const event = azmEvent(point);
      if (!event) {
        stats.skipped++;
        return [];
      }
      return [event];
    });
    insertMappedEvents(db, account, "daily:azm", azm, importBatch);
    stats.azm += azm.length;
    stats.imported += azm.length;
    if (options.verbose) console.log(`[google-health] active-zone-minutes ${since}..${until}: ${zoneRollups.length} rollups`);

    const weightPoints = await fetchSamples(tokens, "weight", since, until);
    // A height recorded years ago still applies until a newer sample replaces it.
    const heightPoints = await fetchSamples(tokens, "height", "1900-01-01", until);
    const heights = parseHeightSamples(heightPoints);
    stats.apiRecords += weightPoints.length;
    const weight = weightPoints.map(point => weightEvent(point, heights));
    insertMappedEvents(db, account, "daily:weight", weight, importBatch);
    stats.weight += weight.length;
    stats.imported += weight.length;
    if (options.verbose) console.log(`[google-health] weight ${since}..${until}: ${weightPoints.length} samples`);
  } finally {
    db.close();
  }

  if (options.verbose) {
    console.log(
      `[google-health] imported ${stats.imported} (${stats.sleep} sleep, ${stats.naps} naps, ${stats.dailyMetrics} daily metrics, ${stats.activity} activity, ${stats.azm} AZM, ${stats.weight} weight), skipped ${stats.skipped}`,
    );
  }
  return stats;
}

if (import.meta.main) {
  const command = process.argv[2] ?? "sync";

  if (command === "auth") {
    const client = createGoogleHealthOAuthClient(loadConfig());
    await client.authorize();
    console.log("Authenticated.");
  } else if (command === "probe") {
    const client = createGoogleHealthOAuthClient(loadConfig());
    const tokens = await client.ensureValidToken();
    console.log("identity:", JSON.stringify(await getIdentity(tokens), null, 2));
    try {
      console.log("profile:", JSON.stringify(await ghGet(tokens, "/users/me/profile"), null, 2));
    } catch (error) {
      console.log("profile failed:", error instanceof Error ? error.message : error);
    }
    const recent = (await ghGet(tokens, "/users/me/dataTypes/sleep/dataPoints", {
      page_size: "2",
    })) as DataPointsResponse<SleepDataPoint>;
    console.log(`recent sleep points: ${recent.dataPoints?.length ?? 0}`);
    const dataType = process.argv[3];
    let probeDataType: HealthMetricsDailySummaryDataType;
    try {
      probeDataType = resolveProbeDailySummaryDataType(dataType);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
    const hasHealthMetricsScope = tokenHasScope(tokens, HEALTH_METRICS_SCOPE);
    if (!hasHealthMetricsScope) {
      console.log(
        `stored token does not list ${HEALTH_METRICS_SCOPE}; run "bun run src/parsers/google-health-api.ts auth" before probing daily summaries.`,
      );
      if (dataType) process.exit(1);
    }
    if (hasHealthMetricsScope) {
      const bounds = defaultProbeBounds();
      const since = process.argv[4] ?? bounds.since;
      const until = process.argv[5] ?? bounds.until;
      console.log(`daily summary ${probeDataType} ${since}..${until}:`);
      console.log(
        JSON.stringify(await fetchDailySummary(tokens, probeDataType, since, until), null, 2),
      );
    }
  } else {
    const stats = await syncGoogleHealth({
      verbose: true,
      since: process.argv[3],
      until: process.argv[4],
    });
    console.log(stats);
  }
}
