/**
 * The T3 Code import holds the write lock only to write what changed, in short
 * transactions, so a failed run must leave a state the next run can finish.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_BOUNDED_WRITER_LIMITS } from "../../db/bounded-writes";
import { withBulkSummaryRebuild } from "../../db/bulk-summary-rebuild";
import { wrapDatabase } from "../../db/pool";
import { initDb } from "../../db/schema";
import { getStats } from "../../db/stats";
import { createT3CodeV2Fixture, FIXTURE, insertMessage, insertTurnItem } from "./fixtures/statev2-fixture";
import { importT3Code, T3ImportError } from "./parser";

const ONE_ROW_AT_A_TIME = { ...DEFAULT_BOUNDED_WRITER_LIMITS, maxQueuedWrites: 1, pauseMs: 0, maxBusyMs: 0 };

describe("importT3Code bounded writes", () => {
  let root: string;
  let dbPath: string;
  let db: Database;
  let t3Path: string;
  let priorMediaPath: string | undefined;

  beforeEach(async () => {
    root = join(tmpdir(), `t3code-resume-${randomUUID()}`);
    await mkdir(join(root, "attachments"), { recursive: true });
    priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
    process.env.TIMELINE_MEDIA_PATH = join(root, "media");
    await writeFile(join(root, "attachments", `${FIXTURE.image.id}.png`), FIXTURE.image.bytes);
    t3Path = join(root, "statev2.sqlite");
    createT3CodeV2Fixture(t3Path).close();
    dbPath = join(root, "timeline.db");
    db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 30000");
    initDb(db);
  });

  afterEach(async () => {
    db.close();
    if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
    else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
    await rm(root, { recursive: true, force: true });
  });

  const snapshot = (target: Database) => ({
    events: target.prepare("SELECT source_id, title, content, people, tags, raw_data, conversation_id FROM events ORDER BY source_id").all(),
    attachments: target.prepare("SELECT source_id, content_hash, status FROM attachments ORDER BY source_id").all(),
    superseded: target.prepare("SELECT source, source_account, conversation_id, reason, canonical_conversation_id FROM superseded_conversations ORDER BY 1, 2, 3").all(),
    identities: target.prepare("SELECT platform, platform_id FROM identities ORDER BY 1, 2").all(),
    summaries: target.prepare("SELECT source, source_account, conversation_id, title, message_count, first_message, last_message FROM conversation_summaries ORDER BY 1, 2, 3").all(),
    titles: target.prepare("SELECT source, conversation_id, title FROM conversation_summary_titles ORDER BY 1, 2, 3").all(),
    projects: target.prepare("SELECT source, conversation_id, project FROM coding_agent_conversations ORDER BY 1, 2").all(),
  });

  /** What a single uninterrupted import of the same source produces. */
  async function cleanImport(account = "alice") {
    const clean = new Database(":memory:");
    initDb(clean);
    await importT3Code(clean, t3Path, account);
    const result = snapshot(clean);
    clean.close();
    return result;
  }

  function failOnEvent(sourceId: string) {
    db.exec(`CREATE TRIGGER fail_on_event BEFORE INSERT ON events WHEN NEW.source_id = '${sourceId}'
      BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
  }

  it("finishes a first import that died halfway", async () => {
    const probe = new Database(":memory:");
    initDb(probe);
    await importT3Code(probe, t3Path, "alice");
    const rows = probe.prepare("SELECT source_id AS sourceId FROM events ORDER BY id").all() as { sourceId: string }[];
    probe.close();
    const { sourceId } = rows[Math.floor(rows.length / 2)];

    failOnEvent(sourceId);
    await expect(importT3Code(db, t3Path, "alice", { writeLimits: ONE_ROW_AT_A_TIME })).rejects.toThrow("simulated crash");
    const committed = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    expect(committed).toBeGreaterThan(0);
    db.exec("DROP TRIGGER fail_on_event");

    await importT3Code(db, t3Path, "alice", { writeLimits: ONE_ROW_AT_A_TIME });
    expect(snapshot(db)).toEqual(await cleanImport());
  });

  it("counts every committed write across batches, and each write once after a retry", async () => {
    const added = (stats: { messages: number; toolCalls: number; plans: number; reasoning: number }) =>
      stats.messages + stats.toolCalls + stats.plans + stats.reasoning;
    const stored = () => (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

    db.exec(`CREATE TRIGGER fail_on_identity BEFORE INSERT ON identities
      WHEN (SELECT COUNT(*) FROM identities WHERE platform = 't3code') >= 1
      BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
    const failure = await importT3Code(db, t3Path, "alice", { writeLimits: ONE_ROW_AT_A_TIME }).catch((error) => error);
    expect(failure).toBeInstanceOf(T3ImportError);
    const partial = (failure as T3ImportError).stats;
    expect(added(partial)).toBe(stored());
    expect(partial.identitiesUpserted).toBe(1);
    expect(partial.writeTransactions).toBe(stored() + partial.supersededConversations + 1);
    expect(partial.supersededConversations).toBeGreaterThan(0);
    db.exec("DROP TRIGGER fail_on_identity");

    const retry = await importT3Code(db, t3Path, "alice", { writeLimits: ONE_ROW_AT_A_TIME });
    expect(added(retry)).toBe(0);
    expect(retry.identitiesUpserted).toBeGreaterThan(0);
    expect(snapshot(db)).toEqual(await cleanImport());
  });

  it("finishes a rename that died halfway, from the cursor it started with", async () => {
    const first = await importT3Code(db, t3Path, "alice");
    const later = new Date(Date.parse(first.cursor ?? "") + 3_600_000).toISOString();
    const t3 = new Database(t3Path);
    t3.prepare("UPDATE orchestration_v2_projection_threads SET title = 'Renamed', updated_at = ? WHERE thread_id = ?").run(later, FIXTURE.threads.main);
    t3.close();

    const titled = () => (db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE conversation_id = ? AND title LIKE '%Renamed%'"
    ).get(FIXTURE.threads.main) as { n: number }).n;
    const total = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE conversation_id = ?").get(FIXTURE.threads.main) as { n: number }).n;
    expect(total).toBeGreaterThan(2);

    const victim = db.prepare("SELECT source_id FROM events WHERE conversation_id = ? ORDER BY id DESC").get(FIXTURE.threads.main) as { source_id: string };
    db.exec(`CREATE TRIGGER fail_on_update BEFORE UPDATE ON events WHEN NEW.source_id = '${victim.source_id}'
      BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
    await expect(importT3Code(db, t3Path, "alice", { cursor: first.cursor, writeLimits: ONE_ROW_AT_A_TIME })).rejects.toThrow("simulated crash");
    expect(titled()).toBeGreaterThan(0);
    expect(titled()).toBeLessThan(total);
    db.exec("DROP TRIGGER fail_on_update");

    const resumed = await importT3Code(db, t3Path, "alice", { cursor: first.cursor, writeLimits: ONE_ROW_AT_A_TIME });
    expect(titled()).toBe(total);
    expect(resumed.refreshed).toBeLessThan(total);
    expect(snapshot(db)).toEqual(await cleanImport());
  });

  it("keeps an image attached when the run dies before its row lands", async () => {
    db.exec(`CREATE TRIGGER fail_on_attachment BEFORE INSERT ON attachments
      BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
    await expect(importT3Code(db, t3Path, "alice", { writeLimits: ONE_ROW_AT_A_TIME })).rejects.toThrow("simulated crash");
    db.exec("DROP TRIGGER fail_on_attachment");

    await importT3Code(db, t3Path, "alice", { writeLimits: ONE_ROW_AT_A_TIME });
    expect(snapshot(db).attachments).toHaveLength(1);
    expect(snapshot(db)).toEqual(await cleanImport());
  });

  it("matches a summary rebuild after batched writes", async () => {
    await importT3Code(db, t3Path, "alice", { writeLimits: ONE_ROW_AT_A_TIME });
    const before = snapshot(db).summaries;
    expect(before.length).toBeGreaterThan(0);
    await withBulkSummaryRebuild(db, () => undefined);
    expect(snapshot(db).summaries).toEqual(before);
  });

  it("re-reading everything takes no write lock when nothing changed", async () => {
    await importT3Code(db, t3Path, "alice");
    const before = snapshot(db);

    const holder = new Database(dbPath);
    holder.exec("BEGIN IMMEDIATE");
    const again = await importT3Code(db, t3Path, "alice", {
      writeLimits: { ...DEFAULT_BOUNDED_WRITER_LIMITS, acquireTimeoutMs: 0 },
    });
    holder.exec("ROLLBACK");
    holder.close();

    expect(again.writeTransactions).toBe(0);
    expect(again.refreshed).toBe(0);
    expect(snapshot(db)).toEqual(before);
  });

  it("repairs missing and stale identities even when no event changed", async () => {
    await importT3Code(db, t3Path, "alice");
    const before = snapshot(db).identities;
    db.exec("DELETE FROM identities WHERE platform = 't3code' AND platform_id = 'alice'");
    db.exec("UPDATE identities SET display_name = 'Stale' WHERE platform = 't3code'");
    const again = await importT3Code(db, t3Path, "alice");
    expect(again.refreshed).toBe(0);
    expect(again.identitiesUpserted).toBe(before.length);
    expect(snapshot(db).identities).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM identities WHERE display_name = 'Stale'").get()).toEqual({ n: 0 });

    const settled = await importT3Code(db, t3Path, "alice");
    expect(settled.writeTransactions).toBe(0);
  });

  it("commits superseded rows and identities in bounded transactions", async () => {
    await importT3Code(db, t3Path, "alice");
    db.exec("DELETE FROM superseded_conversations");
    db.exec("DELETE FROM identities WHERE platform = 't3code'");
    const limits = { ...ONE_ROW_AT_A_TIME, maxHoldMs: 0 };
    const again = await importT3Code(db, t3Path, "alice", { writeLimits: limits });
    expect(again.writeTransactions).toBe(again.supersededConversations + again.identitiesUpserted);
    expect(again.supersededConversations).toBeGreaterThan(0);
  });

  it("settles on the last write when two planned events share an id", async () => {
    const t3 = new Database(t3Path);
    insertMessage(t3, {
      id: "shared-id",
      threadId: FIXTURE.threads.main,
      runId: FIXTURE.runs.claude,
      role: "assistant",
      text: "first payload",
      createdAt: "2026-05-01T10:00:00.000Z",
    });
    insertTurnItem(t3, {
      id: "shared-id",
      threadId: FIXTURE.threads.main,
      runId: FIXTURE.runs.claude,
      type: "proposed_plan",
      status: "completed",
      at: "2026-05-01T10:00:00.000Z",
      fields: { markdown: "last payload", streaming: false },
    });
    t3.close();
    const content = () =>
      db.prepare("SELECT content FROM events WHERE source_id = ?").get(`${FIXTURE.threads.main}:shared-id`);

    await importT3Code(db, t3Path, "alice");
    expect(content()).toEqual({ content: "last payload" });
    await importT3Code(db, t3Path, "alice");
    expect(content()).toEqual({ content: "last payload" });
  });

  it("leaves no stale stats behind a run that died after writing events", async () => {
    await importT3Code(db, t3Path, "alice");
    const read = wrapDatabase(db);
    const cached = (await getStats(read, db)).total_events;
    const t3 = new Database(t3Path);
    insertMessage(t3, {
      id: "late-message",
      threadId: FIXTURE.threads.main,
      runId: FIXTURE.runs.claude,
      role: "assistant",
      text: "After the stats were cached",
      createdAt: "2026-05-03T10:00:00.000Z",
    });
    t3.close();

    db.exec(`CREATE TRIGGER fail_after_events BEFORE INSERT ON identities
      BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
    db.exec("DELETE FROM identities WHERE platform = 't3code'");
    await expect(importT3Code(db, t3Path, "alice", { writeLimits: ONE_ROW_AT_A_TIME })).rejects.toThrow("simulated crash");
    db.exec("DROP TRIGGER fail_after_events");

    expect((await getStats(read, db)).total_events).toBe(cached + 1);
  });

  it("lets another writer in during a long write", async () => {
    const other = new Database(dbPath);
    other.exec("PRAGMA busy_timeout = 0");
    let otherWrites = 0;
    const poll = setInterval(() => {
      other.exec("BEGIN IMMEDIATE");
      other.exec("ROLLBACK");
      otherWrites++;
    }, 0);
    const stats = await importT3Code(db, t3Path, "alice", { writeLimits: ONE_ROW_AT_A_TIME });
    clearInterval(poll);
    other.close();
    expect(stats.writeTransactions).toBeGreaterThan(5);
    expect(otherWrites).toBeGreaterThan(0);
  });
});
