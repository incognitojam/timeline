import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initAppStateDb } from "../db/app-state";
import { invalidateHiddenClauseCaches } from "../db/events";
import { wrapDatabase } from "../db/pool";
import { initDb } from "../db/schema";
import { Database } from "../db/sqlite";
import { countTokens } from "../export/tokens";
import { seed } from "../testing/seed";
import { CHECKPOINT_IDLE_DAYS, getUpdates, runGetUpdates } from "./updates";

let db: Database;
let sequence = 0;
const NOW = new Date("2026-03-10T12:00:00Z");

beforeEach(() => {
  db = new Database(":memory:");
  initDb(db);
});
afterEach(() => {
  db.close();
  invalidateHiddenClauseCaches();
});

function insert(event: { source: string; type: string; timestamp: string; title?: string; content?: string; conversation?: string; end?: string; people?: string[]; sourceId?: string; raw?: unknown }): number {
  sequence += 1;
  return Number(db.prepare(`
    INSERT INTO events (source, source_id, source_account, type, timestamp, end_timestamp, title, content, people, raw_data, conversation_id, imported_at)
    VALUES (?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.source, event.sourceId ?? `e${sequence}`, event.type, event.timestamp, event.end ?? null,
    event.title ?? event.conversation ?? null, event.content ?? null,
    JSON.stringify(event.people ?? [`${event.source}:alice`]), JSON.stringify(event.raw ?? {}), event.conversation ?? null,
    NOW.toISOString().slice(0, 19).replace("T", " "),
  ).lastInsertRowid);
}

const message = (content: string, timestamp: string, conversation = "general") =>
  insert({ source: "discord", type: "message:guild", timestamp, content, conversation });

const updates = (since: string, extra: Partial<Parameters<typeof getUpdates>[1]> = {}) =>
  getUpdates(wrapDatabase(db), { since, now: NOW, healthDays: 0, ...extra });

function cursorOf(text: string): string | undefined {
  return /^More: call again with cursor="([^"]+)"\.$/m.exec(text)?.[1];
}

function nextMarker(text: string): string {
  const marker = /since="(id:\d+)"/.exec(text.split("\n").at(-1) ?? "")?.[1];
  if (!marker) throw new Error(`No marker in:\n${text}`);
  return marker;
}

test("the marker neither repeats nor misses events, including a late import with an old timestamp", async () => {
  message("first message", "2026-03-08T09:00:00Z");
  const first = await updates("2026-03-08");
  expect(first).toContain("first message");

  message("second", "2026-03-09T09:00:00Z");
  message("imported late", "2026-02-20T09:00:00Z");
  // Dated before a date since could reach from when the marker was added: summed, not shown.
  message("from an old export", "2025-12-01T09:00:00Z");
  message("also old", "2024-06-01T09:00:00Z");
  const second = await updates(nextMarker(first));
  expect(second).toContain("second");
  expect(second).toContain("imported late");
  expect(second).not.toContain("first message");
  expect(second).not.toContain("old export");
  expect(second).toContain("# Imported but dated before 2026-02-07, not listed (query_events with source and end_date reads them)\ndiscord 2, dated 2024-06-01 to 2025-12-01");

  const third = await updates(nextMarker(second));
  expect(third).toContain("No new messages.");
  expect(nextMarker(third)).toBe(nextMarker(second));
});

test("a date since selects by event time, so an old late import waits for the marker", async () => {
  message("old", "2025-12-01T09:00:00Z");
  message("recent", "2026-03-09T09:00:00Z");
  const text = await updates("2026-03-01");
  expect(text).toContain("recent");
  expect(text).not.toContain("old");
});

test("over the size cap, following cursors shows every conversation once, and only the last page gives a marker", async () => {
  seed(db, () => {
    for (let c = 0; c < 45; c += 1) {
      for (let m = 0; m < 12; m += 1) {
        message(`chan ${c} says something fairly ordinary, number ${m}`, `2026-03-09T${String(c % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`, `chan-${c}`);
      }
    }
  });
  const first = await updates("id:0", { maxTokens: 2000 });
  const marker = /up to (id:\d+)/.exec(first)?.[1];
  if (!marker) throw new Error(first);
  message("added after the first reply", "2026-03-10T09:00:00Z", "chan-0");

  const seen: string[] = [];
  let reply = first;
  for (let pages = 0; pages < 20; pages += 1) {
    expect(countTokens(reply)).toBeLessThanOrEqual(2000);
    expect(reply).not.toContain("added after the first reply");
    seen.push(...[...reply.matchAll(/^## discord: (chan-\d+)/gm)].map((match) => match[1] ?? ""));
    const cursor = cursorOf(reply);
    if (!cursor) {
      expect(nextMarker(reply)).toBe(marker);
      break;
    }
    expect(reply).not.toContain("Next check");
    expect(reply.split("\n").at(-1)).toBe(`More: call again with cursor="${cursor}".`);
    // Only the cursor the line prints.
    reply = await getUpdates(wrapDatabase(db), { cursor, now: NOW });
  }
  expect(seen.sort()).toEqual(Array.from({ length: 45 }, (_, c) => `chan-${c}`).sort());
});

test("a cursor is refused once its catch-up has changed, so no conversation is skipped", async () => {
  const hidden = Number(db.prepare("INSERT INTO contacts (display_name) VALUES ('Bob Example')").run().lastInsertRowid);
  db.prepare("INSERT INTO identities (platform, platform_id, contact_id) VALUES ('discord', 'bob', ?)").run(hidden);
  insert({ source: "discord", type: "message:guild", timestamp: "2026-03-09T10:00:00Z", content: "word ".repeat(2000), conversation: "long", people: ["discord:bob"] });
  message("short and sweet", "2026-03-09T09:00:00Z", "short");
  const cursor = cursorOf(await updates("id:0", { maxTokens: 1000 }));
  if (!cursor) throw new Error("expected a second page");
  db.prepare("UPDATE contacts SET hidden = 1 WHERE id = ?").run(hidden);
  invalidateHiddenClauseCaches();
  await expect(getUpdates(wrapDatabase(db), { cursor, now: NOW })).rejects.toThrow("This catch-up changed since its first page");
});

test("a conversation with more new messages than fit points to export_conversation for the rest", async () => {
  seed(db, () => {
    for (let m = 0; m < 150; m += 1) message(`number ${m}`, `2026-03-09T10:${String(m % 60).padStart(2, "0")}:${String(Math.floor(m / 60)).padStart(2, "0")}Z`);
  });
  const text = await updates("id:0");
  expect(text).toContain('Showing the latest 100 of 150 new messages; for more, export_conversation conversation_id="general" start_date="2026-03-09T10:00:00Z" (newest 500 by default');
});

test("health lines count against the cap, newest days kept", async () => {
  seed(db, () => {
    for (let d = 0; d < 90; d += 1) {
      const day = new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10);
      for (const [type, title] of [["daily:heart", "Resting HR: 55 bpm"], ["daily:hrv", "HRV: 50.0ms RMSSD"], ["daily:activity", "9,000 steps, 2,300 cal"], ["daily:spo2", "SpO2: 95.5%"]]) {
        insert({ source: "google-health", type: type ?? "", timestamp: `${day}T00:00:00Z`, title });
      }
    }
  });
  const text = await updates("id:0", { healthDays: 90, maxTokens: 1000 });
  expect(countTokens(text)).toBeLessThanOrEqual(1000);
  expect(text).toContain(`${NOW.toISOString().slice(0, 10)}: Resting HR`);
  expect(text).toMatch(/\(\d+ older days cut to fit; pass a larger max_tokens\)/);
});

test("a cursor is passed alone, and one this tool did not print, or an edited one, is an error", async () => {
  message("word ".repeat(2000), "2026-03-09T10:00:00Z", "long");
  message("short and sweet", "2026-03-09T09:00:00Z", "short");
  const cursor = cursorOf(await updates("id:0", { maxTokens: 1000 }));
  if (!cursor) throw new Error("expected a second page");
  const [payload] = cursor.split(".");
  const edited = Buffer.from(Buffer.from(payload ?? "", "base64url").toString().replace('"skip":1', '"skip":9')).toString("base64url");
  for (const params of [{ cursor: "bm90IGpzb24" }, { cursor, since: "id:0" }, { cursor: `${edited}.${cursor.split(".")[1]}` }, {}]) {
    expect((await runGetUpdates(wrapDatabase(db), params)).isError).toBe(true);
  }
});

test("one reply covers a bounded id window and its marker continues from there", async () => {
  seed(db, () => {
    for (let m = 0; m < 10; m += 1) message(`number ${m}`, `2026-03-09T09:0${m}:00Z`);
  });
  const first = await updates("id:0", { windowIds: 6 });
  expect(first).toContain("More was added than one reply covers");
  expect(first).toContain("number 5");
  expect(first).not.toContain("number 6");
  const second = await updates(nextMarker(first), { windowIds: 6 });
  expect(second).toContain("number 6");
  expect(second).toContain("number 9");
  expect(second).not.toContain("number 5");
});

test("a date since compares instants, whatever offset a timestamp is stored with", async () => {
  message("late evening in Seattle", "2026-03-08T23:30:00-08:00");
  message("before the date", "2026-03-08T15:00:00-08:00");
  message("far east of UTC", "2026-03-08T10:00:00-14:00");
  const text = await updates("2026-03-09");
  expect(text).toContain("late evening in Seattle");
  expect(text).toContain("far east of UTC");
  expect(text).not.toContain("before the date");
  const old = await runGetUpdates(wrapDatabase(db), { since: "2025-01-01" });
  expect(old.isError).toBe(true);
});

test("health shows one line a day, preferring google-health, with sleep on the day it ends", async () => {
  insert({ source: "google-health", type: "sleep", timestamp: "2026-03-08T23:00:00.000-08:00", end: "2026-03-09T07:00:00.000-08:00", title: "Sleep: 8h 0m (95% efficiency)" });
  insert({ source: "google-health", type: "daily:heart", timestamp: "2026-03-09T00:00:00Z", title: "Resting HR: 55 bpm" });
  insert({ source: "fitbit", type: "daily:heart", timestamp: "2026-03-09T00:00:00Z", title: "Resting HR: 60 bpm" });
  insert({ source: "fitbit", type: "daily:readiness", timestamp: "2026-03-09T00:00:00Z", title: "Readiness: 70/100" });
  insert({ source: "google-health", type: "daily:hrv", timestamp: "2026-01-01T00:00:00Z", title: "HRV: 40.0ms RMSSD" });

  const text = await updates("id:0", { healthDays: 14 });
  expect(text).toContain("2026-03-09: Sleep: 8h 0m (95% efficiency) · Resting HR: 55 bpm · Readiness: 70/100");
  expect(text).not.toContain("60 bpm");
  expect(text).not.toContain("HRV");
  expect(text).not.toContain("2026-03-08:");
  // Health records are never counted as other events.
  expect(text).not.toContain("# Other new events");
});

test("noisy sources are left out unless asked for, and other sources are counted", async () => {
  message("hello", "2026-03-09T09:00:00Z");
  insert({ source: "claude-code", type: "claude-code:message:user", timestamp: "2026-03-09T10:00:00Z", content: "refactor the parser", conversation: "session-1" });
  insert({ source: "spotify", type: "listen:track", timestamp: "2026-03-09T11:00:00Z", title: "A song" });

  const text = await updates("id:0");
  expect(text).not.toContain("refactor the parser");
  expect(text).toContain("Left out as noisy unless listed in sources: claude-code 1");
  expect(text).toContain("spotify 1");
  expect(text).not.toContain("A song");

  const asked = await updates("id:0", { sources: ["claude-code", "spotify"] });
  expect(asked).toContain("refactor the parser");
  expect(asked).toContain("A song");
  expect(asked).not.toContain("hello");
});

test("a hidden contact's new messages are left out, while the rest of their group stays", async () => {
  const hidden = Number(db.prepare("INSERT INTO contacts (display_name, hidden) VALUES ('Hidden Person', 1)").run().lastInsertRowid);
  db.prepare("INSERT INTO identities (platform, platform_id, display_name, contact_id) VALUES ('discord', '900000000000000009', 'Hidden Person', ?)").run(hidden);
  invalidateHiddenClauseCaches();
  // A direct message lists both people; a group message only its sender.
  const say = (content: string, people: string[], conversation: string, minute: number) => insert({
    source: "discord", type: conversation === "dm" ? "message:dm" : "message:group",
    timestamp: `2026-03-09T09:${String(minute).padStart(2, "0")}:00Z`, content, conversation,
    people: people.map((person) => `discord:${person === "hidden" ? "900000000000000009" : person}`),
  });
  say("secret in a direct message", ["hidden", "alice"], "dm", 0);
  say("reply to the hidden person", ["alice", "hidden"], "dm", 1);
  say("secret in the group", ["hidden", "alice", "bob", "carol"], "group", 2);
  say("visible group message", ["alice", "hidden", "bob", "carol"], "group", 3);
  insert({
    source: "discord", type: "message:group", timestamp: "2026-03-09T09:04:00Z", content: "agreed with that", conversation: "group",
    sourceId: "800000000000000002", people: ["discord:alice"], raw: { message_reference: { message_id: "800000000000000001", type: 0 } },
  });
  insert({
    source: "discord", type: "message:group", timestamp: "2026-03-08T09:00:00Z", content: "secret being replied to", conversation: "group",
    sourceId: "800000000000000001", people: ["discord:900000000000000009"], raw: { author: { id: "900000000000000009" } },
  });

  const text = await updates("id:0");
  expect(text).not.toContain("secret");
  expect(text).not.toContain("reply to the hidden person");
  expect(text).toContain("visible group message");
  expect(text).toContain("agreed with that");
  expect(text).not.toContain("Hidden Person");
});

test("a conversation too long for the cap on its own is pointed to, and paging moves past it", async () => {
  message("word ".repeat(2000), "2026-03-09T10:00:00Z", "long");
  message("short and sweet", "2026-03-09T09:00:00Z", "short");
  const first = await updates("id:0", { maxTokens: 1000 });
  expect(countTokens(first)).toBeLessThanOrEqual(1000);
  expect(first).toContain('## discord: long · conversation_id="long"\n1 new, too long for max_tokens; read them with export_conversation conversation_id="long"');
  const cursor = cursorOf(first);
  if (!cursor) throw new Error(first);
  expect(await getUpdates(wrapDatabase(db), { cursor, now: NOW })).toContain("short and sweet");
});

test("the index stays within the cap, however long the conversation ids", async () => {
  seed(db, () => {
    for (let c = 0; c < 30; c += 1) {
      for (let m = 0; m < 10; m += 1) message(`chan ${c} message ${m} with a few more ordinary words`, `2026-03-09T${String(c % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`, `${c}-${"x9Qz".repeat(60)}`);
    }
  });
  const text = await updates("id:0", { maxTokens: 1000 });
  expect(countTokens(text)).toBeLessThanOrEqual(1000);
  expect(text).toMatch(/^- and \d+ more conversations, \d+ new$/m);
});

test("listing a health source narrows the health lines to it", async () => {
  insert({ source: "google-health", type: "daily:heart", timestamp: "2026-03-09T00:00:00Z", title: "Resting HR: 55 bpm" });
  insert({ source: "fitbit", type: "daily:heart", timestamp: "2026-03-09T00:00:00Z", title: "Resting HR: 60 bpm" });
  const text = await updates("id:0", { healthDays: 14, sources: ["fitbit"] });
  expect(text).toContain("2026-03-09: Resting HR: 60 bpm");
  expect(text).not.toContain("55 bpm");
  expect(await updates("id:0", { healthDays: 14, sources: ["discord"] })).not.toContain("# Health");
});

test("a since past the newest event returns the newest id as the marker", async () => {
  const last = message("only", "2026-03-09T09:00:00Z");
  expect(nextMarker(await updates(`id:${last + 100}`))).toBe(`id:${last}`);
});

test("a page of a date window keeps working after the date passes the look-back limit", async () => {
  message("near the limit", "2026-02-08T13:00:00Z");
  message("word ".repeat(2000), "2026-02-08T14:00:00Z", "long");
  const cursor = cursorOf(await updates("2026-02-08T12:00:00Z", { maxTokens: 1000 }));
  if (!cursor) throw new Error("expected a second page");
  const later = new Date("2026-03-12T12:00:00Z");
  expect(await getUpdates(wrapDatabase(db), { cursor, now: later })).toContain("near the limit");
  await expect(updates("2026-02-08T12:00:00Z", { now: later })).rejects.toThrow("the earliest accepted now is 2026-02-09T12:00:00.000Z");
});

test("a bad since is an error reply", async () => {
  const result = await runGetUpdates(wrapDatabase(db), { since: "last tuesday" });
  expect(result.isError).toBe(true);
});

test("headings carry the conversation_id to pass back, and an unknown one is an error", async () => {
  message("see you at the trailhead", "2026-03-09T09:00:00Z", "c-42");
  const text = await updates("id:0");
  expect(text).toMatch(/^## discord: c-42 · conversation_id="c-42" · latest event_id=\d+$/m);
  expect(await updates("id:0", { conversationId: "c-42" })).toContain("see you at the trailhead");
  const unknown = await runGetUpdates(wrapDatabase(db), { since: "id:0", conversation_id: "weekend hike" });
  expect(unknown.isError).toBe(true);
  expect(unknown.content[0]).toMatchObject({ text: expect.stringContaining('No conversation has conversation_id "weekend hike"') });
});

test("events outside conversations are not headed as messages", async () => {
  insert({ source: "call-recordings", type: "recording:unknown", timestamp: "2026-03-09T09:00:00Z", title: "Bob", content: "Recorded call with Bob (9m)" });
  const text = await updates("id:0", { sources: ["call-recordings"] });
  expect(text).toContain("# Events: 1 new in 1 group");
  expect(text).toContain("## call-recordings, not in a conversation");
  expect(nextMarker(text)).toMatch(/^id:\d+$/);
  expect(text.split("\n").at(-1)).toContain('sources=["call-recordings"]');
});

test("health shows the days its heading names, on broad checks unless health_days says otherwise", async () => {
  message("hello", "2026-03-09T09:00:00Z", "c-1");
  seed(db, () => {
    insert({ source: "google-health", type: "sleep", timestamp: "2026-02-24T23:00:00Z", end: "2026-02-25T06:00:00Z", title: "Sleep: 7h 0m" });
    for (let d = 0; d < 20; d += 1) {
      insert({ source: "google-health", type: "daily:heart", timestamp: `${new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`, title: "Resting HR: 55 bpm" });
    }
  });
  const call = (extra: Partial<Parameters<typeof getUpdates>[1]>) => getUpdates(wrapDatabase(db), { since: "id:0", now: NOW, ...extra });
  const broad = await call({});
  expect(broad).toContain("# Health, last 14 days");
  expect(broad.match(/^\d{4}-\d{2}-\d{2}: /gm)).toHaveLength(14);
  // A night that ends on the first day still counts there.
  expect(broad).toContain("2026-02-25: Sleep: 7h 0m · Resting HR");
  expect(await call({ conversationId: "c-1" })).not.toContain("# Health");
  // The first page shows health; later pages do not repeat it.
  message("word ".repeat(2000), "2026-03-09T08:00:00Z", "c-2");
  const cursor = cursorOf(await call({ maxTokens: 2000 }));
  if (!cursor) throw new Error("expected a second page");
  expect(await call({ since: undefined, cursor })).not.toContain("# Health");
  expect(await call({ conversationId: "c-1", healthDays: 3 })).toContain("# Health, last 3 days");
  expect(await call({ healthDays: 0 })).not.toContain("# Health");
});

test("a conversation without a title can be passed back by the id its heading shows", async () => {
  const id = message("untitled hello", "2026-03-09T09:00:00Z", "c-untitled");
  db.prepare("UPDATE events SET title = NULL WHERE id = ?").run(id);
  expect(await updates("id:0")).toContain('## discord: (untitled) · conversation_id="c-untitled"');
  expect(await updates("id:0", { conversationId: "c-untitled" })).toContain("untitled hello");
  // With nothing new it is quiet, not unknown, in any source and account.
  insert({ source: "google-messages", type: "sms:received", timestamp: "2026-03-09T10:00:00Z", content: "other", conversation: "+15550100" });
  const quiet = await updates(`id:${id + 1}`, { conversationId: "c-untitled" });
  expect(quiet).toContain("No new messages.");
  // A NULL account, an empty one, and a later account on a later source.
  const insertIn = (source: string, account: string | null, conversation: string) => Number(db.prepare(`
    INSERT INTO events (source, source_id, source_account, type, timestamp, people, raw_data, conversation_id)
    VALUES (?, ?, ?, 'message:dm', '2026-03-09T11:00:00Z', '[]', '{}', ?)
  `).run(source, conversation, account, conversation).lastInsertRowid);
  insertIn("discord", null, "c-null-account");
  insertIn("discord", "", "c-empty-account");
  insertIn("skype", "a", "c-skype-a");
  const last = insertIn("skype", "b", "c-skype-b");
  for (const conversationId of ["c-null-account", "c-empty-account", "c-skype-b"]) {
    expect(await updates(`id:${last}`, { conversationId })).toContain("No new messages.");
  }
  expect((await runGetUpdates(wrapDatabase(db), { since: `id:${id + 1}`, conversation_id: "c-missing" })).isError).toBe(true);
});

test("a conversation with a huge title still fits the cap when pointed to", async () => {
  insert({ source: "discord", type: "message:guild", timestamp: "2026-03-09T09:00:00Z", content: "word ".repeat(2000), conversation: "big", title: "T".repeat(20_000) });
  const text = await updates("id:0", { maxTokens: 1000 });
  expect(countTokens(text)).toBeLessThanOrEqual(1000);
  expect(text).toContain('conversation_id="big"');
});

test("with both the id window and the page full, only the last page names a checkpoint", async () => {
  seed(db, () => {
    for (let c = 0; c < 20; c += 1) {
      for (let m = 0; m < 10; m += 1) message(`chan ${c} message ${m} with a few more ordinary words`, `2026-03-09T${String(c).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`, `chan-${c}`);
    }
  });
  const text = await updates("id:0", { windowIds: 150, maxTokens: 1000 });
  expect(text).toContain("this stops at id:150");
  expect(text).not.toContain("Next check");
  expect(cursorOf(text)).toBeDefined();
});

test("one day of health counts the night that ended today and nothing dated later", async () => {
  insert({ source: "google-health", type: "sleep", timestamp: "2026-03-09T23:00:00Z", end: "2026-03-10T06:00:00Z", title: "Sleep: 7h 0m" });
  insert({ source: "google-health", type: "daily:heart", timestamp: "2026-03-11T00:00:00Z", title: "Resting HR: 99 bpm" });
  const text = await updates("id:0", { healthDays: 1 });
  expect(text).toContain("2026-03-10: Sleep: 7h 0m");
  expect(text).not.toContain("2026-03-11");
});

test("conversations that involve the owner come before busier channels, after an index of all of them", async () => {
  const self = Number(db.prepare("INSERT INTO contacts (display_name, is_self) VALUES ('Alex Example', 1)").run().lastInsertRowid);
  for (const platform of ["discord", "facebook"]) {
    db.prepare("INSERT INTO identities (platform, platform_id, display_name, contact_id) VALUES (?, 'me', 'Alex Example', ?)").run(platform, self);
  }
  seed(db, () => {
    for (let m = 0; m < 40; m += 1) message(`busy channel chatter ${m}`, `2026-03-09T12:${String(m).padStart(2, "0")}:00Z`, "busy");
  });
  // An incoming DM may list only its sender; a group lists everyone, the owner included, whether or not they posted.
  insert({ source: "discord", type: "message:dm", timestamp: "2026-03-09T08:00:00Z", content: "are we still on for 9?", conversation: "dm-bob", people: ["discord:bob"] });
  insert({ source: "facebook", type: "message", timestamp: "2026-03-09T13:00:00Z", content: "who's bringing chairs", conversation: "fb-group", people: ["facebook:carol", "facebook:me", "facebook:dan"] });
  const text = await updates("id:0");
  expect(text).toMatch(/# Messages: 42 new in 3 conversations, most recent first\n- discord: dm-bob · conversation_id="dm-bob" · 1 new\n- facebook: fb-group · conversation_id="fb-group" · 1 new\n- discord: busy · conversation_id="busy" · 40 new\n/);
  expect(text.indexOf("are we still on")).toBeLessThan(text.indexOf("busy channel chatter"));
  // The first line after a heading, a date or a trim always names its sender.
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (/^(## |### |Showing the latest)/.test(line) && /^\d\d:\d\d /.test(lines[i + 1] ?? "")) expect(lines[i + 1]).toMatch(/^\d\d:\d\d <[^>]+> /);
  });
});

test("quiet sources get one line an event, busy ones a count", async () => {
  insert({ source: "google-calendar", type: "event", timestamp: "2026-03-09T15:00:00Z", title: "Dentist" });
  insert({ source: "google-location", type: "location:visit", timestamp: "2026-03-09T16:00:00Z", title: "Visited Greenline Grocery" });
  insert({ source: "google-location", type: "location:transit", timestamp: "2026-03-09T16:30:00Z", title: "Walked 1 km" });
  insert({ source: "spotify", type: "listen:track", timestamp: "2026-03-09T17:00:00Z", title: "A song" });
  const text = await updates("id:0");
  expect(text).toContain("# Events, one line each (2)\n- 2026-03-09 16:00 google-location: Visited Greenline Grocery\n- 2026-03-09 15:00 google-calendar: Dentist");
  expect(text).toContain("google-location other 1, spotify 1");
  expect(text).not.toContain("Walked");
  // Listing a source shows all of it in full instead.
  expect(await updates("id:0", { sources: ["google-location"] })).toContain("Walked 1 km");
});

test("a conversation titled by a known number shows the contact's name beside it", async () => {
  const bob = Number(db.prepare("INSERT INTO contacts (display_name) VALUES ('Bob Example')").run().lastInsertRowid);
  db.prepare("INSERT INTO identities (platform, platform_id, contact_id) VALUES ('phone', '+15550100', ?)").run(bob);
  insert({ source: "google-messages", type: "sms:received", timestamp: "2026-03-09T09:00:00Z", content: "running late", conversation: "+15550100", people: ["phone:+15550100"] });
  expect(await updates("id:0")).toContain('- google-messages: Bob Example (+15550100) · conversation_id="+15550100" · 1 new');
});

describe("checkpoints", () => {
  let appState: Database;
  beforeEach(() => {
    appState = new Database(":memory:");
    initAppStateDb(appState);
  });
  afterEach(() => appState.close());
  const at = (now: Date, params: Parameters<typeof getUpdates>[1]) =>
    getUpdates(wrapDatabase(db), { healthDays: 0, now, ...params }, () => appState);
  const position = (name: string) => (appState.query("SELECT position FROM mcp_checkpoints WHERE name = ?").get(name) as { position: number } | null)?.position;
  const later = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

  test("a new name starts a week back, and the last page moves it", async () => {
    message("too old for a new checkpoint", "2026-03-01T09:00:00Z");
    const first = message("this week", "2026-03-08T09:00:00Z");
    const reply = await at(NOW, { checkpoint: "daily" });
    expect(reply).toContain('Checkpoint "daily" is new, so this starts 7 days back');
    expect(reply).toContain("this week");
    expect(reply).not.toContain("too old");
    expect(reply.split("\n").at(-1)).toBe(`Checkpoint "daily" is now at id:${first}. Next check: checkpoint="daily".`);

    const quiet = await at(later(1), { checkpoint: "daily" });
    expect(quiet).toContain("No new messages.");
    expect(quiet).toContain(`Checkpoint "daily" is at id:${first}. The catch-ups that last moved it started at since="2026-03-03T12:00:00.000Z" (2026-03-10T12:00Z).`);
    expect(position("daily")).toBe(first);
    expect(await at(later(1), { checkpoint: "weekly" })).toContain("Existing checkpoints, most recently used first: daily.");
  });

  test("after two lost replies in a row, the next call still names where the first began", async () => {
    const start = message("one", "2026-03-09T09:00:00Z");
    await at(NOW, { checkpoint: "daily", since: `id:${start - 1}` });
    const second = message("two", "2026-03-09T10:00:00Z");
    expect(await at(later(1), { checkpoint: "daily" })).toContain("two"); // lost
    message("three", "2026-03-09T11:00:00Z");
    expect(await at(later(2), { checkpoint: "daily" })).toContain("three"); // lost too
    const third = await at(later(3), { checkpoint: "daily" });
    expect(third).toContain(`started at since="id:${start - 1}" (2026-03-10T12:00Z), since="id:${start}" (2026-03-10T13:00Z), since="id:${second}" (2026-03-10T14:00Z)`);
    const replay = await at(later(3), { checkpoint: "daily", since: `id:${start}` });
    expect(replay).toContain("two");
    expect(replay).toContain("three");
  });

  test("a catch-up that may have left events out does not move a checkpoint, nor does a stale page", async () => {
    const first = message("first", "2026-03-09T09:00:00Z");
    await at(NOW, { checkpoint: "daily", since: "id:0" });
    message("long", "2026-03-09T10:00:00Z", "long");
    const skipped = message("skipped by a later since", "2026-03-09T11:00:00Z");
    message("imported late", "2026-01-01T09:00:00Z");
    const latest = message("latest", "2026-03-09T12:00:00Z");
    for (const since of [`id:${skipped}`, "2026-03-09"]) {
      expect(await at(NOW, { checkpoint: "daily", since })).toContain(`Checkpoint "daily" stays at id:${first}`);
      expect(position("daily")).toBe(first);
    }
    // A stale cursor ends behind where the checkpoint now stands.
    message("word ".repeat(2000), "2026-03-09T08:00:00Z", "huge");
    const cursor = cursorOf(await at(NOW, { checkpoint: "daily", maxTokens: 1000 }));
    if (!cursor) throw new Error("expected a second page");
    await at(NOW, { checkpoint: "daily" });
    const moved = position("daily");
    message("newer", "2026-03-09T13:00:00Z");
    await at(NOW, { checkpoint: "daily" });
    expect(position("daily")).toBeGreaterThan(moved ?? Infinity);
    await at(NOW, { cursor });
    expect(position("daily")).toBeGreaterThan(latest);
  });

  test("only the last page of an unfiltered catch-up moves a checkpoint", async () => {
    message("word ".repeat(2000), "2026-03-09T10:00:00Z", "long");
    const last = message("short and sweet", "2026-03-09T09:00:00Z", "short");
    const page = await at(NOW, { checkpoint: "daily", maxTokens: 1000 });
    expect(page).toContain('Updates for checkpoint "daily"');
    expect(position("daily")).toBeUndefined();
    const cursor = cursorOf(page);
    if (!cursor) throw new Error(page);
    expect(await at(NOW, { cursor })).toContain('Checkpoint "daily" is now at id:');
    expect(position("daily")).toBe(last);

    message("more", "2026-03-09T11:00:00Z", "short");
    expect(await at(NOW, { checkpoint: "daily", conversationId: "short" })).toContain('(checkpoint "daily" was not moved');
    expect(await at(NOW, { checkpoint: "daily", sources: ["discord"] })).toContain('(checkpoint "daily" was not moved');
    expect(position("daily")).toBe(last);
  });

  test("a checkpoint stores where a catch-up started in normal form, never the caller's text", async () => {
    message("hello", "2026-03-09T09:00:00Z");
    await at(NOW, { checkpoint: "daily", since: "Mar 9 2026 (from the agent)" });
    expect(appState.query("SELECT moves FROM mcp_checkpoints").get()).toEqual({ moves: expect.stringContaining('"from":"2026-03-09T') });
    expect(appState.query("SELECT moves FROM mcp_checkpoints").get()).not.toEqual({ moves: expect.stringContaining("agent") });
    await expect(at(NOW, { checkpoint: "daily", since: `2026-03-09 (${"x".repeat(100)})` })).rejects.toThrow("at most 64 characters");
  });

  test("names are checked, and a checkpoint no call used for a while is cleaned up", async () => {
    expect((await runGetUpdates(wrapDatabase(db), { checkpoint: "my checkpoint!" }, () => appState)).isError).toBe(true);
    message("hello", "2026-03-09T09:00:00Z");
    for (const name of ["forgotten", "in-use"]) await at(NOW, { checkpoint: name });
    const day = (n: number) => later(n * 24);
    await at(day(60), { checkpoint: "in-use" });
    expect(await at(day(60), { checkpoint: "new-name" })).toContain("Existing checkpoints, most recently used first: in-use, forgotten.");
    // Creating a checkpoint, as moving one does, deletes those idle too long.
    await at(day(CHECKPOINT_IDLE_DAYS + 5), { checkpoint: "fresh" });
    expect(["forgotten", "in-use", "fresh"].map(position).map((p) => p !== undefined)).toEqual([false, true, true]);
  });
});
