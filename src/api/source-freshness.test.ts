import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { initDb } from "../db/schema";
import type { SourceFreshness } from "../shared/source-freshness";
import { seed } from "../testing/seed";
import { computeSourceFreshness } from "./source-freshness";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-17T12:00:00Z");

let db: Database;
let nextId = 0;

beforeEach(() => {
  db = new Database(":memory:");
  initDb(db);
});

/** An event `daysAgo` before NOW, imported `importedDaysAgo` before NOW (default: as it happened). */
function event(source: string, daysAgo: number | null, importedDaysAgo = daysAgo ?? 0) {
  const timestamp = daysAgo === null ? null : new Date(NOW - daysAgo * DAY).toISOString();
  const importedAt = new Date(NOW - importedDaysAgo * DAY).toISOString().replace("T", " ").slice(0, 19);
  db.prepare(
    `INSERT INTO events (source, source_id, type, timestamp, raw_data, imported_at)
     VALUES (?, ?, 'test', ?, '{}', ?)`,
  ).run(source, `e${nextId++}`, timestamp, importedAt);
}

function freshness(syncEnabled: Record<string, boolean> = {}): Map<string, SourceFreshness> {
  const entries = computeSourceFreshness(db, { now: NOW, syncEnabled: new Map(Object.entries(syncEnabled)) });
  return new Map(entries.map((entry) => [entry.source, entry]));
}

describe("computeSourceFreshness", () => {
  it("flags a synced source that stopped, with its quiet and normal gap", () => {
    seed(db, () => {
      for (let day = 10; day < 200; day++) event("spotify", day + 0.3);
    });
    expect(freshness({ spotify: true }).get("spotify")).toEqual({
      source: "spotify",
      status: "quiet",
      newestAt: new Date(NOW - 10.3 * DAY).toISOString(),
      feed: "sync",
      quietDays: 10,
      usualGapDays: 1,
    });
  });

  it("leaves a sparse source alone while its gap is within its usual spacing", () => {
    seed(db, () => {
      for (let day = 12; day < 400; day += 9 + (day % 4)) event("swarm", day);
    });
    const entry = freshness({ swarm: true }).get("swarm");
    expect(entry).toMatchObject({ status: "ok", quietDays: 12 });
    if (entry?.status !== "ok") throw new Error("expected ok");
    expect(entry.usualGapDays).toBeGreaterThanOrEqual(9);
  });

  it("does not check a one-off export, however recently it ended", () => {
    seed(db, () => {
      // One import 20 days ago of three years ending a month earlier.
      for (let day = 50; day < 1100; day++) event("facebook", day, 20);
      // And one whose newest event is years old, imported twice.
      for (let day = 1000; day < 1400; day++) event("skype", day, day < 1200 ? 900 : 1100);
    });
    const result = freshness();
    expect(result.get("facebook")).toMatchObject({ status: "unchecked", reason: "one-off" });
    expect(result.get("skype")).toMatchObject({ status: "unchecked", reason: "finished" });
  });

  it("allows a hand import its usual wait for the next import, then flags it", () => {
    seed(db, () => {
      // Daily events, imported in monthly batches up to 40 days ago.
      for (let day = 40; day < 300; day++) event("amex", day, Math.floor((day - 40) / 30) * 30 + 38);
    });
    const now = freshness();
    const amex = now.get("amex");
    expect(amex).toMatchObject({ status: "ok", feed: "imports", quietDays: 40 });
    if (amex?.status !== "ok") throw new Error("expected ok");
    expect(amex.usualGapDays).toBe(31);

    const later = computeSourceFreshness(db, { now: NOW + 10 * DAY, syncEnabled: new Map() });
    expect(later.find((entry) => entry.source === "amex")).toMatchObject({ status: "quiet", quietDays: 50 });
  });

  it("waits for enough history before judging a new source", () => {
    seed(db, () => {
      for (let day = 5; day < 9; day++) event("t3code", day);
    });
    expect(freshness({ t3code: true }).get("t3code")).toMatchObject({ status: "new", activeDays: 4 });
  });

  it("reports a source without timestamps as undated", () => {
    seed(db, () => {
      for (let n = 0; n < 5; n++) event("reddit", null);
    });
    expect(freshness().get("reddit")).toEqual({ source: "reddit", status: "undated" });
  });

  it("skips sources whose sync is off and sources the app writes", () => {
    seed(db, () => {
      for (let day = 100; day < 200; day++) event("trakt", day);
      for (let day = 100; day < 200; day++) event("manual", day, 0);
    });
    const result = freshness({ trakt: false });
    expect(result.get("trakt")).toMatchObject({ status: "unchecked", reason: "sync-off" });
    expect(result.has("manual")).toBe(false);
  });

  it("measures quiet from the newest past event, ignoring scheduled future ones", () => {
    seed(db, () => {
      for (let day = 1; day < 100; day++) event("google-calendar", day);
      event("google-calendar", -30, 1);
    });
    expect(freshness({ "google-calendar": true }).get("google-calendar")).toMatchObject({ status: "ok", quietDays: 1 });
  });
});
