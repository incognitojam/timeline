import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deleteSyncState, getAppStateDb, getSyncState } from "../../db/app-state";
import { getDb, initDb } from "../../db/schema";
import { EVENT_SOURCE } from "./parser";
import { googleMessagesSyncSource, MEDIA_STAGING_PREFIX, SYNC_OVERLAP_MS, type GoogleMessagesSyncState } from "./sync";

// Ofcom drama-range numbers, one per fixture conversation.
const CONTACT_NUMBERS: Record<string, string> = { "1": "+447700900001", "2": "+447700900002" };

const CONVERSATION = (id: string) => ({
  kind: "conversation",
  id,
  folder: "INBOX",
  is_group: false,
  type: "SMS",
  participants: [
    { participant_id: "1", number: "+447700900000", is_me: true, visible: true },
    { participant_id: "2", number: CONTACT_NUMBERS[id], name: `Contact ${id}`, is_me: false, visible: true },
  ],
});
const MESSAGE = (id: string, conversationId: string) => ({
  kind: "message",
  id,
  conversation_id: conversationId,
  timestamp_ms: Date.UTC(2026, 5, 1),
  direction: "incoming",
  message_type: "sms",
  sender_participant_id: "2",
  text: "hi",
});

/** An MMS whose photo the fake sidecar "downloads" into the media dir it is given (`__MEDIA__` is substituted). */
const MMS_WITH_PHOTO = {
  ...MESSAGE("101", "1"),
  message_type: "mms",
  text: "",
  media: [{ media_id: "m1", name: "photo.jpg", mime_type: "image/jpeg", width: 4, height: 3, status: "stored", path: "__MEDIA__/m1-photo.jpg" }],
};

/** Conversation 1 completes; conversation 2 is either completed, failed, or followed by a broken line. */
function fixture(second: "done" | "error" | "corrupt"): string {
  const records: unknown[] = [CONVERSATION("1"), MESSAGE("100", "1"), MMS_WITH_PHOTO, { kind: "conversation_done", id: "1", messages: 2 }, CONVERSATION("2"), MESSAGE("200", "2")];
  if (second === "done") records.push({ kind: "conversation_done", id: "2", messages: 1 });
  if (second === "error") records.push({ kind: "conversation_error", id: "2", error: "connection reset by peer" });
  const lines = records.map((r) => JSON.stringify(r));
  if (second === "corrupt") lines.push("{not json");
  return `${lines.join("\n")}\n`;
}

describe("google-messages sync source", () => {
  let dir: string;
  let binary: string;
  let argsLog: string;
  let stdinLog: string;
  let priorMediaPath: string | undefined;

  beforeEach(() => {
    dir = join(tmpdir(), `gmessages-sync-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    binary = join(dir, "fake-gmessages");
    argsLog = join(dir, "args.txt");
    stdinLog = join(dir, "stdin.txt");
    writeFileSync(join(dir, "fixture.jsonl"), fixture("done"));
    // Fake sidecar: records its arguments and the cursor map it was given on
    // stdin, writes one "downloaded" photo into the -media directory, then
    // replays fixture.jsonl. GMESSAGES_FAKE_FAIL exits non-zero;
    // GMESSAGES_FAKE_LINGER keeps running after its output, which a real
    // sidecar does when nobody drains stdout.
    writeFileSync(
      binary,
      [
        "#!/bin/sh",
        `echo "$@" >> "${argsLog}"`,
        `cat > "${stdinLog}"`,
        'if [ "$GMESSAGES_FAKE_FAIL" = "1" ]; then echo "boom" >&2; exit 3; fi',
        'MEDIA=""; while [ $# -gt 0 ]; do if [ "$1" = "-media" ]; then MEDIA="$2"; fi; shift; done',
        'printf "jpeg bytes" > "$MEDIA/m1-photo.jpg"',
        `sed "s#__MEDIA__#$MEDIA#g" "${join(dir, "fixture.jsonl")}"`,
        'if [ "$GMESSAGES_FAKE_LINGER" = "1" ]; then trap \'kill $!; exit 143\' TERM; sleep 20 & wait $!; fi',
        "",
      ].join("\n"),
    );
    chmodSync(binary, 0o755);
    const db = getDb();
    initDb(db);
    db.prepare("DELETE FROM events WHERE source = ?").run(EVENT_SOURCE);
    db.close();
    deleteSyncState(getAppStateDb(), EVENT_SOURCE);
    mkdirSync(join(dir, "media-root"));
    priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
    process.env.TIMELINE_MEDIA_PATH = join(dir, "media-root");
  });

  afterEach(() => {
    if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
    else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
    rmSync(dir, { recursive: true, force: true });
    delete process.env.GMESSAGES_FAKE_FAIL;
    delete process.env.GMESSAGES_FAKE_LINGER;
  });

  const config = () => ({ account: "Owner", binary, state_dir: dir });
  const options = () => ({ verbose: false, config: { sources: { [EVENT_SOURCE]: config() } } });
  const state = () => getSyncState<GoogleMessagesSyncState>(getAppStateDb(), EVENT_SOURCE);
  const sentCursors = () => JSON.parse(readFileSync(stdinLog, "utf8")) as Record<string, number>;

  it("refuses to sync without an account, binary, or pairing", async () => {
    expect(await googleMessagesSyncSource.canSync({})).toMatch(/account/);
    expect(await googleMessagesSyncSource.canSync({ account: "Owner", binary: join(dir, "missing"), state_dir: dir })).toMatch(/not found/);
    expect(await googleMessagesSyncSource.canSync(config())).toMatch(/Not paired/);
    writeFileSync(join(dir, "session.json"), "{}");
    expect(await googleMessagesSyncSource.canSync(config())).toBeNull();
  });

  it("imports the sidecar output and advances one cursor per completed conversation", async () => {
    const before = Date.now();
    const first = await googleMessagesSyncSource.sync(options());
    expect(first).toMatchObject({ success: true, eventsAdded: 3, metadata: { conversationsDone: 2, resumedConversations: 0, attachmentsStored: 1 } });
    const args = readFileSync(argsLog, "utf8").trim();
    expect(args).toMatch(new RegExp(`^dump -folder all -cursors - -media ${dir}/${MEDIA_STAGING_PREFIX}\\S+$`));
    expect(sentCursors()).toEqual({});
    // The staging directory lives only for the run.
    expect(readdirSync(dir).filter((entry) => entry.startsWith(MEDIA_STAGING_PREFIX))).toEqual([]);

    const after = state();
    if (!after) throw new Error("expected sync state");
    expect(Object.keys(after.conversations).sort()).toEqual(["1", "2"]);
    expect(after.conversations["1"]).toBeGreaterThanOrEqual(before);

    const second = await googleMessagesSyncSource.sync(options());
    expect(second).toMatchObject({ success: true, eventsAdded: 0, metadata: { skipped: 3, resumedConversations: 2, attachmentsStored: 1 } });
    expect(sentCursors()).toEqual({ "1": after.conversations["1"] - SYNC_OVERLAP_MS, "2": after.conversations["2"] - SYNC_OVERLAP_MS });

    const db = getDb();
    const row = db.prepare("SELECT type, people FROM events WHERE source = ? AND source_id = '100'").get(EVENT_SOURCE) as { type: string; people: string };
    const attachment = db
      .prepare("SELECT a.status, a.storage_path, a.mime_type, a.width FROM attachments a JOIN events e ON e.id = a.event_id WHERE e.source = ? AND e.source_id = '101'")
      .all(EVENT_SOURCE) as Array<{ status: string; storage_path: string; mime_type: string; width: number }>;
    db.close();
    expect(row.type).toBe("sms:received");
    expect(JSON.parse(row.people)).toEqual(["phone:+447700900001", "phone:+447700900000"]);
    expect(attachment).toEqual([{ status: "stored", storage_path: "google-messages/+447700900001/m1-photo.jpg", mime_type: "image/jpeg", width: 4 }]);
    expect(existsSync(join(dir, "media-root", "google-messages/+447700900001/m1-photo.jpg"))).toBe(true);
  });

  it("sweeps a staging directory an earlier run left behind", async () => {
    const stale = join(dir, `${MEDIA_STAGING_PREFIX}stale`);
    mkdirSync(stale);
    writeFileSync(join(stale, "leftover.bin"), "x");
    const result = await googleMessagesSyncSource.sync(options());
    expect(result.success).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it("keeps the cursor of a conversation the sidecar could not fully page", async () => {
    writeFileSync(join(dir, "fixture.jsonl"), fixture("error"));
    const result = await googleMessagesSyncSource.sync(options());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/1 conversation\(s\) could not be fully paged.*: 2/);
    expect(result.eventsAdded).toBe(3); // messages fetched before the failure are kept
    expect(Object.keys(state()?.conversations ?? {})).toEqual(["1"]);
  });

  it("keeps cursors persisted before an interruption and kills the lingering sidecar", async () => {
    writeFileSync(join(dir, "fixture.jsonl"), fixture("corrupt"));
    process.env.GMESSAGES_FAKE_LINGER = "1";
    const started = Date.now();
    const result = await googleMessagesSyncSource.sync(options());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid Google Messages JSONL/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Conversation 1 completed before the bad line, so the next run resumes past it.
    expect(Object.keys(state()?.conversations ?? {})).toEqual(["1"]);
  });

  it("reports a failing sidecar with its stderr", async () => {
    process.env.GMESSAGES_FAKE_FAIL = "1";
    const result = await googleMessagesSyncSource.sync(options());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exited with code 3: boom/);
    expect(state()).toBeNull();
  });
});
