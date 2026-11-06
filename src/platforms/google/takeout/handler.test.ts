import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "worker_threads";
import type { InboxSourceConfig } from "../../../inbox/config";
import type { ProcessResult } from "../../../inbox/process";
import type { InboxWorkerData } from "../../../testing/inbox-worker";

type TakeoutFiles = Record<string, string>;

const INBOX_WORKER = resolve(import.meta.dir, "../../../testing/inbox-worker.ts");
const FIT_FILE = "Takeout/Fit/All Data/derived_com.google.activity.segment_com.google.android.gms_merge.json";

const profile = (email: string): TakeoutFiles => ({
  "Takeout/Profile/Profile.json": JSON.stringify({ emails: [{ value: email }] }),
});

const myActivity = (action: string, title: string, href: string, at: string) =>
  `<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">${action} <a href="${href}">${title}</a><br>${at}</div>`;

const fitPoint = (code: number, start: string, end: string) => ({
  fitValue: [{ value: { intVal: code } }],
  startTimeNanos: `${Date.parse(start)}000000`,
  endTimeNanos: `${Date.parse(end)}000000`,
});

const RUN = fitPoint(8, "2021-03-06T08:00:00Z", "2021-03-06T08:30:00Z");
const WALK = fitPoint(7, "2021-03-06T09:00:00Z", "2021-03-06T09:20:00Z");
const STILL = fitPoint(3, "2021-03-06T10:00:00Z", "2021-03-06T11:00:00Z");

const fit = (...points: object[]): TakeoutFiles => ({
  [FIT_FILE]: JSON.stringify({ "Data Points": points }),
});

const CHROME: TakeoutFiles = {
  "Takeout/Chrome/History.json": JSON.stringify({
    "Browser History": [{ favicon_url: "", title: "Example", url: "https://example.com/", time_usec: 1614768000000000 }],
  }),
};

const SEARCH: TakeoutFiles = {
  "Takeout/My Activity/Image Search/My Activity.html": myActivity("Searched for", "image query", "https://www.google.com/search?q=image", "4 Mar 2021, 10:00:00 GMT"),
  "Takeout/My Activity/Search/My Activity.html": myActivity("Searched for", "web query", "https://www.google.com/search?q=web", "4 Mar 2021, 11:00:00 GMT"),
};

const SEMANTIC_LOCATION: TakeoutFiles = {
  "Takeout/Location History (Timeline)/Semantic Location History/2021/2021_MARCH.json": JSON.stringify({
    timelineObjects: [
      {
        placeVisit: {
          location: { latitudeE7: 515000000, longitudeE7: -1000000, name: "Example Cafe", placeId: "place-1" },
          duration: { startTimestamp: "2021-03-07T10:00:00Z", endTimestamp: "2021-03-07T11:00:00Z" },
        },
      },
    ],
  }),
};

const RECORDS_ONLY_LOCATION: TakeoutFiles = {
  "Takeout/Location History (Timeline)/Records.json": JSON.stringify({ locations: [] }),
};

const ALL_SERVICES: TakeoutFiles = {
  ...fit(RUN, WALK, STILL),
  ...CHROME,
  ...SEARCH,
  ...SEMANTIC_LOCATION,
  ...RECORDS_ONLY_LOCATION,
  "Takeout/My Activity/YouTube/My Activity.html": myActivity("Watched", "A video", "https://www.youtube.com/watch?v=abc123", "3 Mar 2021, 10:00:00 GMT"),
  "Takeout/Calendar/alex.ics": "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:evt-1@example.com\r\nSUMMARY:Dentist\r\nDTSTART:20210305T090000Z\r\nDTEND:20210305T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
  "Takeout/Keep/Groceries.json": JSON.stringify({ title: "Groceries", textContent: "Eggs", color: "DEFAULT", isTrashed: false, isPinned: false, isArchived: false, createdTimestampUsec: 1614942000000000, userEditedTimestampUsec: 1614942000000000 }),
  "Takeout/Google Chat/Groups/Space A/group_info.json": JSON.stringify({ name: "Alex and Sam", members: [{ name: "Sam", email: "sam@example.com", user_type: "Human" }] }),
  "Takeout/Google Chat/Groups/Space A/messages.json": JSON.stringify({ messages: [{ creator: { name: "Sam", email: "sam@example.com", user_type: "Human" }, created_date: "Monday, 8 March 2021 at 10:00:00 UTC", text: "hello", topic_id: "t1", message_id: "SpaceA/t1/m1" }] }),
  "Takeout/Timeline.json": JSON.stringify({ semanticSegments: [{ startTime: "2021-03-09T10:00:00.000Z", endTime: "2021-03-09T11:00:00.000Z", visit: { topCandidate: { placeId: "place-2", semanticType: "UNKNOWN", placeLocation: { latLng: "51.5°, -0.1°" } } } }] }),
};

describe("Google Takeout through the inbox on a worker thread", () => {
  let root: string;
  let zipCount: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "takeout-handler-"));
    zipCount = 0;
    mkdirSync(join(root, "inbox"));
    mkdirSync(join(root, "tmp"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Writes a Takeout zip to the inbox and processes it, returning the result or the code that ended the worker. */
  async function importTakeout(files: TakeoutFiles): Promise<ProcessResult> {
    const stage = join(root, `stage-${++zipCount}`);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(stage, path)), { recursive: true });
      writeFileSync(join(stage, path), content);
    }
    const zip = Bun.spawnSync(["zip", "-qr", join(root, "inbox", `takeout-${zipCount}.zip`), "Takeout"], { cwd: stage });
    if (zip.exitCode !== 0) throw new Error(`zip failed: ${zip.stderr.toString()}`);

    const source: InboxSourceConfig = { type: "local", local: "inbox", parser: "google-takeout", patterns: ["*.zip"] };
    const workerData: InboxWorkerData = {
      dbPath: join(root, "timeline.db"),
      tmpDir: join(root, "tmp"),
      config: { inbox_path: root, sources: { takeout: source } },
      sourceName: "takeout",
      source,
    };
    const worker = new Worker(INBOX_WORKER, { workerData });
    try {
      return await new Promise<ProcessResult>((settle, reject) => {
        worker.once("message", settle);
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`inbox worker exited with code ${code}`)));
      });
    } finally {
      worker.removeAllListeners();
      await worker.terminate();
    }
  }

  function query<T>(sql: string, ...params: string[]): T[] {
    const db = new Database(join(root, "timeline.db"), { readonly: true });
    try {
      return db.query(sql).all(...params) as T[];
    } finally {
      db.close();
    }
  }

  const eventCounts = () =>
    Object.fromEntries(
      query<{ source: string; count: number }>(`SELECT source, count(*) AS count FROM events GROUP BY source`).map((row) => [row.source, row.count]),
    );

  test("imports every service in one zip without ending the worker", async () => {
    const result = await importTakeout({ ...profile("alex@example.com"), ...ALL_SERVICES });

    expect(result).toMatchObject({ filesProcessed: 1, errors: [] });
    expect(eventCounts()).toEqual({
      chrome: 1,
      "google-calendar": 1,
      "google-chat": 1,
      "google-fit": 2,
      "google-keep": 1,
      "google-location": 2,
      "google-search": 1,
      youtube: 1,
    });
    expect(query<{ n: number }>(`SELECT count(*) AS n FROM events WHERE source_account = 'alex'`)).toEqual([{ n: 10 }]);
    expect(result.eventsAdded).toBe(10);
    // My Activity also holds an Image Search file, which isn't web Search history.
    expect(query(`SELECT title FROM events WHERE source = 'google-search'`)).toEqual([{ title: "web query" }]);

    const counts = eventCounts();
    const again = await importTakeout({ ...profile("alex@example.com"), ...ALL_SERVICES, "Takeout/archive_browser.html": "changes the zip's hash" });
    expect(again).toMatchObject({ filesProcessed: 1, eventsAdded: 0, errors: [] });
    expect(eventCounts()).toEqual(counts);
  });

  test("Search ignores the other My Activity products", async () => {
    const result = await importTakeout({ ...profile("alex@example.com"), "Takeout/My Activity/Image Search/My Activity.html": SEARCH["Takeout/My Activity/Image Search/My Activity.html"] as string });

    expect(result).toMatchObject({ filesProcessed: 1, eventsAdded: 0, errors: [] });
    expect(eventCounts()).toEqual({});
  });

  test("Location imports Semantic Location History and otherwise leaves the rest of the zip alone", async () => {
    const recordsOnly = await importTakeout({ ...profile("alex@example.com"), ...RECORDS_ONLY_LOCATION, ...CHROME });
    expect(recordsOnly).toMatchObject({ filesProcessed: 1, eventsAdded: 1, errors: [] });
    expect(eventCounts()).toEqual({ chrome: 1 });

    const semanticOnly = await importTakeout({ ...profile("alex@example.com"), ...SEMANTIC_LOCATION });
    expect(semanticOnly).toMatchObject({ filesProcessed: 1, eventsAdded: 1, errors: [] });
    expect(eventCounts()).toEqual({ chrome: 1, "google-location": 1 });
  });

  test("Fit imports each segment once per account", async () => {
    const first = await importTakeout({ ...profile("alice@example.com"), ...fit(RUN, STILL) });
    expect(first).toMatchObject({ filesProcessed: 1, eventsAdded: 1, errors: [] });

    const reimport = await importTakeout({ ...profile("alice@example.com"), ...fit(RUN), [`${FIT_FILE}.txt`]: "changes the zip's hash" });
    expect(reimport).toMatchObject({ filesProcessed: 1, eventsAdded: 0, errors: [] });

    const otherAccount = await importTakeout({ ...profile("bob@example.com"), ...fit(RUN, WALK) });
    expect(otherAccount).toMatchObject({ filesProcessed: 1, eventsAdded: 2, errors: [] });

    expect(query(`SELECT source_account, type FROM events ORDER BY source_account, timestamp`)).toEqual([
      { source_account: "alice", type: "activity:running" },
      { source_account: "bob", type: "activity:running" },
      { source_account: "bob", type: "activity:walking" },
    ]);
  });

  test("an unreadable Fit file fails the zip so it can be retried", async () => {
    const result = await importTakeout({ ...profile("alex@example.com"), ...fit(RUN), [`${FIT_FILE.slice(0, -5)}_2.json`]: '{"Data Points": [' });

    expect(result).toMatchObject({ filesProcessed: 0, eventsAdded: 0 });
    expect(result.errors).toEqual([expect.stringContaining("Google Fit import hit 1 unreadable")]);
    expect(eventCounts()).toEqual({ "google-fit": 1 });
  });
});
