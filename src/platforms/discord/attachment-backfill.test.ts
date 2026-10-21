import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../../db/schema";
import {
  backfillDiscordAttachments,
  findDiscordRecoverySet,
  findUntrackedDiscordSnapshotAttachments,
  HttpError,
  seedDiscordSnapshotAttachments,
  type BackfillCandidate,
  type BackfillDeps,
  type DownloadFn,
  type LocalPresence,
  type RefreshFn,
} from "./attachment-backfill";

function cand(id: number): BackfillCandidate {
  return {
    attachmentId: id,
    discordId: `d${id}`,
    channelId: "chan",
    url: `https://cdn.discordapp.com/attachments/chan/${id}/f.png`,
    filename: "f.png",
    fileSize: 5,
  };
}

function cands(n: number): BackfillCandidate[] {
  return Array.from({ length: n }, (_, i) => cand(i + 1));
}

/** Stub deps; capture what the sink records. `refresh`/`download` overridable. */
function makeDeps(overrides: { refresh?: RefreshFn; download?: DownloadFn } = {}) {
  const stored: number[] = [];
  const unrecoverable: number[] = [];
  const deps: BackfillDeps = {
    refresh: overrides.refresh ?? (async (urls) => new Map(urls.map((u) => [u, `${u}#fresh`]))),
    download: overrides.download ?? (async () => Buffer.from("bytes")),
    store: async (c) => ({
      hash: `h${c.attachmentId}`,
      storagePath: `discord/chan/${c.discordId}/f.png`,
      fileSize: 5,
      deduplicated: false,
    }),
    sink: {
      recordStored: (c) => stored.push(c.attachmentId),
      recordUnrecoverable: (ids) => unrecoverable.push(...ids),
    },
  };
  return { deps, stored, unrecoverable };
}

const FAST = { retryBaseMs: 1 } as const;

describe("backfillDiscordAttachments", () => {
  test("recovers every candidate on the happy path", async () => {
    const { deps, stored, unrecoverable } = makeDeps();
    const r = await backfillDiscordAttachments(cands(3), deps, FAST);
    expect(r.recovered).toBe(3);
    expect(r.unrecoverable).toBe(0);
    expect(r.aborted).toBe(false);
    expect(stored).toEqual([1, 2, 3]);
    expect(unrecoverable).toEqual([]);
  });

  test("tombstones an isolated deletion sandwiched between successes", async () => {
    // Candidate 2's object is gone (404); 1 and 3 recover. The later success
    // flushes 2's buffered tombstone.
    const { deps, stored, unrecoverable } = makeDeps({
      download: async (url) => {
        if (url.includes("/2/")) throw new HttpError(404);
        return Buffer.from("x");
      },
    });
    const r = await backfillDiscordAttachments(cands(3), deps, FAST);
    expect(r.recovered).toBe(2);
    expect(stored).toEqual([1, 3]);
    expect(r.unrecoverable).toBe(1);
    expect(unrecoverable).toEqual([2]);
  });

  test("flushes a trailing deletion at clean completion", async () => {
    const { deps, unrecoverable } = makeDeps({
      download: async (url) => {
        if (url.includes("/3/")) throw new HttpError(404);
        return Buffer.from("x");
      },
    });
    const r = await backfillDiscordAttachments(cands(3), deps, FAST);
    expect(r.recovered).toBe(2);
    expect(r.unrecoverable).toBe(1);
    expect(unrecoverable).toEqual([3]);
  });

  test("a cluster of deletions aborts WITHOUT tombstoning anything", async () => {
    // Every object reports gone — a systemic signal. The breaker must bail and
    // leave the buffered tombstones unwritten so a recoverable corpus isn't
    // marked dead by, say, a lost-access blip.
    const { deps, unrecoverable } = makeDeps({ download: async () => { throw new HttpError(403); } });
    const r = await backfillDiscordAttachments(cands(10), deps, { ...FAST, maxConsecutiveFailures: 5 });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toMatch(/consecutive/);
    expect(r.recovered).toBe(0);
    expect(r.unrecoverable).toBe(0);
    expect(unrecoverable).toEqual([]);
  });

  test("a 401 from refresh-urls aborts immediately, marking nothing", async () => {
    const { deps, stored, unrecoverable } = makeDeps({ refresh: async () => { throw new HttpError(401); } });
    const r = await backfillDiscordAttachments(cands(4), deps, FAST);
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toMatch(/401/);
    expect(r.recovered).toBe(0);
    expect(stored).toEqual([]);
    expect(unrecoverable).toEqual([]);
  });

  test("retries a transient error and then recovers", async () => {
    let attempts = 0;
    const { deps, stored } = makeDeps({
      download: async () => {
        attempts++;
        if (attempts === 1) throw new HttpError(503); // transient: retried
        return Buffer.from("x");
      },
    });
    const r = await backfillDiscordAttachments(cands(1), deps, { ...FAST, retryMax: 3 });
    expect(r.recovered).toBe(1);
    expect(stored).toEqual([1]);
    expect(attempts).toBe(2);
  });

  test("honors a 429 Retry-After before retrying", async () => {
    let attempts = 0;
    const { deps, stored } = makeDeps({
      download: async () => {
        attempts++;
        if (attempts === 1) throw new HttpError(429, "rate limited", 40); // server says wait 40ms
        return Buffer.from("x");
      },
    });
    const start = Date.now();
    const r = await backfillDiscordAttachments(cands(1), deps, { retryBaseMs: 1, retryMax: 2 });
    const elapsed = Date.now() - start;
    expect(r.recovered).toBe(1);
    expect(stored).toEqual([1]);
    // The 40ms server window was honored, not the 1ms exponential base.
    expect(elapsed).toBeGreaterThanOrEqual(35);
  });

  test("a persistent transient failure is left for re-run, never tombstoned", async () => {
    const { deps, unrecoverable } = makeDeps({ download: async () => { throw new HttpError(500); } });
    const r = await backfillDiscordAttachments(cands(2), deps, {
      ...FAST,
      retryMax: 1,
      maxConsecutiveFailures: 10,
    });
    expect(r.recovered).toBe(0);
    expect(r.transientFailures).toBe(2);
    expect(r.unrecoverable).toBe(0);
    expect(unrecoverable).toEqual([]);
    expect(r.aborted).toBe(false);
  });

  test("treats a URL omitted by refresh-urls as gone", async () => {
    // refresh-urls returns nothing for candidate 2 → permanent.
    const { deps, unrecoverable } = makeDeps({
      refresh: async (urls) => new Map(urls.filter((u) => !u.includes("/2/")).map((u) => [u, `${u}#fresh`])),
    });
    const r = await backfillDiscordAttachments(cands(3), deps, FAST);
    expect(r.recovered).toBe(2);
    expect(unrecoverable).toEqual([2]);
  });

  test("rejects an invalid concurrency", async () => {
    const { deps } = makeDeps();
    await expect(backfillDiscordAttachments(cands(1), deps, { concurrency: 0 })).rejects.toThrow(/concurrency/);
  });
});

describe("findDiscordRecoverySet", () => {
  // The breaker's "unbroken streak = systemic" premise only holds if correlated
  // failures are contiguous, so the query must order by guild → channel → id.
  test("orders candidates by guild, then channel, then id", async () => {
    const db = new Database(":memory:");
    initDb(db);
    // (label, channelId, guildId|null) inserted in a scrambled order; ids are
    // assigned in insertion order, so within a channel they sort by insertion.
    const seed: [string, string, string | null][] = [
      ["A", "c2", "g1"],
      ["B", "c1", "g2"],
      ["C", "c1", "g1"],
      ["D", "c2", "g1"],
      ["E", "c9", null], // a DM — no guild, sorts first (NULL)
    ];
    for (const [label, channelId, guildId] of seed) {
      const channel = guildId ? { id: channelId, guild_id: guildId } : { id: channelId };
      const { id: eventId } = db
        .query("INSERT INTO events (source, type, raw_data) VALUES ('discord', 'message:dm', ?) RETURNING id")
        .get(JSON.stringify({ _channel: channel })) as { id: number };
      db.query(
        "INSERT INTO attachments (event_id, source, source_id, original_uri, filename, status) VALUES (?, 'discord', ?, ?, 'f.png', 'stored')",
      ).run(eventId, label, `https://cdn.discordapp.com/attachments/${channelId}/${label}/f.png`);
    }

    const local: LocalPresence = { hasHash: async () => false }; // nothing local, nothing in R2
    const candidates = await findDiscordRecoverySet(db, local, null);
    db.close();

    expect(candidates.map((c) => c.discordId)).toEqual(["E", "C", "A", "D", "B"]);
  });
});

describe("Discord forwarded snapshot registration", () => {
  test("registers untracked snapshot attachments idempotently", () => {
    const db = new Database(":memory:");
    initDb(db);
    const rawData = {
      _channel: { id: "channel-1" },
      message_snapshots: [{
        message: {
          attachments: [
            {
              id: "already-tracked",
              filename: "existing.png",
              size: 10,
              url: "https://cdn.discordapp.com/attachments/channel-1/already-tracked/existing.png",
              content_type: "image/png",
            },
            {
              id: "snapshot-file",
              filename: "photo.jpg",
              size: 1234,
              url: "https://cdn.discordapp.com/attachments/channel-1/snapshot-file/photo.jpg",
              content_type: "image/jpeg",
              width: 800,
              height: 600,
            },
          ],
        },
      }],
    };
    const { id: eventId } = db
      .query("INSERT INTO events (source, type, raw_data) VALUES ('discord', 'message:group:forward', ?) RETURNING id")
      .get(JSON.stringify(rawData)) as { id: number };
    db.query(
      "INSERT INTO attachments (event_id, source, source_id, original_uri) VALUES (?, 'discord', 'already-tracked', ?)",
    ).run(
      eventId,
      "https://cdn.discordapp.com/attachments/channel-1/already-tracked/existing.png",
    );

    const untracked = findUntrackedDiscordSnapshotAttachments(db);
    expect(untracked).toEqual([{
      eventId,
      discordId: "snapshot-file",
      url: "https://cdn.discordapp.com/attachments/channel-1/snapshot-file/photo.jpg",
      filename: "photo.jpg",
      fileSize: 1234,
      contentType: "image/jpeg",
      width: 800,
      height: 600,
    }]);

    expect(seedDiscordSnapshotAttachments(db, untracked)).toBe(1);
    expect(seedDiscordSnapshotAttachments(db, untracked)).toBe(0);
    expect(findUntrackedDiscordSnapshotAttachments(db)).toEqual([]);
    expect(db.query(
      "SELECT source, source_id, filename, mime_type, file_size, width, height, status FROM attachments WHERE event_id = ? AND source_id = 'snapshot-file'",
    ).get(eventId)).toEqual({
      source: "discord",
      source_id: "snapshot-file",
      filename: "photo.jpg",
      mime_type: "image/jpeg",
      file_size: 1234,
      width: 800,
      height: 600,
      status: "pending",
    });
    db.close();
  });
});
