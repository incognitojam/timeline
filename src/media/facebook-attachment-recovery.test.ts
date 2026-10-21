import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { initDb } from "../db/schema";
import { computeHash } from "./storage";
import {
  buildFacebookSource,
  findFacebookRecoverySet,
  recoverFacebookAttachments,
  relativePathForUri,
  type FacebookCandidate,
  type FacebookReadResult,
  type FacebookRecoveryDeps,
  type FacebookStoreFn,
} from "./facebook-attachment-recovery";

function cand(id: number, expectedHash: string | null = null): FacebookCandidate {
  return {
    attachmentId: id,
    originalUri: `messages/inbox/conv/photos/${id}.jpg`,
    relativePath: `conv/${id}.jpg`,
    fileSize: 10,
    expectedHash,
  };
}
const cands = (n: number) => Array.from({ length: n }, (_, i) => cand(i + 1));

// FacebookReadResult builders for the read stub.
const found = (...bufs: Buffer[]): FacebookReadResult => ({ located: bufs.length, candidates: bufs, readErrors: 0 });
const absent: FacebookReadResult = { located: 0, candidates: [], readErrors: 0 };
const unreadable: FacebookReadResult = { located: 1, candidates: [], readErrors: 1 };

function makeDeps(
  read: (uri: string) => Promise<FacebookReadResult>,
  store?: FacebookStoreFn,
): { deps: FacebookRecoveryDeps; stored: number[] } {
  const stored: number[] = [];
  return {
    stored,
    deps: {
      read,
      store:
        store ??
        (async (c) => ({ hash: `h${c.attachmentId}`, storagePath: `facebook/${c.relativePath}`, fileSize: 10, deduplicated: false })),
      sink: { recordStored: (c) => stored.push(c.attachmentId) },
    },
  };
}

describe("recoverFacebookAttachments", () => {
  test("recovers every resolvable candidate", async () => {
    const { deps, stored } = makeDeps(async () => found(Buffer.from("x")));
    const r = await recoverFacebookAttachments(cands(3), deps);
    expect(r.recovered).toBe(3);
    expect(r.notFound).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.aborted).toBe(false);
    expect(stored).toEqual([1, 2, 3]);
  });

  test("tallies not-found (absent from export) without tombstoning or aborting", async () => {
    const { deps, stored } = makeDeps(async (uri) => (uri.includes("/2.jpg") ? absent : found(Buffer.from("x"))));
    const r = await recoverFacebookAttachments(cands(3), deps);
    expect(r.recovered).toBe(2);
    expect(r.notFound).toBe(1);
    expect(r.aborted).toBe(false);
    expect(stored).toEqual([1, 3]); // id 2 left untouched because it was absent from the indexed exports
  });

  test("counts a located-but-unreadable file as readFailed, not notFound", async () => {
    // A corrupt archive / permission error must not masquerade as "absent" (which
    // would imply the file was absent from every indexed export).
    const { deps } = makeDeps(async (uri) => (uri.includes("/2.jpg") ? unreadable : found(Buffer.from("x"))));
    const r = await recoverFacebookAttachments(cands(3), deps);
    expect(r.recovered).toBe(2);
    expect(r.readFailed).toBe(1);
    expect(r.notFound).toBe(0);
  });

  test("aborts on a cluster of read failures (corrupt export / I/O)", async () => {
    const { deps } = makeDeps(async () => unreadable);
    const r = await recoverFacebookAttachments(cands(20), deps, { maxFailures: 5, concurrency: 1 });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toMatch(/read failures/);
  });

  test("aborts once store failures cross the threshold (systemic backend)", async () => {
    const { deps, stored } = makeDeps(
      async () => found(Buffer.from("x")),
      async () => {
        throw new Error("R2 down");
      },
    );
    const r = await recoverFacebookAttachments(cands(20), deps, { maxFailures: 5, concurrency: 1 });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toMatch(/store failures/);
    expect(r.recovered).toBe(0);
    expect(stored).toEqual([]);
  });

  test("refuses to persist bytes that don't reproduce the row's hash (wrong source)", async () => {
    // The resolved file's bytes hash to something other than the recorded hash —
    // a wrong/colliding export. Must not store, and must not even upload.
    let stores = 0;
    const { deps, stored } = makeDeps(
      async () => found(Buffer.from("bytes from the wrong file")),
      async (c) => {
        stores++;
        return { hash: "h", storagePath: `facebook/${c.relativePath}`, fileSize: 10, deduplicated: false };
      },
    );
    const r = await recoverFacebookAttachments([cand(1, "0".repeat(64))], deps);
    expect(r.recovered).toBe(0);
    expect(r.mismatched).toBe(1);
    expect(stored).toEqual([]);
    expect(stores).toBe(0); // skipped the upload entirely
  });

  test("stores when recovered bytes reproduce the recorded hash", async () => {
    const bytes = Buffer.from("the real file");
    const { deps, stored } = makeDeps(async () => found(bytes));
    const r = await recoverFacebookAttachments([cand(1, computeHash(bytes))], deps);
    expect(r.recovered).toBe(1);
    expect(r.mismatched).toBe(0);
    expect(stored).toEqual([1]);
  });

  test("picks the matching copy when a path collides across exports", async () => {
    // Same original_uri resolves to two files (different exports/accounts); only one
    // reproduces the recorded hash. The shadowed-but-correct copy must still win.
    const right = Buffer.from("the right file");
    const wrong = Buffer.from("a different file with the same path");
    const storedBytes: Buffer[] = [];
    const { deps } = makeDeps(
      async () => found(wrong, right),
      async (_c, content) => {
        storedBytes.push(content);
        return { hash: computeHash(content), storagePath: "facebook/x", fileSize: content.length, deduplicated: false };
      },
    );
    const r = await recoverFacebookAttachments([cand(1, computeHash(right))], deps);
    expect(r.recovered).toBe(1);
    expect(r.mismatched).toBe(0);
    expect(storedBytes[0]).toEqual(right);
  });

  test("falls back to a renamed export entry by recorded hash", async () => {
    const bytes = Buffer.from("the same file under a new Facebook path");
    const expectedHash = computeHash(bytes);
    let hashReads = 0;
    const { deps, stored } = makeDeps(async () => absent);
    deps.readHash = async (hash) => {
      hashReads++;
      expect(hash).toBe(expectedHash);
      return found(bytes);
    };

    const r = await recoverFacebookAttachments([cand(1, expectedHash)], deps);
    expect(r.recovered).toBe(1);
    expect(r.notFound).toBe(0);
    expect(hashReads).toBe(1);
    expect(stored).toEqual([1]);
  });

  test("uses hash fallback when an exact-path copy has the wrong bytes", async () => {
    const right = Buffer.from("right");
    const { deps, stored } = makeDeps(async () => found(Buffer.from("wrong")));
    deps.readHash = async () => found(right);

    const r = await recoverFacebookAttachments([cand(1, computeHash(right))], deps);
    expect(r.recovered).toBe(1);
    expect(r.mismatched).toBe(0);
    expect(stored).toEqual([1]);
  });

  test("never uses hash fallback for a hashless pending row", async () => {
    let hashReads = 0;
    const { deps } = makeDeps(async () => absent);
    deps.readHash = async () => {
      hashReads++;
      return found(Buffer.from("unverifiable"));
    };

    const r = await recoverFacebookAttachments([cand(1, null)], deps);
    expect(r.recovered).toBe(0);
    expect(r.notFound).toBe(1);
    expect(hashReads).toBe(0);
  });

  test("aborts on a cluster of hash mismatches (wrong export path)", async () => {
    const { deps } = makeDeps(async () => found(Buffer.from("wrong")));
    const wrong = Array.from({ length: 20 }, (_, i) => cand(i + 1, "0".repeat(64)));
    const r = await recoverFacebookAttachments(wrong, deps, { maxFailures: 5, concurrency: 1 });
    expect(r.aborted).toBe(true);
    expect(r.abortReason).toMatch(/mismatch/);
    expect(r.recovered).toBe(0);
  });

  test("rejects an invalid concurrency", async () => {
    const { deps } = makeDeps(async () => found(Buffer.from("x")));
    await expect(recoverFacebookAttachments(cands(1), deps, { concurrency: 0 })).rejects.toThrow(/concurrency/);
  });
});

const haveZipTools = Boolean(Bun.which("zip") && Bun.which("unzip"));

describe("buildFacebookSource", () => {
  test("resolves extracted-tree files by exact original_uri", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fb-src-"));
    const root = join(dir, "2025");
    const uri = "your_facebook_activity/messages/inbox/conv/photos/1.jpg";
    await mkdir(join(root, "your_facebook_activity/messages/inbox/conv/photos"), { recursive: true });
    await writeFile(join(root, uri), Buffer.from("hello"));

    const source = await buildFacebookSource(dir);
    expect(source.roots).toContain(root);
    expect(source.locate(uri)).toBe(true);
    const hit = await source.read(uri);
    expect(hit.located).toBe(1);
    expect(hit.candidates[0]?.toString()).toBe("hello");
    // Absent paths resolve to nothing — never a wrong file.
    expect(source.locate("your_facebook_activity/messages/inbox/conv/photos/missing.jpg")).toBe(false);
    expect((await source.read("nope/x.jpg")).located).toBe(0);
  });

  test("resolves an extracted OLD-format export (messages/… with no your_facebook_activity)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fb-old-"));
    const root = join(dir, "old-export");
    const uri = "messages/inbox/conv/photos/3.jpg";
    await mkdir(join(root, "messages/inbox/conv/photos"), { recursive: true });
    await writeFile(join(root, uri), Buffer.from("old"));

    const source = await buildFacebookSource(dir);
    expect(source.roots).toContain(root);
    expect(source.locate(uri)).toBe(true);
    expect((await source.read(uri)).candidates[0]?.toString()).toBe("old");
  });

  test.skipIf(!haveZipTools)("resolves older-format paths inside export ZIPs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fb-zip-"));
    // Stage outside the export dir and remove it after zipping, so the only copy
    // of the file is inside the ZIP — exercising the ZIP path in isolation.
    const stage = await mkdtemp(join(tmpdir(), "fb-stage-"));
    await mkdir(join(stage, "messages/inbox/conv/photos"), { recursive: true });
    await writeFile(join(stage, "messages/inbox/conv/photos/2.jpg"), Buffer.from("zipped"));
    await Bun.spawn(["zip", "-rq", join(dir, "export.zip"), "messages"], { cwd: stage }).exited;
    await rm(stage, { recursive: true, force: true });

    const source = await buildFacebookSource(dir);
    expect(source.roots).toEqual([]); // nothing extracted; only the ZIP
    expect(source.zipEntries).toBeGreaterThan(0);
    expect(source.locate("messages/inbox/conv/photos/2.jpg")).toBe(true);
    expect((await source.read("messages/inbox/conv/photos/2.jpg")).candidates[0]?.toString()).toBe("zipped");
  });

  test.skipIf(!haveZipTools)("indexes a renamed ZIP entry by recorded hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fb-hash-"));
    const stage = await mkdtemp(join(tmpdir(), "fb-hash-stage-"));
    const bytes = Buffer.from("same attachment, renamed by a newer export");
    const renamedUri =
      "your_facebook_activity/messages/inbox/conv_123/photos/renamed file.jpg";
    await mkdir(join(stage, "your_facebook_activity/messages/inbox/conv_123/photos"), {
      recursive: true,
    });
    await writeFile(join(stage, renamedUri), bytes);
    await Bun.spawn(
      ["zip", "-rq", join(dir, "export.zip"), "your_facebook_activity"],
      { cwd: stage },
    ).exited;
    await rm(stage, { recursive: true, force: true });

    const candidate = cand(1, computeHash(bytes));
    candidate.fileSize = bytes.length;
    const source = await buildFacebookSource(dir);
    expect(source.locate(candidate.originalUri)).toBe(false);

    const index = await source.indexHashes([candidate]);
    expect(index.targetHashes).toBe(1);
    expect(index.matchedHashes).toBe(1);
    expect(index.matchedEntries).toBe(1);
    expect(source.locateHash(candidate.expectedHash ?? "")).toBe(true);
    const hit = await source.readHash(candidate.expectedHash ?? "");
    expect(hit.located).toBe(1);
    expect(hit.candidates[0]).toEqual(bytes);
  });

  test.skipIf(!haveZipTools)("does not index same-size bytes with the wrong hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fb-hash-wrong-"));
    const stage = await mkdtemp(join(tmpdir(), "fb-hash-wrong-stage-"));
    const expected = Buffer.from("right");
    const wrong = Buffer.from("wrong");
    await mkdir(join(stage, "messages/inbox/conv/photos"), { recursive: true });
    await writeFile(join(stage, "messages/inbox/conv/photos/wrong.jpg"), wrong);
    await Bun.spawn(["zip", "-rq", join(dir, "export.zip"), "messages"], {
      cwd: stage,
    }).exited;
    await rm(stage, { recursive: true, force: true });

    const candidate = cand(1, computeHash(expected));
    candidate.fileSize = expected.length;
    const source = await buildFacebookSource(dir);
    const index = await source.indexHashes([candidate]);
    expect(index.hashedEntries).toBe(1);
    expect(index.matchedHashes).toBe(0);
    expect(source.locateHash(candidate.expectedHash ?? "")).toBe(false);
  });

  test.skipIf(!haveZipTools)("fails fast on a corrupt export ZIP rather than under-indexing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fb-bad-"));
    await writeFile(join(dir, "corrupt.zip"), Buffer.from("PK\x03\x04 not actually a zip"));
    await expect(buildFacebookSource(dir)).rejects.toThrow(/ZIP/i);
  });

  test("fails fast when the export path has no export data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fb-empty-"));
    await expect(buildFacebookSource(dir)).rejects.toThrow(/No Facebook export/);
  });
});

describe("relativePathForUri", () => {
  test("uses the conversation folder for message media", () => {
    expect(relativePathForUri("your_facebook_activity/messages/inbox/conv_123/photos/1.jpg")).toBe("conv_123/1.jpg");
    expect(relativePathForUri("messages/archived_threads/conv_abc/photos/2.png")).toBe("conv_abc/2.png");
    expect(relativePathForUri("messages/e2ee_cutover/conv_e2e/photos/3.jpg")).toBe("conv_e2e/3.jpg");
  });

  test("falls back to unknown/ for non-conversation media", () => {
    expect(relativePathForUri("messages/stickers_used/sticker.png")).toBe("unknown/sticker.png");
  });
});

describe("findFacebookRecoverySet", () => {
  test("covers stored-but-missing rows and pending rows, skips present blobs", async () => {

    const db = new Database(":memory:");
    initDb(db);
    const event = db
      .prepare(
        `INSERT INTO events (source, source_id, source_account, type, timestamp, raw_data, import_batch)
         VALUES ('facebook', 'msg:1:1:0', 'tester', 'message:photo', '2020-01-01T00:00:00Z', '{}', 'b') RETURNING id`,
      )
      .get() as { id: number };

    const insert = db.prepare(
      `INSERT INTO attachments (event_id, source, source_id, filename, status, content_hash, storage_path, original_uri)
       VALUES (?, 'facebook', ?, ?, ?, ?, ?, ?)`,
    );
    // Stored, blob present in R2 — excluded.
    insert.run(event.id, "a.jpg", "a.jpg", "stored", "hash-present", "facebook/conv/a.jpg", "messages/inbox/conv/photos/a.jpg");
    // Stored, blob missing everywhere — candidate via storage_path.
    insert.run(event.id, "b.jpg", "b.jpg", "stored", "hash-missing", "facebook/conv/b.jpg", "messages/inbox/conv/photos/b.jpg");
    // Pending (never stored) — candidate via derived relativePath, no expected hash.
    insert.run(event.id, "c.jpg", "c.jpg", "pending", null, null, "your_facebook_activity/messages/inbox/conv_9/photos/c.jpg");

    const local = { hasHash: async () => false };
    // Only presentHashes participates in the recovery-set scan.
    const remote = {
      presentHashes: async () => new Set(["hash-present"]),
      put: async () => {
        throw new Error("not used by the recovery-set scan");
      },
      has: async () => false,
      get: async () => null,
    };
    const set = await findFacebookRecoverySet(db, local, remote);

    expect(set.map((c: { relativePath: string }) => c.relativePath).sort()).toEqual([
      "conv/b.jpg",
      "conv_9/c.jpg",
    ]);
    const pending = set.find((c: { expectedHash: string | null }) => c.expectedHash === null);
    expect(pending?.originalUri).toBe("your_facebook_activity/messages/inbox/conv_9/photos/c.jpg");
    db.close();
  });
});
