import type { QueryExecutor } from "./pool";
import { differenceInCalendarDays, subDays } from "date-fns";
import { timeToHours, averageSleepTime } from "../lib/health";
import {
  formatHealthDateOnly,
  type HealthWindowMode,
  type HealthWindowView,
  parseHealthDateOnly,
  resolveHealthWindow,
  shiftHealthWindow,
} from "../shared/health-periods";
import { summarizeHealthDailyValues } from "../shared/health-series";
import { calculateSleepScore, type SleepScoreResult } from "./sleep-score";
import { filterMap } from "../shared/utils";

export interface HealthStatsOptions {
  // Legacy preset support
  preset?: "30d" | "90d" | "year" | "all";
  // View-based navigation
  view?: HealthWindowView;
  mode?: HealthWindowMode;
  offset?: number; // 0 = current, -1 = previous, etc.
  startDate?: string;
  endDate?: string;
}

interface HealthDayData {
  date: string;
  sleepDuration?: number;
  sleepEfficiency?: number;
  steps?: number;
  restingHR?: number;
  hrv?: number;
  spo2?: number;
  weight?: number;
}

// Rolling baseline point for a single day
export interface RollingBaselinePoint {
  date: string;
  lowerBound: number;
  upperBound: number;
}

// Previous period stats for comparison (averages only, no daily data)
export interface PreviousPeriodStats {
  sleep: { avgDuration: number; avgEfficiency: number; avgBedtime: number | null; avgWakeTime: number | null; avgScore: number };
  heart: { avgRestingHR: number };
  hrv: { avgRmssd: number };
  activity: { avgSteps: number; totalSteps: number };
  spo2: { avgValue: number };
  weight: { latest: number | null; change: number | null };
}

export interface HealthStats {
  dateRange: { start: string | null; end: string | null };
  sleep: {
    avgDuration: number;
    avgEfficiency: number;
    avgBedtime: number | null;
    avgWakeTime: number | null;
    avgScore: number;
    nightsTracked: number;
    byDay: { date: string; duration: number; efficiency: number; startTime?: string; endTime?: string; score: number }[];
    naps: { date: string; duration: number; startTime?: string; endTime?: string }[];
  };
  heart: {
    avgRestingHR: number;
    byDay: { date: string; restingHR: number }[];
    rollingBaseline: RollingBaselinePoint[];
  };
  hrv: {
    avgRmssd: number;
    byDay: { date: string; rmssd: number }[];
    rollingBaseline: RollingBaselinePoint[];
  };
  activity: {
    avgSteps: number;
    totalSteps: number;
    daysTracked: number;
    byDay: { date: string; steps: number }[];
  };
  spo2: {
    avgValue: number;
    byDay: { date: string; value: number }[];
    rollingBaseline: RollingBaselinePoint[];
  };
  weight: {
    latest: number | null;
    change: number | null;
    measurements: number;
    byDay: { date: string; weight: number }[];
  };
  previousPeriod?: PreviousPeriodStats;
}

/**
 * Calculate visible and load date ranges based on view and offset
 */
function calculateHealthDateRanges(
  view: HealthWindowView,
  offset: number,
  baselineWindowDays: number = BASELINE_WINDOW_DAYS
): { visibleStart: string; visibleEnd: string; loadStart: string; loadEnd: string } {
  const today = formatHealthDateOnly(new Date());
  const current = resolveHealthWindow({ view, mode: "calendar", anchor: today });
  const visible = offset === 0 ? current : shiftHealthWindow(current, offset);

  // Load extra data for baseline calculation
  const loadStart = subDays(parseHealthDateOnly(visible.range.start), baselineWindowDays);

  return {
    visibleStart: visible.range.start,
    visibleEnd: visible.range.end,
    loadStart: formatHealthDateOnly(loadStart),
    loadEnd: visible.range.end,
  };
}

/**
 * Calculate date range for the previous period (for comparison)
 */
function calculatePreviousPeriodRange(
  view: HealthWindowView,
  mode: HealthWindowMode,
  currentStart: string,
  currentEnd: string
): { start: string; end: string } {
  if (mode === "recent") {
    const days = differenceInCalendarDays(
      parseHealthDateOnly(currentEnd),
      parseHealthDateOnly(currentStart),
    ) + 1;
    return {
      start: formatHealthDateOnly(subDays(parseHealthDateOnly(currentStart), days)),
      end: formatHealthDateOnly(subDays(parseHealthDateOnly(currentEnd), days)),
    };
  }

  return shiftHealthWindow(
    resolveHealthWindow({ view, mode: "calendar", anchor: currentStart }),
    -1,
  ).range;
}

/**
 * Get averages for a date range (used for previous period comparison)
 */
async function getHealthAverages(
  db: QueryExecutor,
  startDate: string,
  endDate: string
): Promise<PreviousPeriodStats> {
  const dayStart = startDate + "T00:00:00";
  const dayEnd = endDate + "T24:00:00";

  // Sleep — main nights only, via the shared cross-source fetch (per-date
  // google-health precedence, keyed by wake date).
  const sleepData = (await fetchSleepRows(db, startDate, endDate)).filter(d => !d.isNap);
  const validSleep = sleepData.filter((d): d is typeof d & { duration: number; efficiency: number } => !!(d.duration && d.efficiency));
  const avgSleepDuration = validSleep.length > 0
    ? validSleep.reduce((sum, d) => sum + d.duration, 0) / validSleep.length
    : 0;
  const avgSleepEfficiency = validSleep.length > 0
    ? validSleep.reduce((sum, d) => sum + d.efficiency, 0) / validSleep.length
    : 0;
  const prevBedtimes = filterMap(validSleep, d => d.startTime);
  const prevWakeTimes = filterMap(validSleep, d => d.endTime);
  const prevAvgBedtime = averageSleepTime(prevBedtimes);
  const prevAvgWakeTime = averageSleepTime(prevWakeTimes);
  const avgSleepScore = validSleep.length > 0
    ? validSleep.reduce((sum, d) => sum + calculateSleepScore({
        durationMs: d.duration,
        efficiency: d.efficiency,
        minutesToFallAsleep: d.minutesToFallAsleep ?? 0,
        deepMinutes: d.deepMinutes ?? undefined,
        lightMinutes: d.lightMinutes ?? undefined,
        remMinutes: d.remMinutes ?? undefined,
        wakeMinutes: d.wakeMinutes ?? undefined,
      }).score, 0) / validSleep.length
    : 0;

  // Heart
  const heartData = await fetchDailyMetricRows(db, dayStart, dayEnd, "daily:heart");
  const validHeartValues = filterMap(heartData, d => d.value);
  const avgRestingHR = validHeartValues.length > 0
    ? validHeartValues.reduce((sum, v) => sum + v, 0) / validHeartValues.length
    : 0;

  // HRV
  const hrvData = await fetchDailyMetricRows(db, dayStart, dayEnd, "daily:hrv");
  const validHrvValues = filterMap(hrvData, d => d.value);
  const avgHrv = validHrvValues.length > 0
    ? validHrvValues.reduce((sum, v) => sum + v, 0) / validHrvValues.length
    : 0;

  // Activity
  const activityData = await fetchActivityRows(db, dayStart, dayEnd);
  const validStepValues = filterMap(activityData, d => d.steps != null ? d.steps : null);
  const avgSteps = validStepValues.length > 0
    ? validStepValues.reduce((sum, v) => sum + v, 0) / validStepValues.length
    : 0;
  const totalSteps = activityData.reduce((sum, d) => sum + (d.steps ?? 0), 0);

  // SpO2
  const spo2Data = await fetchDailyMetricRows(db, dayStart, dayEnd, "daily:spo2");
  const validSpo2Values = filterMap(spo2Data, d => d.value);
  const avgSpo2 = validSpo2Values.length > 0
    ? validSpo2Values.reduce((sum, v) => sum + v, 0) / validSpo2Values.length
    : 0;

  // Weight
  const weightData = await fetchWeightRows(db, dayStart, dayEnd);
  const validWeightValues = filterMap(weightData, d => d.weight);
  const latestWeight = validWeightValues.length > 0 ? validWeightValues[validWeightValues.length - 1] : null;
  const firstWeight = validWeightValues.length > 1 ? validWeightValues[0] : null;
  const weightChange = latestWeight && firstWeight ? latestWeight - firstWeight : null;

  return {
    sleep: { avgDuration: avgSleepDuration, avgEfficiency: avgSleepEfficiency, avgBedtime: prevAvgBedtime, avgWakeTime: prevAvgWakeTime, avgScore: avgSleepScore },
    heart: { avgRestingHR },
    hrv: { avgRmssd: avgHrv },
    activity: { avgSteps, totalSteps },
    spo2: { avgValue: avgSpo2 },
    weight: { latest: latestWeight, change: weightChange },
  };
}

/**
 * Aggregate daily data into monthly data for year view
 */
function aggregateToMonthly<T extends { date: string }>(
  data: T[],
  valueKey: keyof T
): { date: string; value: number }[] {
  const byMonth = new Map<string, number[]>();

  for (const item of data) {
    const month = item.date.slice(0, 7); // YYYY-MM
    if (!byMonth.has(month)) {
      byMonth.set(month, []);
    }
    byMonth.get(month)?.push(item[valueKey] as number);
  }

  return Array.from(byMonth.entries())
    .map(([month, values]) => ({
      date: month + "-15", // Mid-month for display
      value: values.reduce((sum, v) => sum + v, 0) / values.length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Aggregate rolling baseline into monthly data for year view
 */
function aggregateBaselineToMonthly(
  data: RollingBaselinePoint[]
): RollingBaselinePoint[] {
  const byMonth = new Map<string, { lower: number[]; upper: number[] }>();

  for (const item of data) {
    const month = item.date.slice(0, 7); // YYYY-MM
    if (!byMonth.has(month)) {
      byMonth.set(month, { lower: [], upper: [] });
    }
    const monthData = byMonth.get(month);
    if (monthData) {
      monthData.lower.push(item.lowerBound);
      monthData.upper.push(item.upperBound);
    }
  }

  return Array.from(byMonth.entries())
    .map(([month, values]) => ({
      date: month + "-15", // Mid-month for display
      lowerBound: values.lower.reduce((sum, v) => sum + v, 0) / values.lower.length,
      upperBound: values.upper.reduce((sum, v) => sum + v, 0) / values.upper.length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

interface ActivityRow {
  date: string;
  steps: number | null;
  caloriesOut: number | null;
  fairlyActive: number | null;
  veryActive: number | null;
  floors: number | null;
}

/**
 * Naps shorter than this are treated as incidental rest (drowsing) and dropped
 * from the sleep charts.
 */
const MIN_NAP_DURATION_MS = 20 * 60 * 1000;

interface SleepRow {
  date: string;
  /** false = the night's main sleep (`type='sleep'`), true = a `sleep:nap`. */
  isNap: boolean;
  duration: number | null;
  efficiency: number | null;
  deepMinutes: number | null;
  lightMinutes: number | null;
  remMinutes: number | null;
  startTime: string | null;
  endTime: string | null;
  minutesToFallAsleep: number | null;
  wakeMinutes: number | null;
}

interface StageMinutes {
  deep: number | null;
  light: number | null;
  rem: number | null;
  wake: number | null;
}

/**
 * Derive per-stage minutes from a google-health `sleep.summary.stagesSummary`
 * JSON array (mirrors the parser's stageMinutes helper). Classic short naps
 * only report an `ASLEEP` stage, so deep/light/rem stay null there.
 */
function parseStageMinutes(stagesJson: string | null): StageMinutes {
  const result: StageMinutes = { deep: null, light: null, rem: null, wake: null };
  if (!stagesJson) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stagesJson);
  } catch {
    return result;
  }
  if (!Array.isArray(parsed)) return result;
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const { type, minutes } = entry as { type?: unknown; minutes?: unknown };
    const mins = minutes != null ? Number(minutes) : Number.NaN;
    if (Number.isNaN(mins)) continue;
    if (type === "DEEP") result.deep = mins;
    else if (type === "LIGHT") result.light = mins;
    else if (type === "REM") result.rem = mins;
    else if (type === "AWAKE") result.wake = mins;
  }
  return result;
}

interface WeightRow {
  date: string;
  weight: number | null;
}

interface DailyMetricRow {
  date: string;
  value: number | null;
}

interface FitbitRawData {
  activity: ActivityRow[];
  sleep: SleepRow[];
  heart: DailyMetricRow[];
  hrv: DailyMetricRow[];
  spo2: DailyMetricRow[];
  weight: WeightRow[];
  breathing: DailyMetricRow[];
  temperature: DailyMetricRow[];
}

type DailyMetricType = "daily:heart" | "daily:hrv" | "daily:spo2" | "daily:breathing" | "daily:temperature";

/** SQL value expression for each daily metric, per recording source's raw_data shape. */
const DAILY_METRIC_VALUE_SQL: Record<DailyMetricType, { fitbit: string; googleHealth: string }> = {
  "daily:heart": {
    fitbit: `COALESCE(
      json_extract(raw_data, '$.value.restingHeartRate'),
      json_extract(raw_data, '$.restingHeartRate')
    )`,
    googleHealth: `CAST(json_extract(raw_data, '$.dailyRestingHeartRate.beatsPerMinute') AS INTEGER)`,
  },
  "daily:hrv": {
    fitbit: `COALESCE(
      json_extract(raw_data, '$.value.dailyRmssd'),
      json_extract(raw_data, '$.dailyRmssd'),
      json_extract(raw_data, '$.hrv.dailyRmssd')
    )`,
    googleHealth: `json_extract(raw_data, '$.dailyHeartRateVariability.averageHeartRateVariabilityMilliseconds')`,
  },
  "daily:spo2": {
    fitbit: `COALESCE(
      json_extract(raw_data, '$.value.avg'),
      json_extract(raw_data, '$.avg')
    )`,
    googleHealth: `json_extract(raw_data, '$.dailyOxygenSaturation.averagePercentage')`,
  },
  "daily:breathing": {
    fitbit: `COALESCE(
      json_extract(raw_data, '$.value.breathingRate'),
      json_extract(raw_data, '$.breathingRate')
    )`,
    googleHealth: `json_extract(raw_data, '$.dailyRespiratoryRate.breathsPerMinute')`,
  },
  "daily:temperature": {
    fitbit: `COALESCE(
      json_extract(raw_data, '$.value.nightlyRelative'),
      json_extract(raw_data, '$.nightlyRelative'),
      json_extract(raw_data, '$.tempSkin.nightlyRelative')
    )`,
    // Fitbit's nightlyRelative is the nightly deviation from baseline.
    googleHealth: `json_extract(raw_data, '$.dailySleepTemperatureDerivations.nightlyTemperatureCelsius')
      - json_extract(raw_data, '$.dailySleepTemperatureDerivations.baselineTemperatureCelsius')`,
  },
};

/**
 * Fitbit and google-health record the same days. On any date google-health
 * covers, use only its rows; otherwise keep fitbit's.
 */
function preferGoogleHealthByDate<Row extends { date: string }>(fitbit: Row[], googleHealth: Row[]): Row[] {
  const googleHealthDates = new Set(googleHealth.map(r => r.date));
  return [...fitbit.filter(r => !googleHealthDates.has(r.date)), ...googleHealth]
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchPreferredRows<Row extends { date: string }>(
  db: QueryExecutor,
  dayStart: string,
  dayEnd: string,
  type: string,
  columns: { fitbit: string; googleHealth: string },
): Promise<Row[]> {
  const query = (source: string, projection: string) => db.query<Row>(`
    SELECT substr(timestamp, 1, 10) as date, ${projection}
    FROM events
    WHERE source = ? AND type = ?
      AND timestamp >= ? AND timestamp < ?
    ORDER BY julianday(timestamp)
  `, source, type, dayStart, dayEnd);
  const fitbit = await query("fitbit", columns.fitbit);
  const googleHealth = await query("google-health", columns.googleHealth);
  return preferGoogleHealthByDate(fitbit, googleHealth);
}

/**
 * Fetch a daily metric from both sources with per-date google-health precedence.
 * Dates come from the stored timestamp prefix (see fetchFitbitData).
 */
async function fetchDailyMetricRows(
  db: QueryExecutor,
  dayStart: string,
  dayEnd: string,
  type: DailyMetricType,
): Promise<DailyMetricRow[]> {
  const valueSql = DAILY_METRIC_VALUE_SQL[type];
  return fetchPreferredRows(db, dayStart, dayEnd, type, {
    fitbit: `${valueSql.fitbit} as value`,
    googleHealth: `${valueSql.googleHealth} as value`,
  });
}

async function fetchActivityRows(db: QueryExecutor, dayStart: string, dayEnd: string): Promise<ActivityRow[]> {
  return fetchPreferredRows(db, dayStart, dayEnd, "daily:activity", {
    fitbit: `json_extract(raw_data, '$.steps') as steps,
      json_extract(raw_data, '$.calories') as caloriesOut,
      json_extract(raw_data, '$.minutesFairlyActive') as fairlyActive,
      json_extract(raw_data, '$.minutesVeryActive') as veryActive,
      json_extract(raw_data, '$.floors') as floors`,
    googleHealth: `CAST(json_extract(raw_data, '$.steps.countSum') AS INTEGER) as steps,
      ROUND(json_extract(raw_data, '$.totalCalories.kcalSum')) as caloriesOut,
      COALESCE((SELECT SUM(CAST(json_extract(value, '$.activeMinutesSum') AS INTEGER))
        FROM json_each(raw_data, '$.activeMinutes.activeMinutesRollupByActivityLevel')
        WHERE json_extract(value, '$.activityLevel') = 'MODERATE'), 0) as fairlyActive,
      COALESCE((SELECT SUM(CAST(json_extract(value, '$.activeMinutesSum') AS INTEGER))
        FROM json_each(raw_data, '$.activeMinutes.activeMinutesRollupByActivityLevel')
        WHERE json_extract(value, '$.activityLevel') = 'VIGOROUS'), 0) as veryActive,
      CAST(json_extract(raw_data, '$.floors.countSum') AS INTEGER) as floors`,
  });
}

async function fetchWeightRows(db: QueryExecutor, dayStart: string, dayEnd: string): Promise<WeightRow[]> {
  return fetchPreferredRows(db, dayStart, dayEnd, "daily:weight", {
    fitbit: `json_extract(raw_data, '$.weight') as weight`,
    googleHealth: `json_extract(raw_data, '$.weight.weightGrams') / 1000.0 as weight`,
  });
}

interface FitbitSleepQueryRow {
  date: string | null;
  type: string;
  duration: number | null;
  efficiency: number | null;
  deepMinutes: number | null;
  lightMinutes: number | null;
  remMinutes: number | null;
  wakeMinutes: number | null;
  startTime: string | null;
  endTime: string | null;
  minutesToFallAsleep: number | null;
}

interface GoogleHealthSleepQueryRow {
  date: string;
  type: string;
  duration: number | null;
  asleep: string | null;
  inBed: string | null;
  minutesToFallAsleep: string | null;
  stagesJson: string | null;
  startTime: string | null;
  endTime: string | null;
}

/**
 * Fetch normalized sleep rows (main sleep + naps) for a date range, spanning
 * both recording sources. Fitbit and google-health record the SAME sessions,
 * so per-date precedence applies: if a date has any google-health sleep, only
 * google-health rows are used for that date; otherwise fitbit. Days are keyed
 * by the local wake date (fitbit `dateOfSleep`; google-health the date portion
 * of the stored, offset-baked `end_timestamp`).
 */
async function fetchSleepRows(db: QueryExecutor, startDate: string, endDate: string): Promise<SleepRow[]> {
  // Fitbit: only full sleep-log rows carry `dateOfSleep`; sleep-score-only rows
  // lack it and are excluded by the WHERE clause (as before).
  const fitbit = await db.query<FitbitSleepQueryRow>(`
    SELECT
      json_extract(raw_data, '$.dateOfSleep') as date,
      type,
      json_extract(raw_data, '$.duration') as duration,
      json_extract(raw_data, '$.efficiency') as efficiency,
      json_extract(raw_data, '$.levels.summary.deep.minutes') as deepMinutes,
      json_extract(raw_data, '$.levels.summary.light.minutes') as lightMinutes,
      json_extract(raw_data, '$.levels.summary.rem.minutes') as remMinutes,
      json_extract(raw_data, '$.levels.summary.wake.minutes') as wakeMinutes,
      timestamp as startTime,
      end_timestamp as endTime,
      json_extract(raw_data, '$.minutesToFallAsleep') as minutesToFallAsleep
    FROM events
    WHERE source = 'fitbit' AND type IN ('sleep', 'sleep:nap')
      AND json_extract(raw_data, '$.dateOfSleep') >= ? AND json_extract(raw_data, '$.dateOfSleep') <= ?
    ORDER BY date
  `, startDate, endDate);

  // Google Health: efficiency and stage minutes are derived from sleep.summary
  // (the parser's shape); duration/start/end come from the normalized columns.
  const googleHealth = await db.query<GoogleHealthSleepQueryRow>(`
    SELECT
      substr(end_timestamp, 1, 10) as date,
      type,
      duration_ms as duration,
      json_extract(raw_data, '$.sleep.summary.minutesAsleep') as asleep,
      json_extract(raw_data, '$.sleep.summary.minutesInSleepPeriod') as inBed,
      json_extract(raw_data, '$.sleep.summary.minutesToFallAsleep') as minutesToFallAsleep,
      json_extract(raw_data, '$.sleep.summary.stagesSummary') as stagesJson,
      timestamp as startTime,
      end_timestamp as endTime
    FROM events
    WHERE source = 'google-health' AND type IN ('sleep', 'sleep:nap')
      AND substr(end_timestamp, 1, 10) >= ? AND substr(end_timestamp, 1, 10) <= ?
    ORDER BY date
  `, startDate, endDate);

  const fitbitRows = filterMap(fitbit, (r): SleepRow | null => {
    if (!r.date) return null;
    return {
      date: r.date,
      isNap: r.type === "sleep:nap",
      duration: r.duration,
      efficiency: r.efficiency,
      deepMinutes: r.deepMinutes,
      lightMinutes: r.lightMinutes,
      remMinutes: r.remMinutes,
      startTime: r.startTime,
      endTime: r.endTime,
      minutesToFallAsleep: r.minutesToFallAsleep,
      wakeMinutes: r.wakeMinutes,
    };
  });

  const googleHealthRows = googleHealth.map((r): SleepRow => {
    const asleep = r.asleep != null ? Number(r.asleep) : null;
    const inBed = r.inBed != null ? Number(r.inBed) : null;
    const efficiency = asleep != null && inBed != null && inBed > 0
      ? Math.round((asleep / inBed) * 100)
      : null;
    const stages = parseStageMinutes(r.stagesJson);
    return {
      date: r.date,
      isNap: r.type === "sleep:nap",
      duration: r.duration,
      efficiency,
      deepMinutes: stages.deep,
      lightMinutes: stages.light,
      remMinutes: stages.rem,
      startTime: r.startTime,
      endTime: r.endTime,
      minutesToFallAsleep: r.minutesToFallAsleep != null ? Number(r.minutesToFallAsleep) : null,
      wakeMinutes: stages.wake,
    };
  });

  return preferGoogleHealthByDate(fitbitRows, googleHealthRows);
}

/**
 * Fetch all health data for a date range from the fitbit and google-health
 * sources. Returns raw query results for each metric type.
 */
async function fetchFitbitData(db: QueryExecutor, startDate: string, endDate: string): Promise<FitbitRawData> {
  const dayStart = startDate + "T00:00:00";
  const dayEnd = endDate + "T24:00:00";

  // Daily metric timestamps encode the measurement date as local midnight.
  // SQLite DATE() converts offsets to UTC and collapses adjacent dates when
  // daylight saving begins, so retain the date prefix recorded by Fitbit.
  const activity = await fetchActivityRows(db, dayStart, dayEnd);

  // Sleep spans both recording sources, keyed by the local wake date, with
  // per-date google-health precedence and naps included (see fetchSleepRows).
  const sleep = await fetchSleepRows(db, startDate, endDate);

  const heart = await fetchDailyMetricRows(db, dayStart, dayEnd, "daily:heart");
  const hrv = await fetchDailyMetricRows(db, dayStart, dayEnd, "daily:hrv");
  const spo2 = await fetchDailyMetricRows(db, dayStart, dayEnd, "daily:spo2");

  const weight = await fetchWeightRows(db, dayStart, dayEnd);

  const breathing = await fetchDailyMetricRows(db, dayStart, dayEnd, "daily:breathing");
  const temperature = await fetchDailyMetricRows(db, dayStart, dayEnd, "daily:temperature");

  return { activity, sleep, heart, hrv, spo2, weight, breathing, temperature };
}

/**
 * Get aggregated health statistics from Fitbit data
 */
export async function getHealthStats(db: QueryExecutor, options: HealthStatsOptions = {}): Promise<HealthStats> {
  const {
    preset = "30d",
    view,
    mode = "calendar",
    offset = 0,
    startDate: customStart,
    endDate: customEnd,
  } = options;

  // Calculate date range based on view or preset
  let startDate: string;
  let endDate: string;
  let visibleStart: string;
  let visibleEnd: string;
  const today = new Date();

  if (view && customStart) {
    // View + custom dates: use custom dates as visible range (new URL format)
    visibleStart = customStart;
    visibleEnd = customEnd || today.toISOString().slice(0, 10);
    // Load extra data for baseline calculation
    const loadStart = new Date(visibleStart);
    loadStart.setDate(loadStart.getDate() - BASELINE_WINDOW_DAYS);
    startDate = loadStart.toISOString().slice(0, 10);
    endDate = visibleEnd;
  } else if (view) {
    // View with offset-based navigation (legacy)
    const ranges = calculateHealthDateRanges(view, offset, BASELINE_WINDOW_DAYS);
    startDate = ranges.loadStart;
    endDate = ranges.loadEnd;
    visibleStart = ranges.visibleStart;
    visibleEnd = ranges.visibleEnd;
  } else if (customStart) {
    startDate = customStart;
    endDate = customEnd || today.toISOString().slice(0, 10);
    visibleStart = startDate;
    visibleEnd = endDate;
  } else {
    // Legacy preset support
    endDate = customEnd || today.toISOString().slice(0, 10);
    visibleEnd = endDate;
    switch (preset) {
      case "30d":
        startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        break;
      case "90d":
        startDate = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        break;
      case "year":
        startDate = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        break;
      case "all":
        startDate = "2000-01-01";
        break;
    }
    visibleStart = startDate;
  }

  // Fetch all Fitbit data using shared fetcher
  const rawData = await fetchFitbitData(db, startDate, endDate);

  // Process sleep data — main nights only (naps handled separately below)
  const sleepByDay = filterMap(rawData.sleep, d => {
    if (d.isNap || !d.duration || !d.efficiency) return null;
    return {
      date: d.date,
      duration: d.duration,
      efficiency: d.efficiency,
      ...(d.startTime ? { startTime: d.startTime } : {}),
      ...(d.endTime ? { endTime: d.endTime } : {}),
      score: calculateSleepScore({
        durationMs: d.duration,
        efficiency: d.efficiency,
        minutesToFallAsleep: d.minutesToFallAsleep ?? 0,
        deepMinutes: d.deepMinutes ?? undefined,
        lightMinutes: d.lightMinutes ?? undefined,
        remMinutes: d.remMinutes ?? undefined,
        wakeMinutes: d.wakeMinutes ?? undefined,
      }).score,
    };
  });

  // Process naps — dropping any below the noise threshold
  const napsByDay = filterMap(rawData.sleep, d => {
    if (!d.isNap || !d.duration || d.duration < MIN_NAP_DURATION_MS) return null;
    return {
      date: d.date,
      duration: d.duration,
      ...(d.startTime ? { startTime: d.startTime } : {}),
      ...(d.endTime ? { endTime: d.endTime } : {}),
    };
  });

  // Process heart data
  const heartByDay = filterMap(rawData.heart, d => d.value ? { date: d.date, restingHR: d.value } : null);

  // Process HRV data
  const hrvByDay = filterMap(rawData.hrv, d => d.value ? { date: d.date, rmssd: d.value } : null);

  // Process activity data
  const activityByDay = filterMap(
    rawData.activity,
    d => d.steps != null ? { date: d.date, steps: d.steps } : null,
  );

  // Process SpO2 data
  const spo2ByDay = filterMap(rawData.spo2, d => d.value ? { date: d.date, value: d.value } : null);

  // Process weight data
  const weightByDay = filterMap(rawData.weight, d => d.weight != null ? { date: d.date, weight: d.weight } : null);

  // Calculate rolling baselines first (using all loaded data including preceding window)
  const heartRollingBaseline = calculateRollingBaseline(heartByDay.map(d => ({ date: d.date, value: d.restingHR })));
  const hrvRollingBaseline = calculateRollingBaseline(hrvByDay.map(d => ({ date: d.date, value: d.rmssd })));
  const spo2RollingBaseline = calculateRollingBaseline(spo2ByDay.map(d => ({ date: d.date, value: d.value })));

  // Filter to visible range only (for view-based navigation)
  const isInVisibleRange = (date: string) => date >= visibleStart && date <= visibleEnd;

  const visibleSleepByDay = sleepByDay.filter(d => isInVisibleRange(d.date));
  const visibleNapsByDay = napsByDay.filter(d => isInVisibleRange(d.date));
  const visibleHeartByDay = heartByDay.filter(d => isInVisibleRange(d.date));
  const visibleHrvByDay = hrvByDay.filter(d => isInVisibleRange(d.date));
  const visibleActivityByDay = activityByDay.filter(d => isInVisibleRange(d.date));
  const visibleSpo2ByDay = spo2ByDay.filter(d => isInVisibleRange(d.date));
  const visibleWeightByDay = weightByDay.filter(d => isInVisibleRange(d.date));
  const visibleHeartBaseline = heartRollingBaseline.filter(d => isInVisibleRange(d.date));
  const visibleHrvBaseline = hrvRollingBaseline.filter(d => isInVisibleRange(d.date));
  const visibleSpo2Baseline = spo2RollingBaseline.filter(d => isInVisibleRange(d.date));

  // For year view, aggregate daily data into monthly averages
  const isYearView = view === "year";

  const todayDate = formatHealthDateOnly(today);
  const activitySummary = summarizeHealthDailyValues({
    range: { start: visibleStart, end: visibleEnd },
    completeThrough: todayDate < visibleEnd ? todayDate : visibleEnd,
    entries: visibleActivityByDay.map(d => ({ date: d.date, value: d.steps })),
  });

  // Calculate averages from visible data
  const avgSleepDuration = visibleSleepByDay.length > 0
    ? visibleSleepByDay.reduce((sum, d) => sum + d.duration, 0) / visibleSleepByDay.length
    : 0;
  const avgSleepEfficiency = visibleSleepByDay.length > 0
    ? visibleSleepByDay.reduce((sum, d) => sum + d.efficiency, 0) / visibleSleepByDay.length
    : 0;
  const bedtimes = filterMap(visibleSleepByDay, d => d.startTime);
  const wakeTimes = filterMap(visibleSleepByDay, d => d.endTime);
  const avgBedtime = averageSleepTime(bedtimes);
  const avgWakeTime = averageSleepTime(wakeTimes);
  const avgSleepScore = visibleSleepByDay.length > 0
    ? visibleSleepByDay.reduce((sum, d) => sum + d.score, 0) / visibleSleepByDay.length
    : 0;
  const avgRestingHR = visibleHeartByDay.length > 0
    ? visibleHeartByDay.reduce((sum, d) => sum + d.restingHR, 0) / visibleHeartByDay.length
    : 0;
  const avgHrv = visibleHrvByDay.length > 0
    ? visibleHrvByDay.reduce((sum, d) => sum + d.rmssd, 0) / visibleHrvByDay.length
    : 0;
  const avgSteps = activitySummary.average ?? 0;
  const totalSteps = activitySummary.total;
  const avgSpo2 = visibleSpo2ByDay.length > 0
    ? visibleSpo2ByDay.reduce((sum, d) => sum + d.value, 0) / visibleSpo2ByDay.length
    : 0;

  // Weight change (from visible data)
  const latestWeight = visibleWeightByDay.length > 0 ? visibleWeightByDay[visibleWeightByDay.length - 1].weight : null;
  const firstWeight = visibleWeightByDay.length > 1 ? visibleWeightByDay[0].weight : null;
  const weightChange = latestWeight && firstWeight ? latestWeight - firstWeight : null;

  // For year view, aggregate into monthly data
  const finalSleepByDay = isYearView
    ? aggregateToMonthly(visibleSleepByDay, "duration").map(d => {
        const month = d.date.slice(0, 7); // YYYY-MM
        const monthItems = visibleSleepByDay.filter(s => s.date.slice(0, 7) === month);
        const bedtimes = filterMap(monthItems, s => s.startTime);
        const wakes = filterMap(monthItems, s => s.endTime);
        const avgBed = averageSleepTime(bedtimes);
        const avgWake = averageSleepTime(wakes);
        // Convert avg hours back to a synthetic ISO timestamp for the frontend
        const hoursToIso = (h: number) => {
          const hh = Math.floor(h);
          const mm = Math.round((h - hh) * 60);
          return `2000-01-01T${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}:00`;
        };
        return {
          date: d.date,
          duration: d.value,
          efficiency: aggregateToMonthly(visibleSleepByDay, "efficiency").find(e => e.date === d.date)?.value || 0,
          score: aggregateToMonthly(visibleSleepByDay, "score").find(e => e.date === d.date)?.value || 0,
          ...(avgBed != null ? { startTime: hoursToIso(avgBed) } : {}),
          ...(avgWake != null ? { endTime: hoursToIso(avgWake) } : {}),
        };
      })
    : visibleSleepByDay;

  // Year view: byDay above is a monthly AVERAGE of nightly duration, so naps
  // must match its units. Each month's nap entry is the month's total nap time
  // divided by its tracked nights (the same denominator as the byDay average),
  // so the stacked bar reads as average nightly sleep + average nightly nap
  // time. Months with naps but no tracked nights average over distinct nap dates.
  const finalNaps = isYearView
    ? (() => {
        const napMsByMonth = new Map<string, number>();
        const napDatesByMonth = new Map<string, Set<string>>();
        for (const nap of visibleNapsByDay) {
          const month = nap.date.slice(0, 7); // YYYY-MM
          napMsByMonth.set(month, (napMsByMonth.get(month) ?? 0) + nap.duration);
          const dates = napDatesByMonth.get(month);
          if (dates) dates.add(nap.date);
          else napDatesByMonth.set(month, new Set([nap.date]));
        }
        const nightsByMonth = new Map<string, number>();
        for (const d of visibleSleepByDay) {
          const month = d.date.slice(0, 7);
          nightsByMonth.set(month, (nightsByMonth.get(month) ?? 0) + 1);
        }
        return Array.from(napMsByMonth.entries())
          .map(([month, totalMs]) => {
            const nights = nightsByMonth.get(month) ?? napDatesByMonth.get(month)?.size ?? 1;
            return { date: month + "-15", duration: totalMs / nights };
          })
          .sort((a, b) => a.date.localeCompare(b.date));
      })()
    : visibleNapsByDay;

  const finalHeartByDay = isYearView
    ? aggregateToMonthly(visibleHeartByDay, "restingHR").map(d => ({ date: d.date, restingHR: d.value }))
    : visibleHeartByDay;

  const finalHrvByDay = isYearView
    ? aggregateToMonthly(visibleHrvByDay, "rmssd").map(d => ({ date: d.date, rmssd: d.value }))
    : visibleHrvByDay;

  const finalActivityByDay = isYearView
    ? aggregateToMonthly(visibleActivityByDay, "steps").map(d => ({ date: d.date, steps: d.value }))
    : visibleActivityByDay;

  const finalSpo2ByDay = isYearView
    ? aggregateToMonthly(visibleSpo2ByDay, "value").map(d => ({ date: d.date, value: d.value }))
    : visibleSpo2ByDay;

  const finalWeightByDay = isYearView
    ? aggregateToMonthly(visibleWeightByDay, "weight").map(d => ({ date: d.date, weight: d.value }))
    : visibleWeightByDay;

  // For year view, also aggregate baseline into monthly
  const finalHeartBaseline = isYearView
    ? aggregateBaselineToMonthly(visibleHeartBaseline)
    : visibleHeartBaseline;

  const finalHrvBaseline = isYearView
    ? aggregateBaselineToMonthly(visibleHrvBaseline)
    : visibleHrvBaseline;

  const finalSpo2Baseline = isYearView
    ? aggregateBaselineToMonthly(visibleSpo2Baseline)
    : visibleSpo2Baseline;

  // Calculate previous period stats for comparison (only when using view-based navigation)
  let previousPeriod: PreviousPeriodStats | undefined;
  if (view) {
    const prevRange = calculatePreviousPeriodRange(view, mode, visibleStart, visibleEnd);
    previousPeriod = await getHealthAverages(db, prevRange.start, prevRange.end);
  }

  return {
    dateRange: {
      start: visibleStart,
      end: visibleEnd,
    },
    sleep: {
      avgDuration: avgSleepDuration,
      avgEfficiency: avgSleepEfficiency,
      avgBedtime,
      avgWakeTime,
      avgScore: avgSleepScore,
      nightsTracked: visibleSleepByDay.length,
      byDay: finalSleepByDay,
      naps: finalNaps,
    },
    heart: {
      avgRestingHR,
      byDay: finalHeartByDay,
      rollingBaseline: finalHeartBaseline,
    },
    hrv: {
      avgRmssd: avgHrv,
      byDay: finalHrvByDay,
      rollingBaseline: finalHrvBaseline,
    },
    activity: {
      avgSteps,
      totalSteps,
      daysTracked: activitySummary.recordedDays,
      byDay: finalActivityByDay,
    },
    spo2: {
      avgValue: avgSpo2,
      byDay: finalSpo2ByDay,
      rollingBaseline: finalSpo2Baseline,
    },
    weight: {
      latest: latestWeight,
      change: weightChange,
      measurements: visibleWeightByDay.length,
      byDay: finalWeightByDay,
    },
    previousPeriod,
  };
}

// Fitbit baseline configuration (per Fitbit documentation):
// - Most metrics: 7-30 days of data, ± 2 std dev
// - Skin temp: 3-30 days of data, ± 3 std dev
const BASELINE_WINDOW_DAYS = 30;      // Look back up to 30 days for baseline
const BASELINE_MIN_DAYS = 7;          // Default: require at least 7 days of data
const BASELINE_MIN_DAYS_SKIN_TEMP = 3; // Skin temp: require at least 3 days
const STDDEV_MULTIPLIER = 2;           // Default: ± 2 std dev
const STDDEV_MULTIPLIER_SKIN_TEMP = 3; // Skin temp: ± 3 std dev

/**
 * Calculate mean and standard deviation from an array of values.
 * Returns null if fewer than minDays values.
 */
function calculateMeanAndStddev(
  values: number[],
  minDays: number = BASELINE_MIN_DAYS
): { mean: number; stddev: number } | null {
  if (values.length < minDays) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Calculate rolling baseline for a time series.
 * For each data point, calculates mean ± stddevMultiplier * stddev from the preceding BASELINE_WINDOW_DAYS.
 * Returns empty array if not enough historical data.
 */
function calculateRollingBaseline(
  data: { date: string; value: number }[],
  minDays: number = BASELINE_MIN_DAYS,
  stddevMultiplier: number = STDDEV_MULTIPLIER
): RollingBaselinePoint[] {
  if (data.length < minDays) return [];

  const result: RollingBaselinePoint[] = [];

  // Sort by date to ensure chronological order
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));

  // For each point (starting after we have enough history), calculate baseline from preceding days
  for (let i = minDays; i < sorted.length; i++) {
    const currentDate = sorted[i].date;

    // Get preceding values within the window
    const windowStart = Math.max(0, i - BASELINE_WINDOW_DAYS);
    const precedingValues = sorted.slice(windowStart, i).map(d => d.value);

    const stats = calculateMeanAndStddev(precedingValues, minDays);
    if (stats) {
      result.push({
        date: currentDate,
        lowerBound: stats.mean - stddevMultiplier * stats.stddev,
        upperBound: stats.mean + stddevMultiplier * stats.stddev,
      });
    }
  }

  return result;
}

export interface BiomarkerReferenceRange {
  name: string;
  level: string;
  lower_bound: number | null;
  upper_bound: number | null;
}

export interface BiomarkerData {
  id: string;
  name: string;
  category: string;
  results: {
    date: string;
    value: number;
    unit: string;
    level: string;
    referenceRanges: BiomarkerReferenceRange[];
  }[];
}

/**
 * Get Thriva biomarker results grouped by biomarker type
 */
export async function getBiomarkerResults(db: QueryExecutor): Promise<BiomarkerData[]> {
  const rows = await db.query<{
    source_id: string;
    timestamp: string;
    title: string;
    tags: string | null;
    raw_data: string;
  }>(`
    SELECT
      source_id,
      timestamp,
      title,
      tags,
      raw_data
    FROM events
    WHERE source = 'thriva' AND type = 'thriva:biomarker'
    ORDER BY timestamp DESC
  `);

  // Group by biomarker ID
  const grouped = new Map<string, BiomarkerData>();

  for (const row of rows) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(row.raw_data);
    } catch {
      continue;
    }

    // Thriva stores full API response: raw.attributes.value, raw.relationships.biomarker.data.id
    const attrs = raw.attributes as Record<string, unknown> | undefined;
    const rels = raw.relationships as { biomarker?: { data?: { id?: string } } } | undefined;

    const biomarkerId = rels?.biomarker?.data?.id || row.source_id || "";
    const name = row.title?.split(":")[0]?.trim() || "Unknown";
    const value = (attrs?.value as number) || 0;
    const unit = (attrs?.unit as string) || "";

    // Determine category from tags
    let category = "other";
    if (row.tags) {
      try {
        const tags = JSON.parse(row.tags) as string[];
        const categoryTag = tags.find(t =>
          ["vitamins", "lipids", "liver", "kidney", "thyroid", "hormones", "minerals", "inflammation"].includes(t)
        );
        if (categoryTag) category = categoryTag;
      } catch {
        // ignore
      }
    }

    // Determine level from title
    let level = "normal";
    if (row.title?.includes("++")) level = "optimal";
    else if (row.title?.includes("!!")) level = "highly_abnormal";
    else if (row.title?.includes("!")) level = "abnormal";

    if (!grouped.has(biomarkerId)) {
      grouped.set(biomarkerId, {
        id: biomarkerId,
        name,
        category,
        results: [],
      });
    }

    // Extract reference ranges from attributes
    const rawRanges = attrs?.reference_ranges as Array<{
      name?: string;
      level?: string;
      lower_bound?: number | null;
      upper_bound?: number | null;
    }> | undefined;
    const referenceRanges: BiomarkerReferenceRange[] = rawRanges?.map(r => ({
      name: r.name || "",
      level: r.level || "normal",
      lower_bound: r.lower_bound ?? null,
      upper_bound: r.upper_bound ?? null,
    })) || [];

    grouped.get(biomarkerId)?.results.push({
      date: row.timestamp,
      value,
      unit,
      level,
      referenceRanges,
    });
  }

  // Sort results by date within each biomarker
  for (const biomarker of grouped.values()) {
    biomarker.results.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }

  // Return as array sorted by name
  return Array.from(grouped.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export type RangeStatus = "in_range" | "above" | "below";

export interface MetricWithRange {
  value: number;
  status: RangeStatus;
  personalRange: [number, number];  // [low, high] bounds
}

export interface DayHealthStats {
  date: string;
  hasData: boolean;
  activity?: {
    steps: number;
    caloriesOut: number;
    activeMinutes: number;  // fairly + very active
    floors?: number;
  };
  sleep?: {
    duration: number;       // ms
    efficiency: number;     // %
    deepMinutes?: number;
    lightMinutes?: number;
    remMinutes?: number;
    score?: SleepScoreResult;
  };
  healthMetrics: {
    restingHR?: MetricWithRange;
    hrv?: MetricWithRange;
    spo2?: MetricWithRange;
    breathingRate?: MetricWithRange;
    skinTempVariation?: MetricWithRange;
  };
  outOfRangeCount: number;
  totalMetricCount: number;
}

/**
 * Calculate personal range from historical data.
 * Uses mean ± stddevMultiplier * stddev (default ± 2 std dev, skin temp uses ± 3).
 * Returns null if not enough data (minDays, default 7, skin temp uses 3).
 */
function calculatePersonalRange(
  values: number[],
  minDays: number = BASELINE_MIN_DAYS,
  stddevMultiplier: number = STDDEV_MULTIPLIER
): [number, number] | null {
  const stats = calculateMeanAndStddev(values, minDays);
  if (!stats) return null;
  return [
    stats.mean - stddevMultiplier * stats.stddev,
    stats.mean + stddevMultiplier * stats.stddev
  ];
}

/**
 * Determine if a value is within, above, or below the personal range.
 */
function getRangeStatus(value: number, range: [number, number]): RangeStatus {
  if (value < range[0]) return "below";
  if (value > range[1]) return "above";
  return "in_range";
}

/**
 * Get health stats for a single day with personal range calculations.
 * Queries the date + preceding 30 days for baseline (per Fitbit methodology).
 */
export async function getDayHealthStats(db: QueryExecutor, date: string): Promise<DayHealthStats> {
  // Calculate date range: 30 days before the target date for baseline
  const targetDate = new Date(date + "T12:00:00Z");
  const baselineStart = new Date(targetDate);
  baselineStart.setDate(baselineStart.getDate() - BASELINE_WINDOW_DAYS);
  const startDate = baselineStart.toISOString().slice(0, 10);

  // Fetch all Fitbit data using shared fetcher
  const rawData = await fetchFitbitData(db, startDate, date);

  // Alias for cleaner code
  const activityData = rawData.activity;
  const sleepData = rawData.sleep;
  const heartData = rawData.heart;
  const hrvData = rawData.hrv;
  const spo2Data = rawData.spo2;
  const breathingData = rawData.breathing;
  const tempData = rawData.temperature;

  // Separate historical data from target date
  const isTargetDate = (d: string) => d === date;
  const isHistorical = (d: string) => d < date;

  // Get today's values
  const todayActivity = activityData.find(d => isTargetDate(d.date));
  const todaySleep = sleepData.find(d => isTargetDate(d.date) && !d.isNap);
  const todayHeart = heartData.find(d => isTargetDate(d.date) && d.value);
  const todayHrv = hrvData.find(d => isTargetDate(d.date) && d.value);
  const todaySpo2 = spo2Data.find(d => isTargetDate(d.date) && d.value);
  const todayBreathing = breathingData.find(d => isTargetDate(d.date) && d.value);
  const todayTemp = tempData.find(d => isTargetDate(d.date) && d.value !== null);

  // Get historical values for baseline
  const historicalHeart = filterMap(heartData, d => isHistorical(d.date) && d.value ? d.value : null);
  const historicalHrv = filterMap(hrvData, d => isHistorical(d.date) && d.value ? d.value : null);
  const historicalSpo2 = filterMap(spo2Data, d => isHistorical(d.date) && d.value ? d.value : null);
  const historicalBreathing = filterMap(breathingData, d => isHistorical(d.date) && d.value ? d.value : null);
  const historicalTemp = filterMap(tempData, d => isHistorical(d.date) && d.value !== null ? d.value : null);

  // Calculate personal ranges (per Fitbit methodology)
  // Most metrics: 7-30 days, ± 2 std dev
  // Skin temp: 3-30 days, ± 3 std dev
  const heartRange = calculatePersonalRange(historicalHeart);
  const hrvRange = calculatePersonalRange(historicalHrv);
  const spo2Range = calculatePersonalRange(historicalSpo2);
  const breathingRange = calculatePersonalRange(historicalBreathing);
  const tempRange = calculatePersonalRange(
    historicalTemp,
    BASELINE_MIN_DAYS_SKIN_TEMP,
    STDDEV_MULTIPLIER_SKIN_TEMP
  );

  // Build health metrics with range status
  const healthMetrics: DayHealthStats["healthMetrics"] = {};
  let outOfRangeCount = 0;
  let totalMetricCount = 0;

  if (todayHeart?.value && heartRange) {
    const status = getRangeStatus(todayHeart.value, heartRange);
    healthMetrics.restingHR = {
      value: todayHeart.value,
      status,
      personalRange: heartRange,
    };
    totalMetricCount++;
    if (status !== "in_range") outOfRangeCount++;
  } else if (todayHeart?.value) {
    // No baseline data, show as in_range with placeholder bounds
    healthMetrics.restingHR = {
      value: todayHeart.value,
      status: "in_range",
      personalRange: [0, 0],  // No baseline
    };
    totalMetricCount++;
  }

  if (todayHrv?.value && hrvRange) {
    const status = getRangeStatus(todayHrv.value, hrvRange);
    healthMetrics.hrv = {
      value: todayHrv.value,
      status,
      personalRange: hrvRange,
    };
    totalMetricCount++;
    if (status !== "in_range") outOfRangeCount++;
  } else if (todayHrv?.value) {
    healthMetrics.hrv = {
      value: todayHrv.value,
      status: "in_range",
      personalRange: [0, 0],
    };
    totalMetricCount++;
  }

  if (todaySpo2?.value && spo2Range) {
    const status = getRangeStatus(todaySpo2.value, spo2Range);
    healthMetrics.spo2 = {
      value: todaySpo2.value,
      status,
      personalRange: spo2Range,
    };
    totalMetricCount++;
    if (status !== "in_range") outOfRangeCount++;
  } else if (todaySpo2?.value) {
    healthMetrics.spo2 = {
      value: todaySpo2.value,
      status: "in_range",
      personalRange: [0, 0],
    };
    totalMetricCount++;
  }

  if (todayBreathing?.value && breathingRange) {
    const status = getRangeStatus(todayBreathing.value, breathingRange);
    healthMetrics.breathingRate = {
      value: todayBreathing.value,
      status,
      personalRange: breathingRange,
    };
    totalMetricCount++;
    if (status !== "in_range") outOfRangeCount++;
  } else if (todayBreathing?.value) {
    healthMetrics.breathingRate = {
      value: todayBreathing.value,
      status: "in_range",
      personalRange: [0, 0],
    };
    totalMetricCount++;
  }

  if (todayTemp?.value !== null && todayTemp?.value !== undefined && tempRange) {
    const status = getRangeStatus(todayTemp.value, tempRange);
    healthMetrics.skinTempVariation = {
      value: todayTemp.value,
      status,
      personalRange: tempRange,
    };
    totalMetricCount++;
    if (status !== "in_range") outOfRangeCount++;
  } else if (todayTemp?.value !== null && todayTemp?.value !== undefined) {
    healthMetrics.skinTempVariation = {
      value: todayTemp.value,
      status: "in_range",
      personalRange: [0, 0],
    };
    totalMetricCount++;
  }

  // Check if we have any data for this day
  const hasData = !!(todayActivity || todaySleep || Object.keys(healthMetrics).length > 0);

  return {
    date,
    hasData,
    activity: todayActivity && (todayActivity.steps || todayActivity.caloriesOut) ? {
      steps: todayActivity.steps ?? 0,
      caloriesOut: todayActivity.caloriesOut ?? 0,
      activeMinutes: (todayActivity.fairlyActive ?? 0) + (todayActivity.veryActive ?? 0),
      floors: todayActivity.floors ?? undefined,
    } : undefined,
    sleep: todaySleep && todaySleep.duration ? {
      duration: todaySleep.duration,
      efficiency: todaySleep.efficiency ?? 0,
      deepMinutes: todaySleep.deepMinutes ?? undefined,
      lightMinutes: todaySleep.lightMinutes ?? undefined,
      remMinutes: todaySleep.remMinutes ?? undefined,
      score: calculateSleepScore({
        durationMs: todaySleep.duration,
        efficiency: todaySleep.efficiency ?? 0,
        minutesToFallAsleep: todaySleep.minutesToFallAsleep ?? 0,
        deepMinutes: todaySleep.deepMinutes ?? undefined,
        lightMinutes: todaySleep.lightMinutes ?? undefined,
        remMinutes: todaySleep.remMinutes ?? undefined,
        wakeMinutes: todaySleep.wakeMinutes ?? undefined,
      }),
    } : undefined,
    healthMetrics,
    outOfRangeCount,
    totalMetricCount,
  };
}
