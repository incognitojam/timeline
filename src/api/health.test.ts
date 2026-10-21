/**
 * Health API Tests
 *
 * Tests for health stats, biomarker results, and day health endpoints.
 * All dates and measurements are synthetic fixtures.
 * Run with: bun test src/api/health.test.ts
 */

// Set test mode before importing to prevent server auto-start
process.env.NODE_ENV = "test";

import { describe, test, expect, beforeAll } from "bun:test";
import { app } from "./index";
import { getDb } from "../db/schema";

describe("Health API Tests", () => {
  describe("Health Stats", () => {
    beforeAll(() => {
      const db = getDb();
      const insertEvent = db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data)
        VALUES (?, ?, 'test', ?, ?, ?, ?)
      `);

      // Sleep event for 2024-01-15
      insertEvent.run(
        "fitbit",
        "fitbit-test-sleep-1",
        "sleep",
        "2024-01-15T06:30:00Z",
        "Sleep: 8h 0m",
        JSON.stringify({
          dateOfSleep: "2024-01-15",
          duration: 28800000,
          efficiency: 92,
          levels: {
            summary: {
              deep: { minutes: 90 },
              light: { minutes: 210 },
              rem: { minutes: 100 },
            },
          },
          minutesToFallAsleep: 8,
        })
      );

      // Heart rate event for 2024-01-15
      insertEvent.run(
        "fitbit",
        "fitbit-test-heart-1",
        "daily:heart",
        "2024-01-15T00:00:00Z",
        "Heart Rate",
        JSON.stringify({ value: { restingHeartRate: 62 } })
      );

      // HRV event for 2024-01-15
      insertEvent.run(
        "fitbit",
        "fitbit-test-hrv-1",
        "daily:hrv",
        "2024-01-15T00:00:00Z",
        "HRV",
        JSON.stringify({ value: { dailyRmssd: 42.5 } })
      );

      // Activity event for 2024-01-15
      insertEvent.run(
        "fitbit",
        "fitbit-test-activity-1",
        "daily:activity",
        "2024-01-15T00:00:00Z",
        "Activity",
        JSON.stringify({ steps: 8500, calories: 2200, minutesFairlyActive: 20, minutesVeryActive: 10 })
      );

      // A recorded zero remains a tracked day. It is distinct from a date with
      // no activity row, which represents missing coverage.
      insertEvent.run(
        "fitbit",
        "fitbit-test-activity-zero",
        "daily:activity",
        "2024-02-01T00:00:00Z",
        "Activity",
        JSON.stringify({ steps: 0, calories: 1800, minutesFairlyActive: 0, minutesVeryActive: 0 })
      );

      // SpO2 event for 2024-01-15
      insertEvent.run(
        "fitbit",
        "fitbit-test-spo2-1",
        "daily:spo2",
        "2024-01-15T00:00:00Z",
        "SpO2",
        JSON.stringify({ value: { avg: 97.2 } })
      );

      // Multiple weight measurements in one month remain distinct even though
      // the year chart aggregates them into a single monthly point.
      insertEvent.run(
        "fitbit",
        "fitbit-test-weight-1",
        "daily:weight",
        "2024-01-10T08:00:00Z",
        "Weight",
        JSON.stringify({ weight: 72.5, bmi: 22.4 })
      );
      insertEvent.run(
        "fitbit",
        "fitbit-test-weight-2",
        "daily:weight",
        "2024-01-20T08:00:00Z",
        "Weight",
        JSON.stringify({ weight: 72 })
      );

      db.close();
    });

    test("GET /api/health/stats returns the correct structure", async () => {
      const res = await app.request(
        "/api/health/stats?view=week&mode=calendar&anchor=2024-01-15",
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("dateRange");
      expect(json.dateRange).toHaveProperty("start");
      expect(json.dateRange).toHaveProperty("end");
      expect(json).toHaveProperty("sleep");
      expect(json).toHaveProperty("heart");
      expect(json).toHaveProperty("hrv");
      expect(json).toHaveProperty("activity");
      expect(json).toHaveProperty("spo2");
      expect(json).toHaveProperty("weight");
    });

    test("GET /api/health/stats returns seeded values", async () => {
      const res = await app.request(
        "/api/health/stats?view=week&mode=calendar&anchor=2024-01-15",
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      // Sleep
      expect(json.sleep.byDay.length).toBe(1);
      expect(json.sleep.avgDuration).toBe(28800000);
      expect(json.sleep.avgEfficiency).toBe(92);

      // Heart
      expect(json.heart.avgRestingHR).toBe(62);
      expect(json.heart.byDay.length).toBe(1);

      // HRV
      expect(json.hrv.avgRmssd).toBe(42.5);

      // Activity
      expect(json.activity.avgSteps).toBe(8500);
      expect(json.activity.totalSteps).toBe(8500);

      // SpO2
      expect(json.spo2.avgValue).toBe(97.2);
    });

    test("GET /api/health/stats returns stats for a calendar month", async () => {
      const res = await app.request(
        "/api/health/stats?view=month&mode=calendar&anchor=2024-01-01",
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.dateRange.start).toBe("2024-01-01");
      expect(json.dateRange.end).toBe("2024-01-31");
      expect(json.heart.avgRestingHR).toBe(62);
    });

    test("a recorded zero counts as a tracked activity day", async () => {
      const res = await app.request(
        "/api/health/stats?view=month&mode=calendar&anchor=2024-02-01",
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.activity).toMatchObject({
        avgSteps: 0,
        totalSteps: 0,
        daysTracked: 1,
        byDay: [{ date: "2024-02-01", steps: 0 }],
      });
    });

    test("GET /api/health/stats returns calendar week dates", async () => {
      const res = await app.request(
        "/api/health/stats?view=week&mode=calendar&anchor=2026-06-29",
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.dateRange.start).toBe("2026-06-29");
      expect(json.dateRange.end).toBe("2026-07-05");
    });

    test("GET /api/health/stats returns calendar month dates", async () => {
      const res = await app.request(
        "/api/health/stats?view=month&mode=calendar&anchor=2026-07-01",
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.dateRange.start).toBe("2026-07-01");
      expect(json.dateRange.end).toBe("2026-07-31");
    });

    test("GET /api/health/stats returns stats for the calendar year", async () => {
      const res = await app.request(
        "/api/health/stats?view=year&mode=calendar&anchor=2024-01-01",
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.dateRange.start).toBe("2024-01-01");
      expect(json.dateRange.end).toBe("2024-12-31");
      expect(json.weight.byDay).toHaveLength(1);
      expect(json.weight.measurements).toBe(2);
      expect(json.weight.byDay[0]).toEqual({ date: "2024-01-15", weight: 72.25 });
      expect(json.weight).not.toHaveProperty("latestBmi");
    });

    test("GET /api/health/stats accepts a canonical recent window", async () => {
      const res = await app.request(
        "/api/health/stats?view=month&mode=recent&anchor=2024-01-30",
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.dateRange).toEqual({ start: "2024-01-01", end: "2024-01-30" });
      expect(json.heart.avgRestingHR).toBe(62);
    });

    test("GET /api/health/stats accepts canonical day and quarter windows", async () => {
      const day = await app.request(
        "/api/health/stats?view=day&mode=recent&anchor=2024-01-17",
      );
      expect(day.status).toBe(200);
      expect((await day.json()).dateRange).toEqual({
        start: "2024-01-17",
        end: "2024-01-17",
      });

      const quarter = await app.request(
        "/api/health/stats?view=quarter&mode=calendar&anchor=2024-02-12",
      );
      expect(quarter.status).toBe(200);
      expect((await quarter.json()).dateRange).toEqual({
        start: "2024-01-01",
        end: "2024-03-31",
      });
    });

    test("legacy period params are not supported", async () => {
      const res = await app.request("/api/health/stats?month=2024-01");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Missing or invalid health window. Use ?view=day|week|month|quarter|year&mode=recent|calendar&anchor=YYYY-MM-DD",
      });
    });

    test("GET /api/health/stats without a window returns 400", async () => {
      const res = await app.request("/api/health/stats");
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toHaveProperty("error");
    });

    test("GET /api/health/stats with an invalid view returns 400", async () => {
      const res = await app.request(
        "/api/health/stats?view=decade&mode=calendar&anchor=2026-01-01",
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toHaveProperty("error");
    });

    test("GET /api/health/stats with an invalid mode returns 400", async () => {
      const res = await app.request(
        "/api/health/stats?view=week&mode=rolling&anchor=2026-01-01",
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toHaveProperty("error");
    });

    test("GET /api/health/stats with an invalid anchor returns 400", async () => {
      const res = await app.request(
        "/api/health/stats?view=month&mode=calendar&anchor=2026-02-30",
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toHaveProperty("error");
    });

    test("GET /api/health/stats returns zero averages for an empty period", async () => {
      const res = await app.request(
        "/api/health/stats?view=week&mode=calendar&anchor=2019-12-30",
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.sleep.avgDuration).toBe(0);
      expect(json.sleep.avgEfficiency).toBe(0);
      expect(json.heart.avgRestingHR).toBe(0);
      expect(json.hrv.avgRmssd).toBe(0);
      expect(json.activity.avgSteps).toBe(0);
      expect(json.spo2.avgValue).toBe(0);
    });
  });

  // Fitbit rows read duration/efficiency/date from raw_data.
  const insertFitbitSleep = (
    sourceId: string,
    type: string,
    timestamp: string,
    rawData: string,
  ) => {
    const db = getDb();
    db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data)
      VALUES ('fitbit', ?, 'test', ?, ?, 'Sleep', ?)
    `).run(sourceId, type, timestamp, rawData);
    db.close();
  };

  // Google Health rows derive efficiency/stages from raw_data and key on
  // the date portion of end_timestamp; duration comes from duration_ms.
  const insertGhSleep = (
    sourceId: string,
    type: string,
    timestamp: string,
    endTimestamp: string,
    durationMs: number,
    rawData: string,
  ) => {
    const db = getDb();
    db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, end_timestamp, duration_ms, title, raw_data)
      VALUES ('google-health', ?, 'test', ?, ?, ?, ?, 'Sleep', ?)
    `).run(sourceId, type, timestamp, endTimestamp, durationMs, rawData);
    db.close();
  };

  const ghSleep = (asleep: number, inBed: number) =>
    JSON.stringify({
      sleep: {
        summary: {
          minutesAsleep: String(asleep),
          minutesInSleepPeriod: String(inBed),
          minutesToFallAsleep: "0",
          stagesSummary: [
            { type: "DEEP", minutes: "80", count: "5" },
            { type: "LIGHT", minutes: "240", count: "12" },
            { type: "REM", minutes: "100", count: "6" },
            { type: "AWAKE", minutes: "10", count: "2" },
          ],
        },
      },
    });

  describe("Sleep Sources & Naps", () => {
    beforeAll(() => {

      // 2023-03-10: BOTH sources record the same night. Fitbit efficiency 80,
      // google-health efficiency 480/500 = 96. Precedence → google-health.
      insertFitbitSleep(
        "gh-prec-fitbit",
        "sleep",
        "2023-03-10T00:30:00Z",
        JSON.stringify({ dateOfSleep: "2023-03-10", duration: 28800000, efficiency: 80 }),
      );
      insertGhSleep(
        "gh-prec-gh",
        "sleep",
        "2023-03-09T23:00:00.000+00:00",
        "2023-03-10T07:20:00.000+00:00",
        30000000,
        ghSleep(480, 500),
      );

      // 2023-03-11: fitbit-only night stays.
      insertFitbitSleep(
        "gh-fitbit-only",
        "sleep",
        "2023-03-11T00:30:00Z",
        JSON.stringify({ dateOfSleep: "2023-03-11", duration: 27000000, efficiency: 88 }),
      );

      // 2023-03-12: google-health night (400/500 = 80%) + one real nap (60m)
      // and one sub-threshold nap (10m, dropped).
      insertGhSleep(
        "gh-night",
        "sleep",
        "2023-03-11T23:30:00.000+00:00",
        "2023-03-12T07:00:00.000+00:00",
        27000000,
        ghSleep(400, 500),
      );
      insertGhSleep(
        "gh-nap-real",
        "sleep:nap",
        "2023-03-12T13:00:00.000+00:00",
        "2023-03-12T14:00:00.000+00:00",
        3600000,
        ghSleep(60, 60),
      );
      insertGhSleep(
        "gh-nap-tiny",
        "sleep:nap",
        "2023-03-12T16:00:00.000+00:00",
        "2023-03-12T16:10:00.000+00:00",
        600000,
        ghSleep(10, 10),
      );
    });

    test("google-health takes per-date precedence over fitbit; fitbit-only dates remain", async () => {
      const res = await app.request(
        "/api/health/stats?view=month&mode=calendar&anchor=2023-03-01",
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      const byDate = new Map<string, { efficiency: number }>(
        json.sleep.byDay.map((d: { date: string; efficiency: number }) => [d.date, d]),
      );
      // One main-sleep row per date, never mixing sources.
      expect(json.sleep.byDay.length).toBe(3);
      // 2023-03-10: google-health efficiency (96) wins over fitbit (80).
      expect(byDate.get("2023-03-10")?.efficiency).toBe(96);
      // 2023-03-11: fitbit-only night preserved.
      expect(byDate.get("2023-03-11")?.efficiency).toBe(88);
      // 2023-03-12: google-health night, 400/500 = 80%.
      expect(byDate.get("2023-03-12")?.efficiency).toBe(80);
    });

    test("naps are included above the threshold and dropped below it", async () => {
      const res = await app.request(
        "/api/health/stats?view=month&mode=calendar&anchor=2023-03-01",
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(Array.isArray(json.sleep.naps)).toBe(true);
      // Only the 60m nap survives; the 10m nap is below MIN_NAP_DURATION_MS.
      expect(json.sleep.naps.length).toBe(1);
      expect(json.sleep.naps[0].date).toBe("2023-03-12");
      expect(json.sleep.naps[0].duration).toBe(3600000);
      expect(json.sleep.naps[0].startTime).toBe("2023-03-12T13:00:00.000+00:00");
      expect(json.sleep.naps[0].endTime).toBe("2023-03-12T14:00:00.000+00:00");
    });
  });

  describe("Sleep Precedence Edge Cases & Year View", () => {
    beforeAll(() => {
      // 2023-04-10: fitbit records the night, google-health only a nap.
      // Any google-health row on a date suppresses fitbit for that date,
      // so this date ends up with a nap but no main sleep.
      insertFitbitSleep(
        "gh-edge-fitbit-night",
        "sleep",
        "2023-04-10T00:30:00Z",
        JSON.stringify({ dateOfSleep: "2023-04-10", duration: 28800000, efficiency: 85 }),
      );
      insertGhSleep(
        "gh-edge-nap-only",
        "sleep:nap",
        "2023-04-10T13:00:00.000+00:00",
        "2023-04-10T14:30:00.000+00:00",
        5400000,
        ghSleep(90, 90),
      );
    });

    test("a nap-only google-health date suppresses fitbit's main sleep", async () => {
      const res = await app.request(
        "/api/health/stats?view=month&mode=calendar&anchor=2023-04-01",
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      // Pins current precedence semantics: google-health presence is judged
      // per date across both sleep types, so the fitbit night is discarded
      // and the date has no main sleep — change this only deliberately.
      expect(json.sleep.byDay.length).toBe(0);
      expect(json.sleep.naps.length).toBe(1);
      expect(json.sleep.naps[0].date).toBe("2023-04-10");
    });

    test("year view averages naps per tracked night to match byDay units", async () => {
      const res = await app.request(
        "/api/health/stats?view=year&mode=calendar&anchor=2023-01-01",
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      const napByDate = new Map<string, { duration: number }>(
        json.sleep.naps.map((n: { date: string; duration: number }) => [n.date, n]),
      );
      // March: 60m of naps over 3 tracked nights → 20m average, keyed
      // mid-month like aggregateToMonthly's byDay entries.
      expect(napByDate.get("2023-03-15")?.duration).toBe(1200000);
      // April has naps but zero tracked nights; falls back to averaging
      // over distinct nap dates (1) rather than dividing by zero.
      expect(napByDate.get("2023-04-15")?.duration).toBe(5400000);
    });
  });

  describe("Biomarker Results", () => {
    beforeAll(() => {
      const db = getDb();
      const insertEvent = db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, tags, raw_data)
        VALUES (?, ?, 'test', 'thriva:biomarker', ?, ?, ?, ?)
      `);

      // Vitamin D result 1 (optimal)
      insertEvent.run(
        "thriva",
        "thriva-test-vitd-1",
        "2024-01-15T00:00:00Z",
        "Vitamin D: 80 nmol/L ++",
        JSON.stringify(["vitamins", "vitamin-d"]),
        JSON.stringify({
          attributes: {
            value: 80,
            unit: "nmol/L",
            reference_ranges: [
              { name: "Optimal", level: "optimal", lower_bound: 50, upper_bound: null },
              { name: "Normal", level: "normal", lower_bound: 25, upper_bound: 50 },
              { name: "Low", level: "abnormal", lower_bound: null, upper_bound: 25 },
            ],
          },
          relationships: { biomarker: { data: { id: "vitamin-d" } } },
        })
      );

      // Vitamin D result 2 (older date)
      insertEvent.run(
        "thriva",
        "thriva-test-vitd-2",
        "2023-07-10T00:00:00Z",
        "Vitamin D: 30 nmol/L",
        JSON.stringify(["vitamins", "vitamin-d"]),
        JSON.stringify({
          attributes: {
            value: 30,
            unit: "nmol/L",
            reference_ranges: [
              { name: "Optimal", level: "optimal", lower_bound: 50, upper_bound: null },
              { name: "Normal", level: "normal", lower_bound: 25, upper_bound: 50 },
              { name: "Low", level: "abnormal", lower_bound: null, upper_bound: 25 },
            ],
          },
          relationships: { biomarker: { data: { id: "vitamin-d" } } },
        })
      );

      // Total Cholesterol result
      insertEvent.run(
        "thriva",
        "thriva-test-chol-1",
        "2024-01-15T00:00:00Z",
        "Total Cholesterol: 4.0 mmol/L",
        JSON.stringify(["lipids", "total-cholesterol"]),
        JSON.stringify({
          attributes: {
            value: 4.0,
            unit: "mmol/L",
            reference_ranges: [
              { name: "Normal", level: "normal", lower_bound: null, upper_bound: 5.0 },
              { name: "High", level: "abnormal", lower_bound: 5.0, upper_bound: null },
            ],
          },
          relationships: { biomarker: { data: { id: "total-cholesterol" } } },
        })
      );

      db.close();
    });

    test("GET /api/health/biomarkers returns 200 with biomarkers array", async () => {
      const res = await app.request("/api/health/biomarkers");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("biomarkers");
      expect(Array.isArray(json.biomarkers)).toBe(true);
    });

    test("GET /api/health/biomarkers returns correctly grouped biomarker data", async () => {
      const res = await app.request("/api/health/biomarkers");
      expect(res.status).toBe(200);
      const json = await res.json();

      // Should be sorted alphabetically by name
      const names = json.biomarkers.map((b: { name: string }) => b.name);
      expect(names).toContain("Total Cholesterol");
      expect(names).toContain("Vitamin D");

      // Vitamin D should have 2 results
      const vitD = json.biomarkers.find((b: { id: string }) => b.id === "vitamin-d");
      expect(vitD).toBeDefined();
      expect(vitD.name).toBe("Vitamin D");
      expect(vitD.category).toBe("vitamins");
      expect(vitD.results).toHaveLength(2);
      // Results sorted chronologically (oldest first)
      expect(vitD.results[0].value).toBe(30);
      expect(vitD.results[0].level).toBe("normal");
      expect(vitD.results[1].value).toBe(80);
      expect(vitD.results[1].unit).toBe("nmol/L");
      expect(vitD.results[1].level).toBe("optimal");
      expect(vitD.results[1].referenceRanges.length).toBeGreaterThanOrEqual(1);

      // Total Cholesterol should have 1 result
      const chol = json.biomarkers.find((b: { id: string }) => b.id === "total-cholesterol");
      expect(chol).toBeDefined();
      expect(chol.name).toBe("Total Cholesterol");
      expect(chol.category).toBe("lipids");
      expect(chol.results).toHaveLength(1);
      expect(chol.results[0].value).toBe(4.0);
      expect(chol.results[0].unit).toBe("mmol/L");
      expect(chol.results[0].level).toBe("normal");
    });
  });

  describe("Day Health Stats", () => {
    test("GET /api/day/:date/health returns health stats structure", async () => {
      const res = await app.request("/api/day/2024-01-15/health");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("date");
      expect(json.date).toBe("2024-01-15");
      expect(json).toHaveProperty("hasData");
      expect(typeof json.hasData).toBe("boolean");
      expect(json).toHaveProperty("healthMetrics");
      expect(typeof json.healthMetrics).toBe("object");
      expect(json).toHaveProperty("outOfRangeCount");
      expect(typeof json.outOfRangeCount).toBe("number");
      expect(json).toHaveProperty("totalMetricCount");
      expect(typeof json.totalMetricCount).toBe("number");
    });

    test("GET /api/day/:date/health returns empty for future date", async () => {
      const res = await app.request("/api/day/2099-12-31/health");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.hasData).toBe(false);
      expect(json.activity).toBeUndefined();
      expect(json.sleep).toBeUndefined();
      expect(Object.keys(json.healthMetrics)).toHaveLength(0);
    });
  });
});
