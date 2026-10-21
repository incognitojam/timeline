import { describe, expect, test } from "bun:test";
import {
  buildDailySummaryParams,
  activityEvents,
  azmEvent,
  DAILY_METRIC_IMPORTS,
  dailyMetricEvent,
  fetchDailyRollups,
  mainSleepIds,
  parseHeightSamples,
  resolveProbeDailySummaryDataType,
  toLocalIso,
  weightEvent,
} from "./google-health-api";

describe("toLocalIso", () => {
  test("applies a positive offset and formats a numeric zone", () => {
    // 01:48 UTC + 1h == 02:48 local (+01:00)
    expect(toLocalIso("2026-05-30T01:48:00Z", "3600s")).toBe("2026-05-30T02:48:00.000+01:00");
  });

  test("zero / missing offset stays UTC", () => {
    expect(toLocalIso("2026-01-15T23:30:00Z", "0s")).toBe("2026-01-15T23:30:00.000+00:00");
    expect(toLocalIso("2026-01-15T23:30:00Z")).toBe("2026-01-15T23:30:00.000+00:00");
  });

  test("handles negative offsets and day rollback", () => {
    expect(toLocalIso("2026-05-30T05:00:00Z", "-18000s")).toBe("2026-05-30T00:00:00.000-05:00");
  });

  test("rejects malformed offsets shared with sample parsing", () => {
    expect(toLocalIso("2026-05-30T05:00:00Z", "3600.0s")).toBe("2026-05-30T06:00:00.000+01:00");
    expect(() => toLocalIso("2026-05-30T05:00:00Z", "3600seconds")).toThrow("utcOffset is invalid");
    expect(() => toLocalIso("2026-05-30T05:00:00Z", "3600.5s")).toThrow("utcOffset is invalid");
  });
});

describe("activity and weight mappings", () => {
  const date = { year: 2026, month: 10, day: 10 };
  const next = { year: 2026, month: 10, day: 11 };
  const rollup = (payload: Record<string, unknown>) => ({
    civilStartTime: { date }, civilEndTime: { date: next }, ...payload,
  });
  const emptyActivity = () => ({
    steps: [] as ReturnType<typeof rollup>[], distance: [] as ReturnType<typeof rollup>[],
    floors: [] as ReturnType<typeof rollup>[], "total-calories": [] as ReturnType<typeof rollup>[],
    "active-minutes": [] as ReturnType<typeof rollup>[], "sedentary-period": [] as ReturnType<typeof rollup>[],
  });

  test("joins activity by civil day and treats an absent level as zero", () => {
    const points = emptyActivity();
    points.steps.push(rollup({ steps: { countSum: "8123" } }));
    points.distance.push(rollup({ distance: { millimetersSum: "4420000" } }));
    points.floors.push(rollup({ floors: { countSum: "9" } }));
    points["total-calories"].push(rollup({ totalCalories: { kcalSum: 2125.5 } }));
    points["active-minutes"].push(rollup({ activeMinutes: { activeMinutesRollupByActivityLevel: [
      { activityLevel: "LIGHT", activeMinutesSum: "40" },
      { activityLevel: "MODERATE", activeMinutesSum: "25" },
    ] } }));
    points["sedentary-period"].push(rollup({ sedentaryPeriod: { durationSum: "38400s" } }));
    const [event] = activityEvents(points);
    expect(event.sourceId).toBe("activity:2026-10-10");
    expect(event.timestamp).toBe("2026-10-10T00:00:00Z");
    expect(event.content).toContain("Distance: 4.42 km");
    expect(event.content).toContain("Very Active: 0min");
    expect(event.rawData).toEqual({ date, steps: { countSum: "8123" }, distance: { millimetersSum: "4420000" },
      floors: { countSum: "9" }, totalCalories: { kcalSum: 2125.5 },
      activeMinutes: { activeMinutesRollupByActivityLevel: [
        { activityLevel: "LIGHT", activeMinutesSum: "40" },
        { activityLevel: "MODERATE", activeMinutesSum: "25" },
      ] }, sedentaryPeriod: { durationSum: "38400s" } });
    expect(activityEvents(emptyActivity())).toEqual([]);
  });

  test("skips absent rollup payloads and continues to a valid steps bucket", () => {
    const points = emptyActivity();
    points.steps.push(rollup({}), rollup({ steps: { countSum: "1234" } }));
    points.floors.push(rollup({}));
    expect(activityEvents(points)).toMatchObject([{ sourceId: "activity:2026-10-10", title: "1,234 steps, 0 cal" }]);
    expect(azmEvent(rollup({}))).toBeNull();
    expect(() => azmEvent(rollup({ activeZoneMinutes: null }))).toThrow("not an object");
  });

  test("rejects a present malformed payload and validates dates even when payload is absent", () => {
    const points = emptyActivity();
    points.steps.push(rollup({ steps: [] }));
    expect(() => activityEvents(points)).toThrow("not an object");
    points.steps = [rollup({ civilEndTime: { date: { ...next, day: 12 } } })];
    expect(() => activityEvents(points)).toThrow("does not cover one civil day");
  });

  test("treats an absent activity-level list as zero and rejects inherited level names", () => {
    const points = emptyActivity();
    points.steps.push(rollup({ steps: { countSum: "50" } }));
    points["active-minutes"].push(rollup({ activeMinutes: {} }));
    expect(activityEvents(points)[0].content).toContain("Light: 0min, Fairly Active: 0min, Very Active: 0min");
    points["active-minutes"] = [rollup({ activeMinutes: { activeMinutesRollupByActivityLevel: [
      { activityLevel: "toString", activeMinutesSum: "1" },
    ] } })];
    expect(() => activityEvents(points)).toThrow("activity level is invalid");
  });

  test("sums repeated activity levels in mapped content", () => {
    const points = emptyActivity();
    points.steps.push(rollup({ steps: { countSum: "9000" } }));
    points["active-minutes"].push(rollup({ activeMinutes: { activeMinutesRollupByActivityLevel: [
      { activityLevel: "MODERATE", activeMinutesSum: "20" },
      { activityLevel: "MODERATE", activeMinutesSum: "10" },
      { activityLevel: "VIGOROUS", activeMinutesSum: "7" },
      { activityLevel: "VIGOROUS", activeMinutesSum: "3" },
    ] } }));
    expect(activityEvents(points)[0].content).toContain("Fairly Active: 30min, Very Active: 10min");
  });

  test("skips dates without positive steps even when other metrics exist", () => {
    const points = emptyActivity();
    points["total-calories"].push(rollup({ totalCalories: { kcalSum: 2100 } }));
    expect(activityEvents(points)).toEqual([]);
    points.steps.push(rollup({ steps: { countSum: "0" } }));
    expect(activityEvents(points)).toEqual([]);
  });

  test("sums AZM zones and skips a genuinely empty payload", () => {
    const event = azmEvent(rollup({ activeZoneMinutes: {
      sumInFatBurnHeartZone: "12", sumInCardioHeartZone: "8", sumInPeakHeartZone: "3",
    } }));
    expect(event?.title).toBe("Active Zone Minutes: 23");
    expect(event?.rawData).toEqual(rollup({ activeZoneMinutes: {
      sumInFatBurnHeartZone: "12", sumInCardioHeartZone: "8", sumInPeakHeartZone: "3",
    } }));
    expect(azmEvent(rollup({ activeZoneMinutes: {} }))).toBeNull();
    expect(azmEvent(rollup({ activeZoneMinutes: { sumInFatBurnHeartZone: "0" } }))).toBeNull();
  });

  test("maps each weight sample with the most recent prior height for BMI", () => {
    const weight = { name: "users/me/dataTypes/weight/dataPoints/123", weight: {
      sampleTime: { physicalTime: "2026-10-10T09:30:00Z", utcOffset: "3600s" }, weightGrams: 72000,
    } };
    const oldHeight = { height: { sampleTime: { physicalTime: "2025-01-01T12:00:00Z", utcOffset: "0s" }, heightMillimeters: "1800" } };
    const futureHeight = { height: { sampleTime: { physicalTime: "2026-10-11T12:00:00Z", utcOffset: "0s" }, heightMillimeters: "1500" } };
    expect(weightEvent(weight, parseHeightSamples([futureHeight, oldHeight]))).toMatchObject({
      sourceId: "weight:123", timestamp: "2026-10-10T10:30:00.000+01:00",
      title: "Weight: 72.0 kg", content: "BMI: 22.2", rawData: weight,
    });
    expect(weightEvent(weight, parseHeightSamples([futureHeight])).content).toBe("Weight measurement");
    expect(() => parseHeightSamples([{ height: { sampleTime: { physicalTime: "2026-10-10T00:00:00Z", utcOffset: "invalid" }, heightMillimeters: 1800 } }])).toThrow("utcOffset is invalid");
  });

  test("throws on malformed activity and weight payloads", () => {
    const points = emptyActivity();
    points.steps.push(rollup({ steps: { countSum: "broken" } }));
    expect(() => activityEvents(points)).toThrow("not numeric");
    expect(() => azmEvent({ activeZoneMinutes: { sumInFatBurnHeartZone: "1" } })).toThrow("no date");
    expect(() => weightEvent({ name: "users/me/dataTypes/weight/dataPoints/123", weight: {
      sampleTime: { physicalTime: "2026-10-10T09:30:00Z", utcOffset: "0s" }, weightGrams: "bad",
    } }, [])).toThrow("not numeric");
  });
});

describe("daily rollup requests", () => {
  test("chunks at 14 days and paginates within a chunk", async () => {
    const previousFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    try {
      globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        return new Response(JSON.stringify({
          rollupDataPoints: [],
          ...(bodies.length === 1 ? { nextPageToken: "page-2" } : {}),
        }), { status: 200 });
      }, { preconnect: previousFetch.preconnect });
      expect(await fetchDailyRollups({ access_token: "synthetic", expires_at: 0 }, "steps", "2026-10-01", "2026-10-17")).toEqual([]);
      expect(bodies).toHaveLength(3);
      expect(bodies[0]).toMatchObject({
        range: { start: { date: { year: 2026, month: 10, day: 1 } }, end: { date: { year: 2026, month: 10, day: 15 } } },
        windowSizeDays: 1, pageSize: 100,
      });
      expect(bodies[1].pageToken).toBe("page-2");
      expect(bodies[2]).toMatchObject({ range: { start: { date: { year: 2026, month: 10, day: 15 } }, end: { date: { year: 2026, month: 10, day: 17 } } } });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("rejects a repeated pagination token", async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
        rollupDataPoints: [], nextPageToken: "stuck",
      }), { status: 200 }), { preconnect: previousFetch.preconnect });
      await expect(fetchDailyRollups({ access_token: "synthetic", expires_at: 0 }, "steps", "2026-10-01", "2026-10-02"))
        .rejects.toThrow("pagination did not advance");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe("daily summary request helpers", () => {
  test("defaults the probe to daily heart rate variability", () => {
    expect(resolveProbeDailySummaryDataType()).toBe("daily-heart-rate-variability");
  });

  test("accepts health metrics daily data types for the probe", () => {
    expect(resolveProbeDailySummaryDataType("daily-resting-heart-rate")).toBe(
      "daily-resting-heart-rate",
    );
  });

  test("rejects daily list data types outside the health metrics scope", () => {
    expect(() => resolveProbeDailySummaryDataType("daily-vo2-max")).toThrow(
      "This probe only requests",
    );
  });

  test("builds the daily summary list filter with live API restriction fields", () => {
    expect(
      buildDailySummaryParams("daily-heart-rate-variability", "2026-05-01", "2026-06-01"),
    ).toEqual({
      filter:
        'daily_heart_rate_variability.date >= "2026-05-01" AND daily_heart_rate_variability.date < "2026-06-01"',
      pageSize: "100",
    });
  });

  test("rejects invalid date bounds", () => {
    expect(() =>
      buildDailySummaryParams("daily-heart-rate-variability", "2026-02-31", "2026-06-01"),
    ).toThrow("Invalid date bound");
    expect(() =>
      buildDailySummaryParams("daily-heart-rate-variability", "not-a-date", "2026-06-01"),
    ).toThrow("Expected YYYY-MM-DD");
  });

  test("adds pagination params", () => {
    expect(
      buildDailySummaryParams("daily-resting-heart-rate", "2026-05-01", "2026-06-01", {
        pageSize: 250,
        pageToken: "next-page",
      }),
    ).toEqual({
      filter:
        'daily_resting_heart_rate.date >= "2026-05-01" AND daily_resting_heart_rate.date < "2026-06-01"',
      pageSize: "250",
      pageToken: "next-page",
    });
  });
});

describe("mainSleepIds", () => {
  function point(id: string, startTime: string, endTime: string, endUtcOffset = "0s") {
    return {
      name: `users/x/dataTypes/sleep/dataPoints/${id}`,
      sleep: { interval: { startTime, endTime, endUtcOffset } },
    };
  }

  test("longest period per local night is the main sleep; others are naps", () => {
    const mainNight = point("main", "2026-05-29T23:00:00Z", "2026-05-30T06:00:00Z"); // 7h, wakes 05-30
    const napNight = point("nap", "2026-05-30T13:00:00Z", "2026-05-30T14:00:00Z"); // 1h, wakes 05-30
    const lone = point("lone", "2026-05-31T23:00:00Z", "2026-06-01T06:30:00Z"); // 7.5h, wakes 06-01

    const ids = mainSleepIds([napNight, mainNight, lone]);

    expect(ids.has(mainNight.name)).toBe(true);
    expect(ids.has(lone.name)).toBe(true);
    expect(ids.has(napNight.name)).toBe(false);
  });

  test("nights are keyed by local wake time, not UTC", () => {
    // Ends 2026-05-30T00:30 UTC but with +02:00 wakes at 02:30 local on 05-30.
    const a = point("a", "2026-05-29T20:00:00Z", "2026-05-30T00:30:00Z", "7200s");
    // A shorter period the same local night.
    const b = point("b", "2026-05-30T11:00:00Z", "2026-05-30T11:45:00Z", "7200s");
    const ids = mainSleepIds([a, b]);
    expect(ids.has(a.name)).toBe(true);
    expect(ids.has(b.name)).toBe(false);
  });
});

describe("dailyMetricEvent", () => {
  function metric(eventType: string) {
    const found = DAILY_METRIC_IMPORTS.find((m) => m.eventType === eventType);
    if (!found) throw new Error(`no import for ${eventType}`);
    return found;
  }
  const date = { year: 2026, month: 9, day: 28 };
  const dataSource = { recordingMethod: "DERIVED", platform: "FITBIT" };

  test("maps daily HRV with deep-sleep RMSSD", () => {
    expect(
      dailyMetricEvent(metric("daily:hrv"), {
        name: "users/me/dataTypes/daily-heart-rate-variability/dataPoints/1",
        dataSource,
        dailyHeartRateVariability: {
          date,
          averageHeartRateVariabilityMilliseconds: 40.25,
          nonRemHeartRateBeatsPerMinute: "60",
          deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 30,
        },
      }),
    ).toEqual({
      sourceId: "hrv:2026-09-28",
      timestamp: "2026-09-28T00:00:00Z",
      title: "HRV: 40.3ms RMSSD",
      content: "Daily RMSSD: 40.3 ms, Deep sleep RMSSD: 30.0 ms",
      tags: ["google-health", "api", "hrv"],
    });
  });

  test("maps SpO2, breathing rate and string-encoded resting heart rate", () => {
    const spo2 = dailyMetricEvent(metric("daily:spo2"), {
      name: "spo2",
      dailyOxygenSaturation: {
        date,
        averagePercentage: 96,
        lowerBoundPercentage: 94,
        upperBoundPercentage: 98,
      },
    });
    expect(spo2).toMatchObject({
      sourceId: "spo2:2026-09-28",
      title: "SpO2: 96.0%",
      content: "Average: 96.0% (range: 94.0% - 98.0%)",
    });

    const breathing = dailyMetricEvent(metric("daily:breathing"), {
      name: "br",
      dailyRespiratoryRate: { date, breathsPerMinute: 16 },
    });
    expect(breathing).toMatchObject({
      sourceId: "breathing:2026-09-28",
      title: "Breathing Rate: 16.0 breaths/min",
    });

    const heart = dailyMetricEvent(metric("daily:heart"), {
      name: "rhr",
      dailyRestingHeartRate: { date, beatsPerMinute: "60" },
    });
    expect(heart).toMatchObject({ sourceId: "heart:2026-09-28", title: "Resting HR: 60 bpm" });
  });

  test("derives the skin temperature deviation from nightly and baseline values", () => {
    const event = dailyMetricEvent(metric("daily:temperature"), {
      name: "temp",
      dailySleepTemperatureDerivations: {
        date,
        nightlyTemperatureCelsius: 34.5,
        baselineTemperatureCelsius: 34.8,
      },
    });
    expect(event).toMatchObject({
      sourceId: "temperature:2026-09-28",
      title: "Temperature: -0.30°C",
    });
  });

  test("returns null for a day without a value", () => {
    expect(
      dailyMetricEvent(metric("daily:spo2"), { name: "x", dailyOxygenSaturation: { date } }),
    ).toBeNull();
  });

  test("returns null when a value is a non-finite double", () => {
    expect(
      dailyMetricEvent(metric("daily:temperature"), {
        name: "x",
        dailySleepTemperatureDerivations: {
          date,
          nightlyTemperatureCelsius: 34.5,
          baselineTemperatureCelsius: "NaN",
          relativeNightlyStddev30dCelsius: "NaN",
        },
      }),
    ).toBeNull();
  });

  test("throws on a missing payload or invalid date", () => {
    expect(() => dailyMetricEvent(metric("daily:hrv"), { name: "x" })).toThrow("no payload");
    expect(() =>
      dailyMetricEvent(metric("daily:hrv"), {
        name: "x",
        dailyHeartRateVariability: {
          date: { year: 2026, month: 2, day: 30 },
          averageHeartRateVariabilityMilliseconds: 30,
        },
      }),
    ).toThrow("Invalid date bound");
  });
});
