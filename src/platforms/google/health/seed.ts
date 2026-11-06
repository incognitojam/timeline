import {
  activityEvents,
  azmEvent,
  DAILY_METRIC_IMPORTS,
  dailyMetricEvent,
  mainSleepIds,
  parseHeightSamples,
  toLocalIso,
  weightEvent,
} from "./parser";
import { formatDuration } from "../../../lib/format";
import type { SeedContext, SeedSource } from "../../../seed/context";
import type { Rng } from "../../../seed/rng";
import { GOOGLE_HEALTH_DAYS, type HealthDay, healthDay, type SleepLevel, type SleepPeriod } from "../seed-data/life-health";

/**
 * Google Health API (Fitbit's replacement) for the most recent year. The sync
 * needs OAuth, so this builds the API's data points and runs them through the
 * parser's exported mappers (mainSleepIds, dailyMetricEvent, activityEvents,
 * azmEvent, weightEvent). Its insert helpers are private, so the INSERT
 * statements and the sleep title/content/tags below mirror syncSleep,
 * syncDailyMetric, and insertMappedEvents.
 */

const SOURCE = "google-health";
/** The sync derives this from the profile display name ("Alex"). */
const ACCOUNT = "alex";

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

function civil(date: string): CivilDate {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return { year, month, day };
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function previousDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** "-07:00" → "-25200s", the API's utcOffset encoding. */
function offsetSeconds(ctx: SeedContext, at: Date): string {
  const offset = ctx.localOffset(at);
  const sign = offset.startsWith("-") ? -1 : 1;
  return `${sign * (Number(offset.slice(1, 3)) * 3600 + Number(offset.slice(4, 6)) * 60)}s`;
}

const STAGE_TYPES: Record<SleepLevel, string> = { wake: "AWAKE", light: "LIGHT", deep: "DEEP", rem: "REM" };

function sleepPoint(ctx: SeedContext, rng: Rng, day: HealthDay, period: SleepPeriod) {
  const start = ctx.localDate(previousDate(day.date), 0, period.startMin);
  const end = new Date(start.getTime() + period.inBedMin * 60_000);
  const levels: SleepLevel[] = period.staged ? ["wake", "light", "deep", "rem"] : ["wake", "light"];
  return {
    name: `users/me/dataTypes/sleep/dataPoints/${rng.digits(19)}`,
    sleep: {
      interval: {
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        startUtcOffset: offsetSeconds(ctx, start),
        endUtcOffset: offsetSeconds(ctx, end),
      },
      type: period.staged ? "STAGES" : "CLASSIC",
      summary: {
        minutesInSleepPeriod: String(period.inBedMin),
        minutesAsleep: String(period.asleepMin),
        minutesAwake: String(period.minutes.wake),
        minutesToFallAsleep: String(period.latencyMin),
        stagesSummary: levels.map((level) => ({
          type: STAGE_TYPES[level],
          minutes: String(period.minutes[level]),
          count: String(period.counts[level]),
        })),
      },
      stages: period.segments.map((s) => ({
        startTime: new Date(start.getTime() + s.offset * 1000).toISOString(),
        endTime: new Date(start.getTime() + (s.offset + s.seconds) * 1000).toISOString(),
        type: STAGE_TYPES[s.level],
      })),
    },
  };
}

type SleepPoint = ReturnType<typeof sleepPoint>;

function stageMinutes(point: SleepPoint, type: string): number | undefined {
  const entry = point.sleep.summary.stagesSummary.find((s) => s.type === type);
  return entry ? Number(entry.minutes) : undefined;
}

/** Payload per daily-summary data type, keyed by its camelCase JSON field. */
function dailyPayload(dataType: string, day: HealthDay): Record<string, unknown> {
  const date = civil(day.date);
  switch (dataType) {
    case "daily-heart-rate-variability":
      return {
        date,
        averageHeartRateVariabilityMilliseconds: day.rmssd,
        deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: day.deepRmssd,
      };
    case "daily-oxygen-saturation":
      return { date, averagePercentage: day.spo2, lowerBoundPercentage: day.spo2Low, upperBoundPercentage: day.spo2High };
    case "daily-respiratory-rate":
      return { date, breathsPerMinute: day.breathing };
    case "daily-resting-heart-rate":
      return { date, beatsPerMinute: String(day.restingHr) };
    case "daily-sleep-temperature-derivations":
      return { date, nightlyTemperatureCelsius: day.temperature, baselineTemperatureCelsius: day.baselineTemperature };
    default:
      throw new Error(`No seed payload for Google Health data type ${dataType}`);
  }
}

function camel(dataType: string): string {
  return dataType.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export const googleHealthSeed: SeedSource = {
  name: "google-health",
  produces: {
    "google-health": [
      "sleep",
      "sleep:nap",
      "daily:hrv",
      "daily:spo2",
      "daily:breathing",
      "daily:heart",
      "daily:activity",
      "daily:temperature",
      "daily:azm",
      "daily:weight",
    ],
  },
  async seed(ctx) {
    const rng = ctx.rng("google-health");
    const days = ctx.recentDays(GOOGLE_HEALTH_DAYS).map((d) => healthDay(ctx, d));
    const db = ctx.db;
    const importBatch = `google-health-seed-${ctx.anchorDate}`;

    // Sleep (mirrors syncSleep).
    const points: SleepPoint[] = [];
    for (const day of days) {
      points.push(sleepPoint(ctx, rng, day, day.night));
      if (day.nap) points.push(sleepPoint(ctx, rng, day, day.nap));
    }
    const mainIds = mainSleepIds(points);
    const insertSleep = db.prepare(`
      INSERT OR REPLACE INTO events (
        source, source_id, source_account, type, timestamp, end_timestamp,
        duration_ms, title, content, tags, raw_data, import_batch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertDaily = db.prepare(`
      INSERT OR REPLACE INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, tags, raw_data, import_batch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
      for (const dp of points) {
        const { interval, summary } = dp.sleep;
        const dur = Date.parse(interval.endTime) - Date.parse(interval.startTime);
        const deep = stageMinutes(dp, "DEEP");
        const light = stageMinutes(dp, "LIGHT");
        const rem = stageMinutes(dp, "REM");
        const awake = stageMinutes(dp, "AWAKE");
        const asleep = Number(summary.minutesAsleep);
        const inBed = Number(summary.minutesInSleepPeriod);
        const efficiency = asleep && inBed ? Math.round((asleep / inBed) * 100) : undefined;
        let title = `Sleep: ${formatDuration(dur)}`;
        if (efficiency !== undefined) title += ` (${efficiency}% efficiency)`;
        const stageParts: string[] = [];
        if (deep !== undefined) stageParts.push(`Deep: ${deep}m`);
        if (light !== undefined) stageParts.push(`Light: ${light}m`);
        if (rem !== undefined) stageParts.push(`REM: ${rem}m`);
        if (awake !== undefined) stageParts.push(`Awake: ${awake}m`);
        const content = [stageParts.join(", "), `Time in bed: ${inBed}m`].join("\n");
        const tags = [SOURCE, "api"];
        if (deep !== undefined) tags.push(`deep:${deep}`);
        if (light !== undefined) tags.push(`light:${light}`);
        if (rem !== undefined) tags.push(`rem:${rem}`);
        if (awake !== undefined) tags.push(`wake:${awake}`);
        const id = dp.name.split("/").at(-1) ?? dp.name;
        insertSleep.run(
          SOURCE, `sleep:${id}`, ACCOUNT, mainIds.has(dp.name) ? "sleep" : "sleep:nap",
          toLocalIso(interval.startTime, interval.startUtcOffset), toLocalIso(interval.endTime, interval.endUtcOffset),
          dur, title, content, JSON.stringify(tags), JSON.stringify(dp), importBatch,
        );
      }

      // Daily summaries (mirrors syncDailyMetric).
      for (const metric of DAILY_METRIC_IMPORTS) {
        for (const day of days) {
          const dp = { name: `users/me/dataTypes/${metric.dataType}/dataPoints/${rng.digits(19)}`, [camel(metric.dataType)]: dailyPayload(metric.dataType, day) };
          const event = dailyMetricEvent(metric, dp);
          if (!event) throw new Error(`Google Health seed produced an empty ${metric.dataType} for ${day.date}`);
          insertDaily.run(SOURCE, event.sourceId, ACCOUNT, metric.eventType, event.timestamp, event.title, event.content, JSON.stringify(event.tags), JSON.stringify(dp), importBatch);
        }
      }

      // Activity rollups, zone minutes, and weight (mirror insertMappedEvents).
      const rollup = (date: string, payload: Record<string, unknown>) => ({
        civilStartTime: { date: civil(date) },
        civilEndTime: { date: civil(nextDate(date)) },
        ...payload,
      });
      const activity = activityEvents({
        steps: days.map((d) => rollup(d.date, { steps: { countSum: String(d.steps) } })),
        distance: days.map((d) => rollup(d.date, { distance: { millimetersSum: String(Math.round(d.steps * 762)) } })),
        floors: days.map((d) => rollup(d.date, { floors: { countSum: String(d.floors) } })),
        "total-calories": days.map((d) => rollup(d.date, { totalCalories: { kcalSum: d.calories + rng.float(0, 1) } })),
        "active-minutes": days.map((d) =>
          rollup(d.date, {
            activeMinutes: {
              activeMinutesRollupByActivityLevel: [
                { activityLevel: "LIGHT", activeMinutesSum: String(d.activeMinutes.light) },
                { activityLevel: "MODERATE", activeMinutesSum: String(d.activeMinutes.moderate) },
                { activityLevel: "VIGOROUS", activeMinutesSum: String(d.activeMinutes.vigorous) },
              ],
            },
          }),
        ),
        "sedentary-period": days.map((d) => rollup(d.date, { sedentaryPeriod: { durationSum: `${d.sedentaryMin * 60}s` } })),
      });
      const azm = days.flatMap((d) => {
        const event = azmEvent(
          rollup(d.date, {
            activeZoneMinutes: {
              sumInFatBurnHeartZone: String(d.azm.fatBurn),
              sumInCardioHeartZone: String(d.azm.cardio),
              sumInPeakHeartZone: String(d.azm.peak),
            },
          }),
        );
        return event ? [event] : [];
      });
      const heights = parseHeightSamples([
        { height: { sampleTime: { physicalTime: "2021-03-02T16:05:00Z", utcOffset: "-28800s" }, heightMillimeters: "1780" } },
      ]);
      const weight = days
        .filter((d) => [1, 3, 6].includes(new Date(`${d.date}T12:00:00Z`).getUTCDay()) || rng.chance(0.1))
        .map((d) => {
          const at = ctx.localDate(d.date, 7, rng.int(5, 55), rng.int(0, 59));
          return weightEvent(
            {
              name: `users/me/dataTypes/weight/dataPoints/${rng.digits(19)}`,
              weight: { sampleTime: { physicalTime: at.toISOString(), utcOffset: offsetSeconds(ctx, at) }, weightGrams: Math.round(d.weightKg * 1000) },
            },
            heights,
          );
        });
      for (const [type, events] of [["daily:activity", activity], ["daily:azm", azm], ["daily:weight", weight]] as const) {
        for (const event of events) {
          insertDaily.run(SOURCE, event.sourceId, ACCOUNT, type, event.timestamp, event.title, event.content, JSON.stringify(event.tags), JSON.stringify(event.rawData), importBatch);
        }
      }
    })();
  },
};
