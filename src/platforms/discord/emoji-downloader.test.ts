import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { initDb } from "../../db/schema";
import {
  upsertEmojiRefs,
  downloadPendingEmojis,
  fetchEmojiOnDemand,
} from "./emoji-downloader";

let mediaRoot: string;
let realFetch: typeof fetch;
let priorMediaPath: string | undefined;

function pngBlob(): Blob {
  // 1x1 transparent PNG
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  );
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
}

function gifBlob(): Blob {
  // 1x1 transparent GIF
  const bytes = Buffer.from("R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=", "base64");
  return new Blob([new Uint8Array(bytes)], { type: "image/gif" });
}

beforeEach(() => {
  mediaRoot = mkdtempSync(join(tmpdir(), "emoji-dl-test-"));
  priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
  process.env.TIMELINE_MEDIA_PATH = mediaRoot;
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
  else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
  if (existsSync(mediaRoot)) rmSync(mediaRoot, { recursive: true, force: true });
});

function freshDb(): Database {
  const db = new Database(":memory:");
  initDb(db);
  return db;
}

describe("downloadPendingEmojis", () => {
  test("known-static fetches only .png and marks the row stored", async () => {
    const db = freshDb();
    upsertEmojiRefs(db, [{ id: "100", name: "smile", animated: false }]);

    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(url.toString());
      return new Response(pngBlob(), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await downloadPendingEmojis(db);
    expect(result.stored).toBe(1);
    expect(result.tombstoned).toBe(0);
    expect(result.failed).toBe(0);

    const row = db.prepare(`SELECT * FROM discord_emojis WHERE emoji_id='100'`).get() as {
      status: string;
      ext: string;
      content_hash: string;
      storage_path: string;
      animated: number;
    };
    expect(row.status).toBe("stored");
    expect(row.ext).toBe("png");
    expect(row.animated).toBe(0);
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(mediaRoot, row.storage_path))).toBe(true);
    // Exactly one CDN request — no wasted gif probe for known-static.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(".png");
  });

  test("unknown animated probes gif first then falls back to png on 415", async () => {
    const db = freshDb();
    // Insert via raw SQL to get NULL animated (upsertEmojiRefs would set it
    // from the EmojiRef value).
    db.prepare(
      `INSERT INTO discord_emojis (emoji_id, name, animated, status) VALUES ('150', 'mystery', NULL, 'pending')`,
    ).run();

    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const u = url.toString();
      calls.push(u);
      if (u.endsWith(".gif")) return new Response(null, { status: 415 });
      return new Response(pngBlob(), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await downloadPendingEmojis(db);
    expect(result.stored).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(".gif");
    expect(calls[1]).toContain(".png");

    const row = db.prepare(`SELECT ext, animated FROM discord_emojis WHERE emoji_id='150'`).get() as {
      ext: string;
      animated: number;
    };
    expect(row.ext).toBe("png");
    expect(row.animated).toBe(0);
  });

  test("downloads an animated emoji as gif on the first try", async () => {
    const db = freshDb();
    upsertEmojiRefs(db, [{ id: "200", name: "wave", animated: true }]);

    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(url.toString());
      return new Response(gifBlob(), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await downloadPendingEmojis(db);
    expect(result.stored).toBe(1);
    expect(calls[0]).toContain(".gif");

    const row = db.prepare(`SELECT * FROM discord_emojis WHERE emoji_id='200'`).get() as {
      ext: string;
      animated: number;
    };
    expect(row.ext).toBe("gif");
    expect(row.animated).toBe(1);
  });

  test("404 marks the row tombstoned and skips re-fetching", async () => {
    const db = freshDb();
    upsertEmojiRefs(db, [{ id: "300", name: "deleted", animated: false }]);

    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    let result = await downloadPendingEmojis(db);
    expect(result.tombstoned).toBe(1);

    const row = db.prepare(`SELECT status FROM discord_emojis WHERE emoji_id='300'`).get() as { status: string };
    expect(row.status).toBe("tombstoned");

    // Second pass: nothing pending, no extra fetches
    const before = attempts;
    result = await downloadPendingEmojis(db);
    expect(result.stored + result.tombstoned + result.failed).toBe(0);
    expect(attempts).toBe(before);
  });

  test("transient HTTP errors leave the row pending for retry", async () => {
    const db = freshDb();
    upsertEmojiRefs(db, [{ id: "400", name: "flaky", animated: true }]);

    globalThis.fetch = (async () => {
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;

    const result = await downloadPendingEmojis(db);
    expect(result.failed).toBe(1);

    const row = db.prepare(`SELECT status FROM discord_emojis WHERE emoji_id='400'`).get() as { status: string };
    expect(row.status).toBe("pending");
  });

  test("upsertEmojiRefs preserves the strongest animated signal across calls", () => {
    const db = freshDb();
    type Row = { animated: number | null };

    // null (unknown) → 0 (known static): downgrade unknown to known
    upsertEmojiRefs(db, [{ id: "500", name: "upgrade", animated: null }]);
    expect(
      (db.prepare(`SELECT animated FROM discord_emojis WHERE emoji_id='500'`).get() as Row).animated,
    ).toBeNull();

    upsertEmojiRefs(db, [{ id: "500", name: "upgrade", animated: false }]);
    expect(
      (db.prepare(`SELECT animated FROM discord_emojis WHERE emoji_id='500'`).get() as Row).animated,
    ).toBe(0);

    // 0 → 1: animated wins
    upsertEmojiRefs(db, [{ id: "500", name: "upgrade", animated: true }]);
    expect(
      (db.prepare(`SELECT animated FROM discord_emojis WHERE emoji_id='500'`).get() as Row).animated,
    ).toBe(1);

    // 1 → null: never downgrade once known animated
    upsertEmojiRefs(db, [{ id: "500", name: "upgrade", animated: null }]);
    expect(
      (db.prepare(`SELECT animated FROM discord_emojis WHERE emoji_id='500'`).get() as Row).animated,
    ).toBe(1);
  });
});

describe("fetchEmojiOnDemand", () => {
  test("inserts a pending row, downloads, and reports stored", async () => {
    const db = freshDb();
    globalThis.fetch = (async (url: string | URL) => {
      if (url.toString().endsWith(".png")) return new Response(pngBlob(), { status: 200 });
      return new Response(null, { status: 415 });
    }) as unknown as typeof fetch;

    const result = await fetchEmojiOnDemand(db, "777");
    expect(result.status).toBe("stored");

    const row = db.prepare(`SELECT status FROM discord_emojis WHERE emoji_id='777'`).get() as { status: string };
    expect(row.status).toBe("stored");
  });

  test("short-circuits without re-fetching when the row is already stored", async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO discord_emojis (emoji_id, name, animated, ext, status, storage_path, content_hash)
       VALUES ('888', 'cached', 0, 'png', 'stored', 'discord/emoji/888.png', 'hash')`,
    ).run();

    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(pngBlob(), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchEmojiOnDemand(db, "888");
    expect(result.status).toBe("stored");
    expect(calls).toBe(0);
  });

  test("short-circuits without re-fetching when the row is tombstoned", async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO discord_emojis (emoji_id, name, animated, status) VALUES ('999', 'gone', NULL, 'tombstoned')`,
    ).run();

    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchEmojiOnDemand(db, "999");
    expect(result.status).toBe("tombstoned");
    expect(calls).toBe(0);
  });
});
