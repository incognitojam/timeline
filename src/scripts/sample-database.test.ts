/**
 * Tests for the database sampler's contact-table copy.
 *
 * Contacts, contact_memories, and identities are tiny reference tables, so the
 * sampler copies them in full (not sampled) to give complete contact/identity
 * resolution in local dev databases. This exercises the real CLI end-to-end:
 * build a source DB, run the sampler as a subprocess, and inspect the output.
 *
 * Uses the real schema (initDb) so the test catches schema drift in the
 * explicit column lists the sampler relies on.
 */

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb } from "../db/schema";

const SCRIPT = new URL("./sample-database.ts", import.meta.url).pathname;

let workDir: string | null = null;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

function persistSourceDb(db: Database, path: string): void {
  // initDb uses uncached prepared statements. close() defers the underlying
  // connection's close until GC finalizes them, so seed in memory to keep its
  // eventual cleanup from checkpointing a WAL while the sampler opens it.
  writeFileSync(path, db.serialize());
  db.close();

  // Exercise WAL sources without retaining a fixture connection to the file.
  const source = new Database(path);
  try {
    source.exec("PRAGMA journal_mode = WAL");
  } finally {
    source.close(true);
  }
}

/** Build a minimal source DB: one linked contact, one unlinked identity. */
function buildSourceDb(path: string): void {
  const db = new Database(":memory:");
  initDb(db);

  db.prepare(
    `INSERT INTO contacts (id, display_name, notes, is_self) VALUES (1, 'Alice', 'best friend', 1)`
  ).run();
  db.prepare(
    `INSERT INTO contact_memories (contact_id, content) VALUES (1, 'likes climbing')`
  ).run();
  // Linked identity: should keep contact_id and get event_count from the sample.
  db.prepare(
    `INSERT INTO identities (platform, platform_id, display_name, contact_id)
     VALUES ('discord', '111', 'Alice', 1)`
  ).run();
  // Unlinked identity with no events: should still be copied (event_count 0).
  db.prepare(
    `INSERT INTO identities (platform, platform_id, display_name)
     VALUES ('discord', '222', 'Bob')`
  ).run();

  // A non-NULL title makes these rows eligible conversation events, so the
  // output DB's conversation_id guard trigger covers the sampler's bulk copy.
  const insertEvent = db.prepare(
    `INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data, conversation_id)
     VALUES ('discord', ?, 'test-account', 'message:dm', '2024-01-01T00:00:00Z', 'Alice', ?, '{}', 'sample-discord-thread')`
  );
  for (let i = 0; i < 3; i++) {
    insertEvent.run(`m${i}`, JSON.stringify(["discord:111"]));
  }

  persistSourceDb(db, path);
}

test("source fixtures release their WAL connections", () => {
  workDir = mkdtempSync(join(tmpdir(), "tl-sample-"));
  const sourcePath = join(workDir, "source.db");
  buildSourceDb(sourcePath);

  const source = new Database(sourcePath);
  try {
    expect(source.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    // Changing journal mode requires exclusive ownership. A deferred fixture
    // close would leave its WAL connection open and fail with SQLITE_BUSY.
    expect(source.query("PRAGMA journal_mode = DELETE").get()).toEqual({
      journal_mode: "delete",
    });
  } finally {
    source.close(true);
  }
});

test("sampler copies contact tables in full and recomputes identity event_count", async () => {
  workDir = mkdtempSync(join(tmpdir(), "tl-sample-"));
  const sourcePath = join(workDir, "source.db");
  const outputPath = join(workDir, "out.db");
  buildSourceDb(sourcePath);

  // --percent=100 keeps the event sample deterministic for the assertions below.
  const proc = Bun.spawn(
    [process.execPath, "run", SCRIPT, sourcePath, outputPath, "--percent=100"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`sampler exited ${code}:\n${stderr}`);
  }

  const out = new Database(outputPath, { readonly: true });
  try {
    // The bulk copy must carry conversation_id (an ALTER TABLE column the
    // explicit column lists once omitted, aborting on the guard trigger).
    expect(
      out.prepare(`SELECT DISTINCT conversation_id FROM events`).all()
    ).toEqual([{ conversation_id: "sample-discord-thread" }]);

    expect(out.prepare(`SELECT id, display_name, notes, is_self FROM contacts`).all()).toEqual([
      { id: 1, display_name: "Alice", notes: "best friend", is_self: 1 },
    ]);
    expect(
      out.prepare(`SELECT contact_id, content FROM contact_memories`).all()
    ).toEqual([{ contact_id: 1, content: "likes climbing" }]);

    // Linked identity keeps its contact_id and gets event_count from the sample.
    expect(
      out
        .prepare(
          `SELECT contact_id, event_count FROM identities WHERE platform = 'discord' AND platform_id = '111'`
        )
        .get()
    ).toEqual({ contact_id: 1, event_count: 3 });

    // Unlinked, event-less identity is copied wholesale (the old subset copy
    // would have dropped it) with a recomputed count of 0.
    expect(
      out
        .prepare(
          `SELECT contact_id, event_count FROM identities WHERE platform = 'discord' AND platform_id = '222'`
        )
        .get()
    ).toEqual({ contact_id: null, event_count: 0 });
  } finally {
    out.close();
  }
});

test("copies legacy bare-date rows without tripping the timestamp guard", async () => {
  workDir = mkdtempSync(join(tmpdir(), "tl-sample-"));
  const sourcePath = join(workDir, "source.db");
  const outputPath = join(workDir, "out.db");

  // A legacy source row from before fix-bare-date-timestamps.ts runs: a
  // bare 'YYYY-MM-DD' timestamp. The INSERT guard is INSERT-only, so insert a
  // valid row then downgrade via UPDATE to reproduce the legacy state. The
  // sampler's bulk INSERT...SELECT must not abort on it.
  const src = new Database(":memory:");
  initDb(src);
  src
    .prepare(
      `INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data)
       VALUES ('amex', 'bare1', 'test-account', 'transaction', '2026-05-04T00:00:00Z', 'legacy', '{}')`
    )
    .run();
  src.prepare(`UPDATE events SET timestamp = '2026-05-04' WHERE source_id = 'bare1'`).run();
  persistSourceDb(src, sourcePath);

  const proc = Bun.spawn(
    [process.execPath, "run", SCRIPT, sourcePath, outputPath, "--percent=100", "--no-contacts"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`sampler exited ${code}:\n${stderr}`);
  }

  const out = new Database(outputPath, { readonly: true });
  try {
    expect(
      (out.prepare(`SELECT timestamp FROM events WHERE source_id = 'bare1'`).get() as {
        timestamp: string;
      }).timestamp
    ).toBe("2026-05-04");
  } finally {
    out.close();
  }
});

test("--no-contacts skips the contact copy but still samples events", async () => {
  workDir = mkdtempSync(join(tmpdir(), "tl-sample-"));
  const sourcePath = join(workDir, "source.db");
  const outputPath = join(workDir, "out.db");
  buildSourceDb(sourcePath);

  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      SCRIPT,
      sourcePath,
      outputPath,
      "--percent=100",
      "--no-contacts",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`sampler exited ${code}:\n${stderr}`);
  }

  const out = new Database(outputPath, { readonly: true });
  try {
    const count = (table: string) =>
      (out.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;

    // Events are still sampled — the flag only affects the contact tables.
    expect(count("events")).toBe(3);
    // All three reference tables are left empty.
    expect(count("contacts")).toBe(0);
    expect(count("contact_memories")).toBe(0);
    expect(count("identities")).toBe(0);
  } finally {
    out.close();
  }
});
