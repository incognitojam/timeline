import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../../../db/schema";
import { createTokenManager } from "../../../lib/oauth-tokens";
import { googleHealthSyncSource } from "./sync";

const configPath = join(homedir(), ".config/timeline/google-health.json");
const tokens = createTokenManager("google-health");
const originalFetch = globalThis.fetch;
const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
];

/** Dates inside the sync's default 30-day window, oldest first. */
function recentDates(count: number): string[] {
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(today - (count + 2 - i) * 86_400_000).toISOString().slice(0, 10));
}

function civil(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** What the fake API currently returns, editable between syncs. */
interface FakeHealthData {
  sleep: unknown[];
  daily: Record<string, unknown[]>;
  rollups: Record<string, { date: string; payload: Record<string, unknown> }[]>;
  weight: unknown[];
  height: unknown[];
}

function fakeData(dates: string[]): FakeHealthData {
  return {
    sleep: dates.map((date, i) => ({
      name: `users/me/dataTypes/sleep/dataPoints/${1000 + i}`,
      sleep: {
        interval: {
          startTime: `${date}T23:00:00Z`,
          endTime: `${nextDay(date)}T07:00:00Z`,
          startUtcOffset: "3600s",
          endUtcOffset: "3600s",
        },
        summary: {
          minutesInSleepPeriod: "480",
          minutesAsleep: "440",
          stagesSummary: [
            { type: "DEEP", minutes: "80", count: "4" },
            { type: "LIGHT", minutes: "250", count: "20" },
            { type: "REM", minutes: "110", count: "5" },
            { type: "AWAKE", minutes: "40", count: "12" },
          ],
        },
      },
    })),
    daily: {
      "daily-resting-heart-rate": dates.map((date, i) => ({
        name: `users/me/dataTypes/daily-resting-heart-rate/dataPoints/${2000 + i}`,
        dailyRestingHeartRate: { date: civil(date), beatsPerMinute: String(58 + i) },
      })),
      "daily-respiratory-rate": dates.map((date, i) => ({
        name: `users/me/dataTypes/daily-respiratory-rate/dataPoints/${3000 + i}`,
        dailyRespiratoryRate: { date: civil(date), breathsPerMinute: 14.2 + i / 10 },
      })),
    },
    rollups: {
      steps: dates.map((date, i) => ({ date, payload: { steps: { countSum: String(8000 + i * 100) } } })),
      "total-calories": dates.map((date) => ({ date, payload: { totalCalories: { kcalSum: 2100.5 } } })),
      "active-zone-minutes": dates.map((date) => ({
        date,
        payload: { activeZoneMinutes: { sumInFatBurnHeartZone: "20", sumInCardioHeartZone: "5" } },
      })),
    },
    weight: [weightPoint(dates[0], 4000, 72500)],
    height: [{
      height: { sampleTime: { physicalTime: "2020-01-01T09:00:00Z", utcOffset: "0s" }, heightMillimeters: "1780" },
    }],
  };
}

function weightPoint(date: string, id: number, grams: number) {
  return {
    name: `users/me/dataTypes/weight/dataPoints/${id}`,
    weight: { sampleTime: { physicalTime: `${date}T07:30:00Z`, utcOffset: "3600s" }, weightGrams: grams },
  };
}

function serve(data: FakeHealthData) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== "https://health.googleapis.com") throw new Error(`Unexpected request: ${url}`);
    const rollUp = /^\/v4\/users\/me\/dataTypes\/([a-z-]+)\/dataPoints:dailyRollUp$/.exec(url.pathname);
    if (rollUp && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        range: { start: { date: { year: number; month: number; day: number } }; end: { date: { year: number; month: number; day: number } } };
      };
      const iso = (d: { year: number; month: number; day: number }) =>
        `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
      const [start, end] = [iso(body.range.start.date), iso(body.range.end.date)];
      const rollupDataPoints = (data.rollups[rollUp[1]] ?? [])
        .filter((point) => point.date >= start && point.date < end)
        .map((point) => ({
          civilStartTime: { date: civil(point.date) },
          civilEndTime: { date: civil(nextDay(point.date)) },
          ...point.payload,
        }));
      return Response.json({ rollupDataPoints });
    }
    const list = /^\/v4\/users\/me\/dataTypes\/([a-z-]+)\/dataPoints$/.exec(url.pathname);
    if (list) {
      const type = list[1];
      const dataPoints = type === "sleep" ? data.sleep
        : type === "weight" ? data.weight
        : type === "height" ? data.height
        : data.daily[type] ?? [];
      return Response.json({ dataPoints });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
}

async function sync() {
  const result = await googleHealthSyncSource.sync({ verbose: false, config: { sources: {} } });
  if (!result.success) throw new Error(result.error);
  return result;
}

function snapshot() {
  const db = getDb();
  try {
    return {
      rows: db.query("SELECT * FROM events WHERE source = 'google-health' ORDER BY id").all(),
      fts: db.query("SELECT rowid, title, content FROM events_fts ORDER BY rowid").all(),
      nextId: db.query("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get(),
    };
  } finally {
    db.close();
  }
}

function eventBySourceId(sourceId: string) {
  const db = getDb();
  try {
    return db.query("SELECT id, title, raw_data, import_batch FROM events WHERE source = 'google-health' AND source_id = ?")
      .get(sourceId) as { id: number; title: string; raw_data: string; import_batch: string } | null;
  } finally {
    db.close();
  }
}

function assertFtsConsistent() {
  const db = getDb();
  try {
    db.exec("INSERT INTO events_fts(events_fts) VALUES ('integrity-check')");
  } finally {
    db.close();
  }
}

describe("google-health sync writes", () => {
  const dates = recentDates(3);
  let data: FakeHealthData;

  beforeAll(() => {
    const db = getDb();
    initDb(db);
    db.close();
  });

  beforeEach(() => {
    mkdirSync(join(homedir(), ".config/timeline"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ client_id: "test-client", client_secret: "test-secret" }));
    tokens.save({
      access_token: "test-access",
      refresh_token: "test-refresh",
      expires_at: Date.now() + 3_600_000,
      scope: SCOPES.join(" "),
      account_name: "alice",
    } as Parameters<typeof tokens.save>[0]);
    const db = getDb();
    db.exec("DELETE FROM events WHERE source = 'google-health'");
    db.close();
    data = fakeData(dates);
    serve(data);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    tokens.clear();
    rmSync(configPath, { force: true });
  });

  test("a second sync over unchanged data writes nothing", async () => {
    const first = await sync();
    // 3 sleep + 6 daily summaries + 3 activity + 3 AZM + 1 weight
    expect(first).toMatchObject({ eventsAdded: 16, eventsUpdated: 0, metadata: { unchanged: 0 } });
    const before = snapshot();

    const second = await sync();
    expect(second).toMatchObject({ eventsAdded: 0, eventsUpdated: 0, metadata: { unchanged: 16 } });
    expect(snapshot()).toEqual(before);
    assertFtsConsistent();
  });

  test("a revised record is updated in place and keeps its id", async () => {
    await sync();
    const restingHr = `heart:${dates[1]}`;
    const before = eventBySourceId(restingHr);
    if (!before) throw new Error("resting heart rate event missing");

    (data.daily["daily-resting-heart-rate"][1] as { dailyRestingHeartRate: { beatsPerMinute: string } })
      .dailyRestingHeartRate.beatsPerMinute = "61";
    const result = await sync();

    expect(result).toMatchObject({ eventsAdded: 0, eventsUpdated: 1, metadata: { unchanged: 15 } });
    const after = eventBySourceId(restingHr);
    expect(after?.id).toBe(before.id);
    expect(after?.title).toBe("Resting HR: 61 bpm");
    expect(after?.raw_data).toContain('"beatsPerMinute":"61"');
    expect(after?.import_batch).not.toBe(before.import_batch);

    const db = getDb();
    try {
      const match = (term: string) => db.query("SELECT rowid FROM events_fts WHERE events_fts MATCH ?").all(term);
      expect(match('"Resting HR 61"')).toEqual([{ rowid: before.id }]);
      expect(match('"Resting HR 59"')).toEqual([]);
    } finally {
      db.close();
    }
    assertFtsConsistent();
  });

  test("a new record is added and existing rows are left alone", async () => {
    await sync();
    const before = snapshot();

    data.weight.push(weightPoint(dates[2], 4001, 72100));
    const result = await sync();

    expect(result).toMatchObject({ eventsAdded: 1, eventsUpdated: 0, metadata: { unchanged: 16 } });
    const after = snapshot();
    expect(after.rows.slice(0, before.rows.length)).toEqual(before.rows);
    expect(after.rows).toHaveLength(before.rows.length + 1);
    expect(eventBySourceId("weight:4001")?.title).toBe("Weight: 72.1 kg");
  });

  test("a record that disappears upstream stays stored", async () => {
    await sync();
    const before = snapshot();

    data.sleep.pop();
    const result = await sync();

    expect(result).toMatchObject({ eventsAdded: 0, eventsUpdated: 0, metadata: { unchanged: 15 } });
    expect(snapshot()).toEqual(before);
  });
});
