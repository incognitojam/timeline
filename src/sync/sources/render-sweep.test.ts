import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../../db/schema";
import { renderDiscordEvent } from "../../platforms/discord/render";
import type { RendererRegistration } from "../../render";
import {
  type RenderSweepSettings,
  parseRenderSweepSettings,
  sweepRenderedEvents,
} from "./render-sweep";

describe("render sweep", () => {
  let db: Database;

  const settings: RenderSweepSettings = { dryRun: false, timeBudgetMs: 60_000 };

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  function insertDiscordEvent({
    sourceId,
    title = "general",
    content,
    people,
    rawData,
  }: {
    sourceId: string;
    title?: string | null;
    content: string | null;
    people?: string[];
    rawData: Record<string, unknown> | string;
  }): number {
    const result = db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, title, content, people, raw_data, conversation_id
      ) VALUES ('discord', ?, 'account', 'message:dm', ?, ?, ?, ?, ?)
    `).run(
      sourceId,
      title,
      content,
      people ? JSON.stringify(people) : null,
      typeof rawData === "string" ? rawData : JSON.stringify(rawData),
      sourceId,
    );
    return Number(result.lastInsertRowid);
  }

  function discordRawData(content: string, channel = "general"): Record<string, unknown> {
    return { content, edited_timestamp: null, _channel: { name: channel } };
  }

  function sweepState(): { version: number; last_event_id: number } | null {
    return db
      .query<{ version: number; last_event_id: number }, []>(
        "SELECT version, last_event_id FROM render_sweep_state WHERE source = 'discord'",
      )
      .get();
  }

  it("recovers forwarded Discord text from message snapshots", () => {
    insertDiscordEvent({
      sourceId: "forward",
      content: null,
      rawData: {
        ...discordRawData(""),
        message_snapshots: [{ message: { content: "Forwarded body" } }],
      },
    });

    const result = sweepRenderedEvents(db, settings);

    expect(result).toMatchObject({ changed: 1, unchanged: 0, failed: 0, remaining: 0, caughtUp: true });
    expect(db.prepare("SELECT content FROM events WHERE source_id = 'forward'").get()).toEqual({
      content: "Forwarded body",
    });
  });

  it("does not update rows whose rendered text is already current", () => {
    const eventId = insertDiscordEvent({
      sourceId: "current",
      content: "already current",
      people: ["discord:alice"],
      rawData: discordRawData("already current"),
    });
    db.prepare("DELETE FROM event_people WHERE event_id = ?").run(eventId);

    const result = sweepRenderedEvents(db, settings);

    expect(result).toMatchObject({ changed: 0, unchanged: 1, failed: 0, caughtUp: true });
    expect(db.prepare("SELECT * FROM event_people WHERE event_id = ?").all(eventId)).toEqual([]);
  });

  it("treats null and empty rendered text as unchanged", () => {
    const nullContentId = insertDiscordEvent({
      sourceId: "null-content",
      content: null,
      people: ["discord:alice"],
      rawData: discordRawData(""),
    });
    const emptyContentId = insertDiscordEvent({
      sourceId: "empty-content",
      content: "",
      people: ["discord:bob"],
      rawData: {
        content: null,
        edited_timestamp: null,
        _channel: { name: "general" },
      },
    });
    db.prepare("DELETE FROM event_people WHERE event_id IN (?, ?)").run(nullContentId, emptyContentId);

    const result = sweepRenderedEvents(db, settings);

    expect(result).toMatchObject({ changed: 0, unchanged: 2, failed: 0, caughtUp: true });
    expect(db.prepare("SELECT * FROM event_people WHERE event_id IN (?, ?)").all(nullContentId, emptyContentId)).toEqual([]);
  });

  it("rotates batches across registered renderers", () => {
    const insert = db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, title, content, raw_data, conversation_id)
      VALUES (?, ?, 'account', 'message', 'title', NULL, '{"content":"body"}', ?)
    `);
    for (const source of ["first", "second"]) {
      for (let index = 0; index < 1_000; index++) {
        insert.run(source, `${source}-${index}`, `${source}-${index}`);
      }
    }
    const renderers: ReadonlyMap<string, RendererRegistration> = new Map([
      ["first", { version: 1, render: () => ({ title: "title", content: "body" }) }],
      ["second", { version: 1, render: () => ({ title: "title", content: "body" }) }],
    ]);
    let nowCalls = 0;

    const result = sweepRenderedEvents(db, { ...settings, timeBudgetMs: 750 }, {
      renderers,
      now: () => nowCalls++,
    });

    expect(result).toMatchObject({ stoppedReason: "time-budget", caughtUp: false });
    const watermarks = db.query<{ source: string; last_event_id: number }, []>(
      "SELECT source, last_event_id FROM render_sweep_state ORDER BY source",
    ).all();
    expect(watermarks).toHaveLength(2);
    expect(watermarks[0].last_event_id).toBeGreaterThan(0);
    expect(watermarks[1].last_event_id).toBeGreaterThan(0);
  });

  it("resumes an interrupted sweep from its persisted watermark", () => {
    insertDiscordEvent({ sourceId: "first", content: "one", rawData: discordRawData("one") });
    const secondId = insertDiscordEvent({ sourceId: "second", content: "two", rawData: discordRawData("two") });
    insertDiscordEvent({ sourceId: "third", content: "three", rawData: discordRawData("three") });
    let nowCalls = 0;

    const interrupted = sweepRenderedEvents(db, { ...settings, timeBudgetMs: 1 }, {
      now: () => (nowCalls++ < 4 ? 0 : 2),
    });
    const interruptedState = sweepState();
    const resumed = sweepRenderedEvents(db, settings);

    expect(interrupted).toMatchObject({ examined: 2, remaining: 1, caughtUp: false, stoppedReason: "time-budget" });
    expect(interruptedState).toEqual({ version: 1, last_event_id: secondId });
    expect(resumed).toMatchObject({ examined: 1, remaining: 0, caughtUp: true });
  });

  it("rescans a source when its renderer version changes", () => {
    const eventId = insertDiscordEvent({ sourceId: "versioned", content: "current", rawData: discordRawData("current") });
    sweepRenderedEvents(db, settings);
    const renderers: ReadonlyMap<string, RendererRegistration> = new Map([
      ["discord", { version: 2, render: renderDiscordEvent }],
    ]);

    const result = sweepRenderedEvents(db, settings, { renderers });

    expect(result).toMatchObject({ examined: 1, unchanged: 1, remaining: 0, caughtUp: true });
    expect(sweepState()).toEqual({ version: 2, last_event_id: eventId });
  });

  it("counts malformed and untitled rows while advancing past them", () => {
    insertDiscordEvent({ sourceId: "malformed", content: null, rawData: "not json" });
    insertDiscordEvent({
      sourceId: "untitled",
      title: null,
      content: "body",
      rawData: { content: "body", edited_timestamp: null },
    });
    const processedId = insertDiscordEvent({
      sourceId: "forward",
      content: null,
      rawData: {
        ...discordRawData(""),
        message_snapshots: [{ message: { content: "Recovered after failures" } }],
      },
    });

    const result = sweepRenderedEvents(db, settings);

    expect(result).toMatchObject({
      examined: 3,
      changed: 1,
      failed: 2,
      invalidRawData: 1,
      nullTitle: 1,
      remaining: 0,
      caughtUp: true,
    });
    expect(sweepState()).toEqual({ version: 1, last_event_id: processedId });
    expect(db.prepare("SELECT content FROM events WHERE source_id = 'forward'").get()).toEqual({
      content: "Recovered after failures",
    });
  });

  it("leaves events and watermarks untouched in dry-run mode", () => {
    insertDiscordEvent({
      sourceId: "dry-run",
      content: null,
      rawData: {
        ...discordRawData(""),
        message_snapshots: [{ message: { content: "Would recover" } }],
      },
    });

    const result = sweepRenderedEvents(db, { ...settings, dryRun: true });

    expect(result).toMatchObject({ changed: 1, remaining: 1, caughtUp: false });
    expect(db.prepare("SELECT content FROM events WHERE source_id = 'dry-run'").get()).toEqual({
      content: null,
    });
    expect(sweepState()).toBeNull();
  });

  it("does no work immediately after catching up", () => {
    insertDiscordEvent({ sourceId: "once", content: "current", rawData: discordRawData("current") });
    sweepRenderedEvents(db, settings);

    expect(sweepRenderedEvents(db, settings)).toMatchObject({
      examined: 0,
      changed: 0,
      unchanged: 0,
      failed: 0,
      remaining: 0,
      caughtUp: true,
    });
  });

  it("validates dry-run and time-budget settings", () => {
    expect(parseRenderSweepSettings()).toEqual({ dryRun: false, timeBudgetMs: 60_000 });
    expect(parseRenderSweepSettings({ dry_run: true, time_budget_ms: 1 })).toEqual({
      dryRun: true,
      timeBudgetMs: 1,
    });
    expect(parseRenderSweepSettings({ dry_run: "yes" })).toBe("invalid dry_run setting");
    expect(parseRenderSweepSettings({ time_budget_ms: 0 })).toBe("invalid time_budget_ms setting");
  });
});
