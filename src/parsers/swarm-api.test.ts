import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { deleteSyncState, getAppStateDb, getSyncState } from "../db/app-state";
import { getDb, initDb } from "../db/schema";
import { insertSwarmEvent, SWARM_PAGE_LIMIT, syncSwarmCheckins, type SwarmCheckin } from "./swarm-api";

const checkin: SwarmCheckin = {
  id: "checkin-123",
  createdAt: 1_704_067_200,
  timeZoneOffset: 0,
  shout: "Coffee with friends",
  venue: {
    id: "venue-456",
    name: "Example Coffee",
    location: {
      lat: 0,
      lng: 0,
      address: "1 Example Street",
      city: "Exampleton",
      country: "GB",
      formattedAddress: ["1 Example Street", "Exampleton", "GB"],
    },
    categories: [{ name: "Coffee Shop" }, { name: "Café" }],
  },
  with: [{ id: "user-1", firstName: "Alice", lastName: "Example" }],
};

describe("insertSwarmEvent", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  it("maps a check-in to a location visit and ignores a duplicate", () => {
    expect(insertSwarmEvent(db, checkin, "self-1", "swarm-test")).toBe(true);
    expect(insertSwarmEvent(db, checkin, "self-1", "swarm-test")).toBe(false);

    const row = db.query<{
      source: string;
      source_id: string;
      source_account: string;
      type: string;
      timestamp: string;
      title: string;
      content: string | null;
      latitude: number | null;
      longitude: number | null;
      location_name: string | null;
      people: string | null;
      tags: string | null;
      raw_data: string;
    }, []>(`
      SELECT source, source_id, source_account, type, timestamp, title, content,
             latitude, longitude, location_name, people, tags, raw_data
      FROM events WHERE source = 'swarm'
    `).get();

    expect(row).toEqual({
      source: "swarm",
      source_id: "checkin-123",
      source_account: "self-1",
      type: "location:visit",
      timestamp: "2024-01-01T00:00:00.000Z",
      title: "Checked in at Example Coffee",
      content: "Coffee with friends",
      latitude: 0,
      longitude: 0,
      location_name: "Example Coffee",
      people: JSON.stringify(["Alice Example"]),
      tags: JSON.stringify(["Coffee Shop", "Café"]),
      raw_data: JSON.stringify(checkin),
    });
  });

  it("skips check-ins with no usable id or createdAt", () => {
    expect(insertSwarmEvent(db, { ...checkin, id: " " }, "self-1", "swarm-test")).toBe(false);
    expect(insertSwarmEvent(db, { ...checkin, createdAt: undefined }, "self-1", "swarm-test")).toBe(false);
    expect(db.query("SELECT COUNT(*) AS count FROM events WHERE source = 'swarm'").get()).toEqual({ count: 0 });
  });

  it("inserts a venueless check-in with a fallback title", () => {
    const venuelessCheckin: SwarmCheckin = {
      id: "checkin-venueless",
      createdAt: 1_704_067_200,
    };

    expect(insertSwarmEvent(db, venuelessCheckin, "self-1", "swarm-test")).toBe(true);
    expect(db.query(`
      SELECT title, latitude, longitude, location_name
      FROM events WHERE source_id = 'checkin-venueless'
    `).get()).toEqual({
      title: "Checked in",
      latitude: null,
      longitude: null,
      location_name: null,
    });
  });

  it("inserts a check-in without optional venue or social fields", () => {
    const minimalCheckin: SwarmCheckin = {
      id: "checkin-minimal",
      createdAt: 1_704_067_200,
      venue: { name: "Example Coffee" },
    };

    expect(insertSwarmEvent(db, minimalCheckin, "self-1", "swarm-test")).toBe(true);
    expect(db.query(`
      SELECT content, latitude, longitude, location_name, people, tags
      FROM events WHERE source_id = 'checkin-minimal'
    `).get()).toEqual({
      content: null,
      latitude: null,
      longitude: null,
      location_name: "Example Coffee",
      people: null,
      tags: null,
    });
  });
});

describe("syncSwarmCheckins", () => {
  it("resumes an incomplete backfill past an all-duplicate page", async () => {
    const sourceAccount = "swarm-resume-test";
    const db = getDb();
    const appDb = getAppStateDb();
    const firstPage = Array.from({ length: SWARM_PAGE_LIMIT }, (_, index) => ({
      id: `existing-${index}`,
      createdAt: 1_704_067_200 - index,
    }));
    const olderCheckin = { id: "older-unfetched", createdAt: 1_704_066_000 };

    try {
      initDb(db);
      db.prepare("DELETE FROM events WHERE source = 'swarm' AND source_account = ?").run(sourceAccount);
      deleteSyncState(appDb, "swarm");
      for (const item of firstPage) {
        expect(insertSwarmEvent(db, item, sourceAccount, "existing-backfill")).toBe(true);
      }

      const requestedOffsets: number[] = [];
      const stats = await syncSwarmCheckins({
        db,
        sourceAccount,
        tokens: { access_token: "test-token", expires_at: 0, non_expiring: true },
        fetchPage: async (offset) => {
          requestedOffsets.push(offset);
          if (offset === 0) return firstPage;
          if (offset === SWARM_PAGE_LIMIT) return [olderCheckin];
          throw new Error(`Unexpected offset: ${offset}`);
        },
      });

      expect(requestedOffsets).toEqual([0, SWARM_PAGE_LIMIT]);
      expect(stats).toEqual({ imported: 1, skipped: SWARM_PAGE_LIMIT });
      expect(getSyncState<{ backfill_complete?: boolean }>(appDb, "swarm")).toMatchObject({
        backfill_complete: true,
      });
      expect(db.query("SELECT source_id FROM events WHERE source_id = 'older-unfetched'").get()).toEqual({
        source_id: "older-unfetched",
      });
    } finally {
      db.prepare("DELETE FROM events WHERE source = 'swarm' AND source_account = ?").run(sourceAccount);
      deleteSyncState(appDb, "swarm");
      db.close();
    }
  });
});
