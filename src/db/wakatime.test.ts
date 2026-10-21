import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "./schema";
import { wrapDatabase } from "./pool";
import { getWakaTimeStats, getWakaTimeProject } from "./wakatime";

let db: Database;

function setup() {
  db = new Database(":memory:");
  initDb(db);
}

function teardown() {
  db.close();
}

function insertSession(args: {
  sourceId: string;
  title: string;
  durationMs: number;
  timestamp: string;
  languages: Record<string, number>;
  projects?: Record<string, number>;
  branches?: string[];
}): void {
  const tags: string[] = [];
  for (const lang of Object.keys(args.languages)) tags.push(`language:${lang}`);
  for (const project of Object.keys(args.projects ?? {})) tags.push(`project:${project}`);
  for (const branch of args.branches ?? []) tags.push(`branch:${branch}`);

  db.prepare(`
    INSERT INTO events (
      source, source_id, type, timestamp, title, duration_ms, tags, raw_data
    ) VALUES ('wakatime', ?, 'code:session', ?, ?, ?, ?, ?)
  `).run(
    args.sourceId,
    args.timestamp,
    args.title,
    args.durationMs,
    JSON.stringify(tags),
    JSON.stringify({
      languages: args.languages,
      projects: args.projects ?? {},
      branches: args.branches ?? [],
    }),
  );
}

describe("getWakaTimeStats byLanguage", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("multi-language session apportions duration by heartbeat count", async () => {
    // 60-minute session: 75% TypeScript heartbeats, 25% Markdown.
    insertSession({
      sourceId: "s1",
      title: "timeline (TypeScript)",
      durationMs: 60 * 60 * 1000,
      timestamp: "2026-01-01T10:00:00Z",
      languages: { TypeScript: 75, Markdown: 25 },
      projects: { timeline: 100 },
    });

    const stats = await getWakaTimeStats(wrapDatabase(db));
    const ts = stats.byLanguage.find((l) => l.name === "TypeScript");
    const md = stats.byLanguage.find((l) => l.name === "Markdown");
    expect(ts?.duration).toBeCloseTo(60 * 60 * 1000 * 0.75, -1);
    expect(md?.duration).toBeCloseTo(60 * 60 * 1000 * 0.25, -1);
    // Sum across all languages equals total session duration.
    const total = stats.byLanguage.reduce((sum, l) => sum + l.duration, 0);
    expect(total).toBeCloseTo(60 * 60 * 1000, -1);
  });

  test("two sessions with different language mixes sum correctly", async () => {
    insertSession({
      sourceId: "s1",
      title: "a",
      durationMs: 60_000, // 1 min
      timestamp: "2026-01-01T10:00:00Z",
      languages: { TypeScript: 1 },
    });
    insertSession({
      sourceId: "s2",
      title: "b",
      durationMs: 120_000, // 2 min
      timestamp: "2026-01-02T10:00:00Z",
      languages: { TypeScript: 2, Python: 2 }, // 50/50 split
    });

    const stats = await getWakaTimeStats(wrapDatabase(db));
    const ts = stats.byLanguage.find((l) => l.name === "TypeScript");
    const py = stats.byLanguage.find((l) => l.name === "Python");
    // TS = full 60_000 from session 1 + 50% of 120_000 from session 2
    expect(ts?.duration).toBeCloseTo(60_000 + 60_000, -1);
    // Python = 50% of session 2 only
    expect(py?.duration).toBeCloseTo(60_000, -1);
  });
});

describe("getWakaTimeProject byLanguage", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("per-project view also apportions by heartbeat count", async () => {
    insertSession({
      sourceId: "s1",
      title: "timeline (TypeScript)",
      durationMs: 100_000,
      timestamp: "2026-01-01T10:00:00Z",
      languages: { TypeScript: 80, TSX: 20 },
      projects: { timeline: 100 },
    });

    const project = await getWakaTimeProject(wrapDatabase(db), "timeline");
    expect(project).toBeDefined();
    const total = project!.byLanguage.reduce((sum, l) => sum + l.duration, 0);
    expect(total).toBeCloseTo(100_000, -1);
    const ts = project!.byLanguage.find((l) => l.name === "TypeScript");
    const tsx = project!.byLanguage.find((l) => l.name === "TSX");
    expect(ts?.duration).toBeCloseTo(80_000, -1);
    expect(tsx?.duration).toBeCloseTo(20_000, -1);
  });
});
