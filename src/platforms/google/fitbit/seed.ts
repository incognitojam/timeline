import { importFitbitData } from "./parser";
import type { SeedDay, SeedSource } from "../../../seed/context";
import { SELF } from "../../../seed/persona";
import { GOOGLE_HEALTH_DAYS, type HealthDay, healthDay, type SleepLevel, type SleepPeriod, wallClock } from "../seed-data/life-health";

/**
 * Fitbit's Google Takeout export (the older "Global Export Data" layout) for
 * the years before Alex's data moved to Google Health. Fitbit writes local wall
 * clock times without a zone, exactly as the importer expects.
 */

function csv(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return `${[header.join(","), ...rows.map((r) => r.join(","))].join("\n")}\n`;
}

function sleepLog(day: HealthDay, period: SleepPeriod, logId: number, main: boolean, avg: Record<SleepLevel, number>) {
  const start = wallClock(day.date, period.startMin);
  const end = wallClock(day.date, period.startMin + period.inBedMin);
  const durationMs = period.inBedMin * 60_000;
  const efficiency = Math.round((period.asleepMin / Math.max(1, period.inBedMin)) * 100);
  if (!period.staged) {
    // Short naps are logged in Fitbit's "classic" asleep/restless/awake levels.
    const awake = period.minutes.wake;
    return {
      logId,
      dateOfSleep: day.date,
      startTime: start,
      endTime: end,
      duration: durationMs,
      minutesToFallAsleep: period.latencyMin,
      minutesAsleep: period.asleepMin,
      minutesAwake: awake,
      minutesAfterWakeup: 2,
      timeInBed: period.inBedMin,
      efficiency,
      type: "classic",
      infoCode: 0,
      logType: "auto_detected",
      mainSleep: main,
      levels: {
        summary: {
          asleep: { count: 1, minutes: period.asleepMin },
          restless: { count: 0, minutes: 0 },
          awake: { count: period.counts.wake, minutes: awake },
        },
        data: period.segments.map((s) => ({
          dateTime: wallClock(day.date, period.startMin, s.offset),
          level: s.level === "wake" ? "awake" : "asleep",
          seconds: s.seconds,
        })),
      },
    };
  }
  const stage = (level: SleepLevel) => ({ count: period.counts[level], minutes: period.minutes[level], thirtyDayAvgMinutes: avg[level] });
  return {
    logId,
    dateOfSleep: day.date,
    startTime: start,
    endTime: end,
    duration: durationMs,
    minutesToFallAsleep: period.latencyMin,
    minutesAsleep: period.asleepMin,
    minutesAwake: period.minutes.wake,
    minutesAfterWakeup: 0,
    timeInBed: period.inBedMin,
    efficiency,
    type: "stages",
    infoCode: 0,
    logType: "auto_detected",
    mainSleep: main,
    levels: {
      summary: { deep: stage("deep"), wake: stage("wake"), light: stage("light"), rem: stage("rem") },
      data: period.segments.map((s) => ({
        dateTime: wallClock(day.date, period.startMin, s.offset),
        level: s.level,
        seconds: s.seconds,
      })),
      shortData: [],
    },
  };
}

export const fitbitSeed: SeedSource = {
  name: "fitbit",
  produces: { fitbit: ["sleep", "sleep:nap", "daily:readiness", "daily:stress", "daily:hrv"] },
  async seed(ctx) {
    const days: SeedDay[] = ctx.days.filter((d) => d.daysAgo >= GOOGLE_HEALTH_DAYS);
    const health = days.map((d) => healthDay(ctx, d));
    const name = "fitbit";

    ctx.writeStaged(
      name,
      "Your Profile/Profile.csv",
      csv(
        ["id", "full_name", "first_name", "last_name", "display_name", "username", "email_address", "date_of_birth", "gender", "height", "weight", "country", "timezone"],
        [["9SEED01", SELF.name, SELF.first, SELF.last, SELF.first, "", SELF.email, SELF.dateOfBirth ?? "", "NA", 178, 74.2, "US", "America/Los_Angeles"]],
      ),
    );

    // Sleep logs, about a month per file, with Fitbit's rolling 30-day stage averages.
    let logId = 41_800_000_000;
    const recent: Record<SleepLevel, number>[] = [];
    let batch: unknown[] = [];
    let batchStart = "";
    const scores: (string | number)[][] = [];
    const flush = () => {
      if (batch.length > 0) ctx.writeStaged(name, `Global Export Data/sleep-${batchStart}.json`, JSON.stringify(batch));
      batch = [];
    };
    for (const day of health) {
      if (batch.length === 0) batchStart = day.date;
      const avg = { wake: 0, light: 0, deep: 0, rem: 0 };
      for (const level of Object.keys(avg) as SleepLevel[]) {
        avg[level] = recent.length === 0 ? day.night.minutes[level] : Math.round(recent.reduce((s, r) => s + r[level], 0) / recent.length);
      }
      logId += 1_000 + (day.date.charCodeAt(9) % 7);
      batch.push(sleepLog(day, day.night, logId, true, avg));
      recent.push(day.night.minutes);
      if (recent.length > 30) recent.shift();
      const duration = Math.min(50, Math.round(day.night.asleepMin / 9.6));
      const composition = Math.min(25, Math.round(12 + day.night.minutes.deep / 9 + day.night.minutes.rem / 15));
      const revitalization = Math.min(25, Math.round(25 - (day.restingHr - 54) * 0.8));
      scores.push([
        logId,
        `${wallClock(day.date, day.night.startMin + day.night.inBedMin)}Z`,
        Math.min(97, duration + composition + revitalization),
        composition,
        revitalization,
        duration,
        day.night.minutes.deep,
        day.restingHr,
        (0.05 + day.night.counts.wake / 400).toFixed(6),
      ]);
      if (day.nap) {
        logId += 97;
        batch.push(sleepLog(day, day.nap, logId, false, avg));
      }
      if (batch.length >= 30) flush();
    }
    flush();

    ctx.writeStaged(
      name,
      "Sleep Score/sleep_score.csv",
      csv(
        ["sleep_log_entry_id", "timestamp", "overall_score", "composition_score", "revitalization_score", "duration_score", "deep_sleep_in_minutes", "resting_heart_rate", "restlessness"],
        scores.reverse(),
      ),
    );

    ctx.writeStaged(
      name,
      "Stress Score/Stress Score.csv",
      csv(
        ["DATE", "UPDATED_AT", "STRESS_SCORE", "SLEEP_POINTS", "MAX_SLEEP_POINTS", "RESPONSIVENESS_POINTS", "MAX_RESPONSIVENESS_POINTS", "EXERTION_POINTS", "MAX_EXERTION_POINTS", "STATUS", "CALCULATION_FAILED"],
        health.map((d) => {
          const sleep = Math.min(30, Math.round(d.night.asleepMin / 16));
          const exertion = Math.min(40, Math.round(18 + d.activeMinutes.vigorous / 4));
          const responsiveness = Math.max(0, Math.min(30, d.stress - sleep - exertion));
          return [d.date, `${d.date}T09:${String(10 + (d.restingHr % 40)).padStart(2, "0")}:00.000`, d.stress, sleep, 30, responsiveness, 30, exertion, 40, "READY", "false"];
        }),
      ),
    );

    // HRV and readiness come in monthly files.
    const months = new Map<string, HealthDay[]>();
    for (const day of health) {
      const month = day.date.slice(0, 7);
      const list = months.get(month);
      if (list) list.push(day);
      else months.set(month, [day]);
    }
    for (const monthDays of months.values()) {
      const first = monthDays[0];
      if (!first) continue;
      ctx.writeStaged(
        name,
        `Heart Rate Variability/Heart Rate Variability Histogram - ${first.date}.csv`,
        csv(
          ["timestamp", "rmssd", "coverage", "low_frequency", "high_frequency"],
          monthDays.map((d) => [
            `${d.date}T${wallClock(d.date, d.night.startMin + 180).slice(11, 19)}`,
            d.rmssd.toFixed(3),
            "0.962",
            Math.round(d.rmssd * 14),
            Math.round(d.rmssd * 9),
          ]),
        ),
      );
      ctx.writeStaged(
        name,
        `Daily Readiness/Daily Readiness Score - ${first.date}.csv`,
        csv(
          ["date", "readiness_score_value", "readiness_state", "activity_subcomponent", "sleep_subcomponent", "hrv_subcomponent", "activity_state", "sleep_state", "hrv_state"],
          monthDays.map((d) => {
            const state = d.readiness >= 70 ? "HIGH" : d.readiness >= 45 ? "MEDIUM" : "LOW";
            return [d.date, d.readiness, state, Math.min(100, d.readiness + 6), Math.min(100, d.readiness + 2), Math.max(0, d.readiness - 4), state, state, state];
          }),
        ),
      );
    }

    await importFitbitData(ctx.db, ctx.stage(name));
  },
};
