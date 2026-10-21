import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../db/schema";
import { processGames, type SteamSyncState, type SyncContext } from "./steam-api";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  initDb(db);
  return db;
}

function createCtx(db: Database, now?: Date): SyncContext {
  return {
    db,
    appDb: new Database(":memory:"), // not used by processGames
    config: { api_key: "test", steam_id: "76561198000000000" },
    personaName: "TestPlayer",
    now: now || new Date("2024-06-15T14:00:00Z"),
  };
}

function emptyState(): SteamSyncState {
  return { games: {}, achievements: {}, backfill_complete: false };
}

function getEvents(db: Database, type?: string) {
  if (type) {
    return db.prepare("SELECT * FROM events WHERE source = 'steam' AND type = ? ORDER BY source_id").all(type) as Array<{
      source_id: string;
      type: string;
      timestamp: string | null;
      end_timestamp: string | null;
      duration_ms: number | null;
      title: string;
      content: string;
      raw_data: string;
      source_account: string;
      people: string;
      tags: string;
    }>;
  }
  return db.prepare("SELECT * FROM events WHERE source = 'steam' ORDER BY source_id").all() as Array<{
    source_id: string;
    type: string;
    timestamp: string | null;
    end_timestamp: string | null;
    duration_ms: number | null;
    title: string;
    content: string;
    raw_data: string;
    source_account: string;
    people: string;
    tags: string;
  }>;
}

describe("steam session merging", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  test("first sync creates game:added events, no sessions", () => {
    const state = emptyState();
    const ctx = createCtx(db);

    const games = [
      { appid: 100001, name: "Factory Builder", playtime_forever: 42000, rtime_last_played: 1718000000, img_icon_url: "" },
      { appid: 100002, name: "Strategy Arena", playtime_forever: 1200, rtime_last_played: 1717000000, img_icon_url: "" },
      { appid: 100003, name: "Tactical Arena 2", playtime_forever: 0, rtime_last_played: 0, img_icon_url: "" },
    ];

    const stats = processGames(ctx, state, games);

    expect(stats.gamesAdded).toBe(3);
    expect(stats.sessionsCreated).toBe(0);
    expect(stats.sessionsUpdated).toBe(0);

    const addedEvents = getEvents(db, "steam:game:added");
    expect(addedEvents).toHaveLength(3);

    const sessionEvents = getEvents(db, "steam:session");
    expect(sessionEvents).toHaveLength(0);

    // Verify baselines stored
    expect(state.games["100001"].playtime_forever).toBe(42000);
    expect(state.games["100002"].playtime_forever).toBe(1200);
    expect(state.games["100003"].playtime_forever).toBe(0);
  });

  test("second sync with playtime increase creates new session", () => {
    const state = emptyState();
    const ctx1 = createCtx(db, new Date("2024-06-15T14:00:00Z"));

    // First sync - baseline
    processGames(ctx1, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    // Second sync - 12 minutes of play
    const ctx2 = createCtx(db, new Date("2024-06-15T14:15:00Z"));
    const rtimeLastPlayed = Math.floor(new Date("2024-06-15T14:14:00Z").getTime() / 1000);

    const stats = processGames(ctx2, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6012, rtime_last_played: rtimeLastPlayed, img_icon_url: "" },
    ]);

    expect(stats.sessionsCreated).toBe(1);
    expect(stats.sessionsUpdated).toBe(0);

    const sessions = getEvents(db, "steam:session");
    expect(sessions).toHaveLength(1);

    const session = sessions[0];
    expect(session.title).toBe("Factory Builder");
    expect(session.duration_ms).toBe(12 * 60 * 1000); // 12 minutes

    // end_timestamp should be rtime_last_played
    expect(session.end_timestamp).toBe(new Date(rtimeLastPlayed * 1000).toISOString());

    // start should be end - duration
    const expectedStart = new Date(rtimeLastPlayed * 1000 - 12 * 60 * 1000).toISOString();
    expect(session.timestamp).toBe(expectedStart);

    // Verify current_session_id is set
    expect(state.games["100001"].current_session_id).toBeTruthy();
  });

  test("third sync extends existing session via merge", () => {
    const state = emptyState();
    const db = createTestDb();

    // Sync 1 - baseline
    const ctx1 = createCtx(db, new Date("2024-06-15T14:00:00Z"));
    processGames(ctx1, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    // Sync 2 - 12 minutes played
    const ctx2 = createCtx(db, new Date("2024-06-15T14:15:00Z"));
    const rtime2 = Math.floor(new Date("2024-06-15T14:14:00Z").getTime() / 1000);
    processGames(ctx2, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6012, rtime_last_played: rtime2, img_icon_url: "" },
    ]);

    // Sync 3 - 15 more minutes played (27 total)
    const ctx3 = createCtx(db, new Date("2024-06-15T14:30:00Z"));
    const rtime3 = Math.floor(new Date("2024-06-15T14:29:00Z").getTime() / 1000);
    const stats = processGames(ctx3, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6027, rtime_last_played: rtime3, img_icon_url: "" },
    ]);

    expect(stats.sessionsCreated).toBe(0);
    expect(stats.sessionsUpdated).toBe(1);

    const sessions = getEvents(db, "steam:session");
    expect(sessions).toHaveLength(1); // Same event, updated

    const session = sessions[0];
    expect(session.duration_ms).toBe(27 * 60 * 1000); // 27 minutes total
    expect(session.end_timestamp).toBe(new Date(rtime3 * 1000).toISOString());

    // start = end - 27m
    const expectedStart = new Date(rtime3 * 1000 - 27 * 60 * 1000).toISOString();
    expect(session.timestamp).toBe(expectedStart);
  });

  test("fourth sync with no change ends session", () => {
    const state = emptyState();
    const db = createTestDb();

    // Sync 1 - baseline
    const ctx1 = createCtx(db, new Date("2024-06-15T14:00:00Z"));
    processGames(ctx1, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    // Sync 2 - play starts
    const ctx2 = createCtx(db, new Date("2024-06-15T14:15:00Z"));
    const rtime2 = Math.floor(new Date("2024-06-15T14:14:00Z").getTime() / 1000);
    processGames(ctx2, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6012, rtime_last_played: rtime2, img_icon_url: "" },
    ]);

    expect(state.games["100001"].current_session_id).toBeTruthy();

    // Sync 3 - no change, session ended
    const ctx3 = createCtx(db, new Date("2024-06-15T14:30:00Z"));
    processGames(ctx3, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6012, rtime_last_played: rtime2, img_icon_url: "" },
    ]);

    expect(state.games["100001"].current_session_id).toBeUndefined();
  });

  test("fifth sync with new play creates separate session", () => {
    const state = emptyState();
    const db = createTestDb();

    // Sync 1 - baseline
    const ctx1 = createCtx(db, new Date("2024-06-15T14:00:00Z"));
    processGames(ctx1, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    // Sync 2 - play starts
    const ctx2 = createCtx(db, new Date("2024-06-15T14:15:00Z"));
    const rtime2 = Math.floor(new Date("2024-06-15T14:14:00Z").getTime() / 1000);
    processGames(ctx2, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6012, rtime_last_played: rtime2, img_icon_url: "" },
    ]);

    // Sync 3 - no change, session ends
    const ctx3 = createCtx(db, new Date("2024-06-15T14:30:00Z"));
    processGames(ctx3, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6012, rtime_last_played: rtime2, img_icon_url: "" },
    ]);

    // Sync 4 - new play starts (later in the day)
    const ctx4 = createCtx(db, new Date("2024-06-15T17:00:00Z"));
    const rtime4 = Math.floor(new Date("2024-06-15T16:59:00Z").getTime() / 1000);
    const stats = processGames(ctx4, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6027, rtime_last_played: rtime4, img_icon_url: "" },
    ]);

    expect(stats.sessionsCreated).toBe(1);

    const sessions = getEvents(db, "steam:session");
    expect(sessions).toHaveLength(2); // Two separate sessions

    // Each should have different source_ids
    const sourceIds = sessions.map((s) => s.source_id);
    expect(new Set(sourceIds).size).toBe(2);
  });

  test("two games played simultaneously get independent sessions", () => {
    const state = emptyState();
    const db = createTestDb();

    // Sync 1 - baseline for both games
    const ctx1 = createCtx(db, new Date("2024-06-15T14:00:00Z"));
    processGames(ctx1, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
      { appid: 100002, name: "Strategy Arena", playtime_forever: 1200, rtime_last_played: 1717000000, img_icon_url: "" },
    ]);

    // Sync 2 - both games played
    const ctx2 = createCtx(db, new Date("2024-06-15T14:15:00Z"));
    const rtime2 = Math.floor(new Date("2024-06-15T14:14:00Z").getTime() / 1000);
    const stats = processGames(ctx2, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6010, rtime_last_played: rtime2, img_icon_url: "" },
      { appid: 100002, name: "Strategy Arena", playtime_forever: 1220, rtime_last_played: rtime2, img_icon_url: "" },
    ]);

    expect(stats.sessionsCreated).toBe(2);

    const sessions = getEvents(db, "steam:session");
    expect(sessions).toHaveLength(2);

    const titles = sessions.map((s) => s.title).sort();
    expect(titles).toEqual(["Factory Builder", "Strategy Arena"]);
  });
});

describe("timestamp accuracy", () => {
  test("session start stays stable across merges", () => {
    const db = createTestDb();
    const state = emptyState();

    // Baseline
    const ctx1 = createCtx(db, new Date("2024-06-15T14:00:00Z"));
    processGames(ctx1, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    // First detection: 12 min played, rtime = 14:14
    const ctx2 = createCtx(db, new Date("2024-06-15T14:15:00Z"));
    const rtime2 = Math.floor(new Date("2024-06-15T14:14:00Z").getTime() / 1000);
    processGames(ctx2, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6012, rtime_last_played: rtime2, img_icon_url: "" },
    ]);

    const session1 = getEvents(db, "steam:session")[0];
    // start = 14:14 - 12m = 14:02
    expect(session1.timestamp).toBe(new Date(rtime2 * 1000 - 12 * 60 * 1000).toISOString());

    // Second observation: 15 more min (27 total), rtime = 14:29
    const ctx3 = createCtx(db, new Date("2024-06-15T14:30:00Z"));
    const rtime3 = Math.floor(new Date("2024-06-15T14:29:00Z").getTime() / 1000);
    processGames(ctx3, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6027, rtime_last_played: rtime3, img_icon_url: "" },
    ]);

    const session2 = getEvents(db, "steam:session")[0];
    // start = 14:29 - 27m = 14:02 (should be approximately the same)
    expect(session2.timestamp).toBe(new Date(rtime3 * 1000 - 27 * 60 * 1000).toISOString());
  });

  test("end_timestamp equals rtime_last_played on each update", () => {
    const db = createTestDb();
    const state = emptyState();

    // Baseline
    const ctx1 = createCtx(db, new Date("2024-06-15T14:00:00Z"));
    processGames(ctx1, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    // Play detected
    const ctx2 = createCtx(db, new Date("2024-06-15T14:15:00Z"));
    const rtime2 = Math.floor(new Date("2024-06-15T14:14:00Z").getTime() / 1000);
    processGames(ctx2, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6012, rtime_last_played: rtime2, img_icon_url: "" },
    ]);

    let session = getEvents(db, "steam:session")[0];
    expect(session.end_timestamp).toBe(new Date(rtime2 * 1000).toISOString());

    // More play
    const ctx3 = createCtx(db, new Date("2024-06-15T14:30:00Z"));
    const rtime3 = Math.floor(new Date("2024-06-15T14:29:00Z").getTime() / 1000);
    processGames(ctx3, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6027, rtime_last_played: rtime3, img_icon_url: "" },
    ]);

    session = getEvents(db, "steam:session")[0];
    expect(session.end_timestamp).toBe(new Date(rtime3 * 1000).toISOString());
  });
});

describe("new game detection", () => {
  test("initial sync with multiple games creates only game:added events", () => {
    const db = createTestDb();
    const state = emptyState();
    const ctx = createCtx(db);

    const games = Array.from({ length: 200 }, (_, i) => ({
      appid: 1000 + i,
      name: `Game ${i}`,
      playtime_forever: i * 100,
      rtime_last_played: 1718000000 - i * 3600,
      img_icon_url: "",
    }));

    const stats = processGames(ctx, state, games);

    expect(stats.gamesAdded).toBe(200);
    expect(stats.sessionsCreated).toBe(0);

    const addedEvents = getEvents(db, "steam:game:added");
    expect(addedEvents).toHaveLength(200);

    const sessionEvents = getEvents(db, "steam:session");
    expect(sessionEvents).toHaveLength(0);
  });

  test("new game on subsequent sync with playtime creates both events", () => {
    const db = createTestDb();
    const state = emptyState();

    // First sync - one existing game
    const ctx1 = createCtx(db, new Date("2024-06-15T14:00:00Z"));
    processGames(ctx1, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    // Second sync - new game appears with 30 min playtime
    const ctx2 = createCtx(db, new Date("2024-06-15T14:15:00Z"));
    const rtimeNew = Math.floor(new Date("2024-06-15T14:10:00Z").getTime() / 1000);
    const stats = processGames(ctx2, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
      { appid: 1234, name: "New Game", playtime_forever: 30, rtime_last_played: rtimeNew, img_icon_url: "" },
    ]);

    expect(stats.gamesAdded).toBe(1);
    expect(stats.sessionsCreated).toBe(1);

    const addedEvents = getEvents(db, "steam:game:added");
    expect(addedEvents).toHaveLength(2); // Initial Factory Builder + new game

    const sessionEvents = getEvents(db, "steam:session");
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0].title).toBe("New Game");
  });

  test("new game with 0 playtime creates only game:added", () => {
    const db = createTestDb();
    const state = emptyState();

    // First sync
    const ctx1 = createCtx(db, new Date("2024-06-15T14:00:00Z"));
    processGames(ctx1, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    // Second sync - new game with no playtime
    const ctx2 = createCtx(db, new Date("2024-06-15T14:15:00Z"));
    const stats = processGames(ctx2, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
      { appid: 5678, name: "Free To Play", playtime_forever: 0, rtime_last_played: 0, img_icon_url: "" },
    ]);

    expect(stats.gamesAdded).toBe(1);
    expect(stats.sessionsCreated).toBe(0);

    const sessionEvents = getEvents(db, "steam:session");
    expect(sessionEvents).toHaveLength(0);
  });
});

describe("edge cases", () => {
  test("game with 0 playtime initially, then played next sync", () => {
    const db = createTestDb();
    const state = emptyState();

    // Sync 1 - game with no playtime
    const ctx1 = createCtx(db, new Date("2024-06-15T14:00:00Z"));
    processGames(ctx1, state, [
      { appid: 100003, name: "Tactical Arena 2", playtime_forever: 0, rtime_last_played: 0, img_icon_url: "" },
    ]);

    expect(state.games["100003"].playtime_forever).toBe(0);

    // Sync 2 - now has 15 min playtime
    const ctx2 = createCtx(db, new Date("2024-06-15T14:15:00Z"));
    const rtime = Math.floor(new Date("2024-06-15T14:14:00Z").getTime() / 1000);
    const stats = processGames(ctx2, state, [
      { appid: 100003, name: "Tactical Arena 2", playtime_forever: 15, rtime_last_played: rtime, img_icon_url: "" },
    ]);

    expect(stats.sessionsCreated).toBe(1);

    const sessions = getEvents(db, "steam:session");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].duration_ms).toBe(15 * 60 * 1000);
  });

  test("playtime decrease (refund/bug) updates baseline without event", () => {
    const db = createTestDb();
    const state = emptyState();

    // Sync 1 - baseline
    const ctx1 = createCtx(db, new Date("2024-06-15T14:00:00Z"));
    processGames(ctx1, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    // Sync 2 - playtime decreased (refund?)
    const ctx2 = createCtx(db, new Date("2024-06-15T14:15:00Z"));
    const stats = processGames(ctx2, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 5900, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    expect(stats.sessionsCreated).toBe(0);
    expect(stats.sessionsUpdated).toBe(0);

    // Baseline should be updated
    expect(state.games["100001"].playtime_forever).toBe(5900);

    const sessions = getEvents(db, "steam:session");
    expect(sessions).toHaveLength(0);
  });

  test("very long session spanning many sync cycles", () => {
    const db = createTestDb();
    const state = emptyState();

    // Baseline
    const ctx1 = createCtx(db, new Date("2024-06-15T10:00:00Z"));
    processGames(ctx1, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    // Simulate 8 sync cycles of continuous play (15 min each)
    let totalDelta = 0;
    for (let i = 1; i <= 8; i++) {
      const syncTime = new Date(`2024-06-15T${10 + Math.floor(i * 15 / 60)}:${String((i * 15) % 60).padStart(2, "0")}:00Z`);
      const rtimeSeconds = Math.floor(syncTime.getTime() / 1000) - 60; // played until 1 min ago
      totalDelta += 14; // 14 minutes of play per 15 min cycle

      const ctx = createCtx(db, syncTime);
      processGames(ctx, state, [
        { appid: 100001, name: "Factory Builder", playtime_forever: 6000 + totalDelta, rtime_last_played: rtimeSeconds, img_icon_url: "" },
      ]);
    }

    // Should be a single session event (merged over time)
    const sessions = getEvents(db, "steam:session");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].duration_ms).toBe(totalDelta * 60 * 1000);
  });

  test("source_account uses persona name", () => {
    const db = createTestDb();
    const state = emptyState();
    const ctx = createCtx(db);

    processGames(ctx, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    const events = getEvents(db);
    expect(events[0].source_account).toBe("TestPlayer");
  });

  test("people contains steam identity", () => {
    const db = createTestDb();
    const state = emptyState();
    const ctx = createCtx(db);

    processGames(ctx, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    const events = getEvents(db);
    const people = JSON.parse(events[0].people);
    expect(people).toEqual(["steam:76561198000000000"]);
  });

  test("tags contain appid", () => {
    const db = createTestDb();
    const state = emptyState();
    const ctx = createCtx(db);

    processGames(ctx, state, [
      { appid: 100001, name: "Factory Builder", playtime_forever: 6000, rtime_last_played: 1718000000, img_icon_url: "" },
    ]);

    const events = getEvents(db);
    const tags = JSON.parse(events[0].tags);
    expect(tags).toContain("appid:100001");
  });
});
