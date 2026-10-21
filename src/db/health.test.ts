import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDayHealthStats, getHealthStats } from "./health";
import { wrapDatabase } from "./pool";
import { initDb } from "./schema";

describe("health statistics", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  test("keeps consecutive local dates across daylight saving", async () => {
    const insert = db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp, title, raw_data
      ) VALUES ('fitbit', ?, 'test', 'daily:activity', ?, 'Activity', ?)
    `);
    insert.run("activity:2024-03-30", "2024-03-30T00:00:00+00:00", '{"steps":3708}');
    insert.run("activity:2024-03-31", "2024-03-31T00:00:00+01:00", '{"steps":4079}');

    const stats = await getHealthStats(wrapDatabase(db), {
      view: "month",
      startDate: "2024-03-30",
      endDate: "2024-03-31",
    });

    expect(stats.activity).toMatchObject({
      avgSteps: 3893.5,
      totalSteps: 7787,
      daysTracked: 2,
      byDay: [
        { date: "2024-03-30", steps: 3708 },
        { date: "2024-03-31", steps: 4079 },
      ],
    });
  });

  describe("daily metrics across fitbit and google-health", () => {
    function insert(source: string, type: string, timestamp: string, raw: unknown): void {
      db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data)
        VALUES (?, ?, 'test', ?, ?, 'Metric', ?)
      `).run(source, `${type}:${timestamp}`, type, timestamp, JSON.stringify(raw));
    }

    function insertFitbitDay(date: string, time: string, v: { hr: number; hrv: number; spo2: number; br: number; temp: number }): void {
      const timestamp = `${date}T${time}`;
      insert("fitbit", "daily:heart", timestamp, { value: { restingHeartRate: v.hr } });
      insert("fitbit", "daily:hrv", timestamp, { value: { dailyRmssd: v.hrv } });
      insert("fitbit", "daily:spo2", timestamp, { value: { avg: v.spo2 } });
      insert("fitbit", "daily:breathing", timestamp, { value: { breathingRate: v.br } });
      insert("fitbit", "daily:temperature", timestamp, { value: { nightlyRelative: v.temp } });
    }

    function insertGoogleHealthDay(date: string, v: { hr: string; hrv: number; spo2: number; br: number; nightly: number; baseline: number }): void {
      const [year, month, day] = date.split("-").map(Number);
      const civil = { year, month, day };
      const timestamp = `${date}T00:00:00Z`;
      insert("google-health", "daily:heart", timestamp, { dailyRestingHeartRate: { date: civil, beatsPerMinute: v.hr } });
      insert("google-health", "daily:hrv", timestamp, {
        dailyHeartRateVariability: { date: civil, averageHeartRateVariabilityMilliseconds: v.hrv },
      });
      insert("google-health", "daily:spo2", timestamp, { dailyOxygenSaturation: { date: civil, averagePercentage: v.spo2 } });
      insert("google-health", "daily:breathing", timestamp, { dailyRespiratoryRate: { date: civil, breathsPerMinute: v.br } });
      insert("google-health", "daily:temperature", timestamp, {
        dailySleepTemperatureDerivations: {
          date: civil,
          nightlyTemperatureCelsius: v.nightly,
          baselineTemperatureCelsius: v.baseline,
        },
      });
    }

    test("prefers google-health on a date both sources cover", async () => {
      // Fitbit rows sit at the BST wake time; google-health at UTC midnight.
      insertFitbitDay("2026-07-30", "08:37:00.000+01:00", { hr: 70, hrv: 20, spo2: 90, br: 20, temp: 1 });
      insertGoogleHealthDay("2026-07-30", { hr: "57", hrv: 42, spo2: 97, br: 15, nightly: 34.5, baseline: 34.7 });

      const stats = await getDayHealthStats(wrapDatabase(db), "2026-07-30");

      expect(stats.healthMetrics.restingHR?.value).toBe(57);
      expect(stats.healthMetrics.hrv?.value).toBe(42);
      expect(stats.healthMetrics.spo2?.value).toBe(97);
      expect(stats.healthMetrics.breathingRate?.value).toBe(15);
      expect(stats.healthMetrics.skinTempVariation?.value).toBeCloseTo(-0.2);
    });

    test("keeps fitbit on dates google-health does not cover", async () => {
      insertFitbitDay("2026-07-29", "07:50:00.000+01:00", { hr: 61, hrv: 33, spo2: 95, br: 16, temp: -0.4 });
      insertGoogleHealthDay("2026-07-30", { hr: "57", hrv: 42, spo2: 97, br: 15, nightly: 34.5, baseline: 34.7 });

      const stats = await getDayHealthStats(wrapDatabase(db), "2026-07-29");

      expect(stats.healthMetrics.restingHR?.value).toBe(61);
      expect(stats.healthMetrics.hrv?.value).toBe(33);
      expect(stats.healthMetrics.skinTempVariation?.value).toBe(-0.4);
    });

    test("counts each date once in period and previous-period averages", async () => {
      insertFitbitDay("2026-07-02", "08:00:00.000+01:00", { hr: 70, hrv: 20, spo2: 90, br: 20, temp: 1 });
      insertGoogleHealthDay("2026-07-02", { hr: "60", hrv: 40, spo2: 96, br: 15, nightly: 34, baseline: 34 });
      insertFitbitDay("2026-08-02", "08:00:00.000+01:00", { hr: 70, hrv: 20, spo2: 90, br: 20, temp: 1 });
      insertGoogleHealthDay("2026-08-02", { hr: "62", hrv: 44, spo2: 97, br: 15, nightly: 34, baseline: 34 });

      const stats = await getHealthStats(wrapDatabase(db), {
        view: "month",
        startDate: "2026-08-01",
        endDate: "2026-08-31",
      });

      expect(stats.heart.byDay).toEqual([{ date: "2026-08-02", restingHR: 62 }]);
      expect(stats.hrv.avgRmssd).toBe(44);
      expect(stats.spo2.avgValue).toBe(97);
      expect(stats.previousPeriod?.heart.avgRestingHR).toBe(60);
      expect(stats.previousPeriod?.hrv.avgRmssd).toBe(40);
      expect(stats.previousPeriod?.spo2.avgValue).toBe(96);
    });
  });

  describe("activity and weight across fitbit and google-health", () => {
    let sequence = 0;
    function insert(source: string, type: string, timestamp: string, raw: unknown): void {
      db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data)
        VALUES (?, ?, 'test', ?, ?, 'Metric', ?)
      `).run(source, `${type}:${++sequence}`, type, timestamp, JSON.stringify(raw));
    }

    test("uses Google activity on an overlapping BST date and Fitbit on another date", async () => {
      insert("fitbit", "daily:activity", "2026-07-29T00:00:00+01:00", { steps: 3000, calories: 1800, minutesFairlyActive: 8, minutesVeryActive: 2, floors: 3 });
      insert("fitbit", "daily:activity", "2026-07-30T00:00:00+01:00", { steps: 4000, calories: 1900, minutesFairlyActive: 5, minutesVeryActive: 1, floors: 2 });
      insert("google-health", "daily:activity", "2026-07-30T00:00:00Z", {
        steps: { countSum: "9000" }, totalCalories: { kcalSum: 2400.52 }, floors: { countSum: "7" },
        activeMinutes: { activeMinutesRollupByActivityLevel: [
          { activityLevel: "MODERATE", activeMinutesSum: "20" },
          { activityLevel: "MODERATE", activeMinutesSum: "10" },
          { activityLevel: "VIGOROUS", activeMinutesSum: "7" },
          { activityLevel: "VIGOROUS", activeMinutesSum: "3" },
        ] },
      });

      const stats = await getHealthStats(wrapDatabase(db), { startDate: "2026-07-29", endDate: "2026-07-30" });
      expect(stats.activity).toMatchObject({ avgSteps: 6000, totalSteps: 12000, daysTracked: 2,
        byDay: [{ date: "2026-07-29", steps: 3000 }, { date: "2026-07-30", steps: 9000 }] });
      const day = await getDayHealthStats(wrapDatabase(db), "2026-07-30");
      expect(day.activity).toEqual({ steps: 9000, caloriesOut: 2401, activeMinutes: 40, floors: 7 });
      expect((await getDayHealthStats(wrapDatabase(db), "2026-07-29")).activity).toEqual({ steps: 3000, caloriesOut: 1800, activeMinutes: 10, floors: 3 });
    });

    test("keeps multiple Google weigh-ins in time order and excludes overlapping Fitbit rows", async () => {
      insert("fitbit", "daily:weight", "2026-08-01T08:00:00+01:00", { weight: 80 });
      insert("fitbit", "daily:weight", "2026-08-02T08:00:00+01:00", { weight: 90 });
      insert("google-health", "daily:weight", "2026-08-02T07:00:00.000+01:00", { weight: { weightGrams: 72000 } });
      insert("google-health", "daily:weight", "2026-08-02T18:00:00.000+01:00", { weight: { weightGrams: 73000 } });
      const stats = await getHealthStats(wrapDatabase(db), { startDate: "2026-08-01", endDate: "2026-08-02" });
      expect(stats.weight).toEqual({ latest: 73, change: -7, measurements: 3,
        byDay: [{ date: "2026-08-01", weight: 80 }, { date: "2026-08-02", weight: 72 }, { date: "2026-08-02", weight: 73 }] });
    });

    test("orders repeated-hour weight samples by instant for current and previous periods", async () => {
      insert("fitbit", "daily:weight", "2026-10-24T08:00:00+01:00", { weight: 80 });
      insert("fitbit", "daily:weight", "2026-10-25T09:00:00+00:00", { weight: 90 });
      // The later instant has an earlier wall-clock label after the clocks fall back.
      insert("google-health", "daily:weight", "2026-10-25T01:10:00.250+00:00", { weight: { weightGrams: 73000 } });
      insert("google-health", "daily:weight", "2026-10-25T01:30:00.125+01:00", { weight: { weightGrams: 72000 } });

      const current = await getHealthStats(wrapDatabase(db), { startDate: "2026-10-24", endDate: "2026-10-25" });
      expect(current.weight).toEqual({ latest: 73, change: -7, measurements: 3,
        byDay: [{ date: "2026-10-24", weight: 80 }, { date: "2026-10-25", weight: 72 }, { date: "2026-10-25", weight: 73 }] });

      const followingMonth = await getHealthStats(wrapDatabase(db), {
        view: "month", startDate: "2026-11-01", endDate: "2026-11-30",
      });
      expect(followingMonth.previousPeriod?.weight).toEqual({ latest: 73, change: -7 });
    });

    test("previous-period activity averages count each date once and weight uses Google measurements", async () => {
      insert("fitbit", "daily:activity", "2026-07-02T00:00:00+01:00", { steps: 2000 });
      insert("google-health", "daily:activity", "2026-07-02T00:00:00Z", { steps: { countSum: "6000" } });
      insert("fitbit", "daily:activity", "2026-07-03T00:00:00+01:00", { steps: 4000 });
      insert("fitbit", "daily:weight", "2026-07-02T09:00:00+01:00", { weight: 90 });
      insert("google-health", "daily:weight", "2026-07-02T10:00:00.000+01:00", { weight: { weightGrams: 70000 } });
      insert("google-health", "daily:weight", "2026-07-03T10:00:00.000+01:00", { weight: { weightGrams: 71000 } });
      const stats = await getHealthStats(wrapDatabase(db), { view: "month", startDate: "2026-08-01", endDate: "2026-08-31" });
      expect(stats.previousPeriod?.activity).toEqual({ avgSteps: 5000, totalSteps: 10000 });
      expect(stats.previousPeriod?.weight).toEqual({ latest: 71, change: 1 });
    });
  });
});
