import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getDb, initDb } from "../../db/schema";
import { runSourceOnce } from "../../sync/once";
import { EVENT_SOURCE } from "./parser";
import type { CallsRecording } from "./shared/recording";
import { callRecordingsSyncSource, runCalls } from "./sync";

describe("call-recordings sync source", () => {
  let dir: string;
  let command: string;

  const record = (id: string, sha1: string, fingerprint: string, caller: Partial<CallsRecording> = {}): CallsRecording => ({
    id,
    sha1,
    source: "phone",
    start: "2026-06-02T18:00:00+01:00",
    end: "2026-06-02T18:10:00+01:00",
    start_precision_s: 1,
    duration_s: 600,
    direction: "incoming",
    number: "+447700900123",
    contact: null,
    caller_unknown: false,
    recorded_sides: "both_expected",
    audio: { original: join(dir, `${id}.amr`), flac: null, levelled: null },
    transcripts: [],
    best_transcript: null,
    updated_at: "2026-06-02T18:10:00+01:00",
    fingerprint,
    ...caller,
  });
  const writeListing = (...recordings: CallsRecording[]) =>
    writeFileSync(join(dir, "listing.json"), JSON.stringify({ schema_version: 1, count: recordings.length, recordings }));

  beforeEach(() => {
    dir = join(tmpdir(), `calls-sync-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    command = join(dir, "calls");
    // Fake `calls`: logs its arguments and working directory, then prints the
    // listing. CALLS_FAKE_FAIL fails as `calls` does; CALLS_FAKE_HANG never answers.
    writeFileSync(
      command,
      [
        "#!/bin/sh",
        `echo "$(pwd) $*" >> "${join(dir, "args.txt")}"`,
        'echo "scanning recordings" >&2',
        'if [ "$CALLS_FAKE_FAIL" = "1" ]; then echo \'{"error": "recordings folder missing"}\'; exit 1; fi',
        // Not exec'd: the sleep is a child holding the output pipes open.
        'if [ "$CALLS_FAKE_HANG" = "1" ]; then sleep 30; fi',
        `cat "${join(dir, "listing.json")}"`,
        "",
      ].join("\n"),
    );
    chmodSync(command, 0o755);
    writeListing(record("WA_1", "a".repeat(40), "f1"));
    const db = getDb();
    initDb(db);
    db.prepare("DELETE FROM events WHERE source IN (?, 'phone')").run(EVENT_SOURCE);
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CALLS_FAKE_FAIL;
    delete process.env.CALLS_FAKE_HANG;
  });

  const config = () => ({ account: "owner", command });

  it("refuses to sync without an account or a runnable command", async () => {
    expect(await callRecordingsSyncSource.canSync({ command })).toMatch(/account/);
    expect(await callRecordingsSyncSource.canSync({ account: "owner" })).toMatch(/command/);
    expect(await callRecordingsSyncSource.canSync({ account: "owner", command: join(dir, "missing") })).toMatch(/not found/);
    expect(await callRecordingsSyncSource.canSync(config())).toBeNull();
  });

  it("imports the full listing from the command's own folder, then only what changed", async () => {
    const first = await runSourceOnce(callRecordingsSyncSource, { config: config() });
    expect(first.result).toMatchObject({ success: true, eventsAdded: 1, eventsUpdated: 0 });
    expect(first.events.inserted.byType).toEqual({ "recording:incoming": 1 });
    expect(readFileSync(join(dir, "args.txt"), "utf8").trim()).toBe(`${realpathSync(dir)} list`);

    writeListing(record("WA_1", "a".repeat(40), "f1"), record("WA_2", "b".repeat(40), "f1"));
    const second = await runSourceOnce(callRecordingsSyncSource, { config: config() });
    expect(second.result).toMatchObject({ success: true, eventsAdded: 1, eventsUpdated: 0, metadata: { unchanged: 1 } });

    writeListing(record("WA_1", "a".repeat(40), "f2"), record("WA_2-renamed", "b".repeat(40), "f1"));
    const third = await runSourceOnce(callRecordingsSyncSource, { config: config() });
    expect(third.result).toMatchObject({ success: true, eventsAdded: 0, eventsUpdated: 2, metadata: { updated: 1, renamed: 1 } });
    const db = getDb();
    const ids = db.prepare("SELECT source_id FROM events WHERE source = ? ORDER BY id").all(EVENT_SOURCE);
    db.close();
    expect(ids).toEqual([{ source_id: "WA_1" }, { source_id: "WA_2-renamed" }]);
  });

  it("counts recordings without a number it can't place yet, and imports them once their call exists", async () => {
    const whatsapp = record("WA_1", "c".repeat(40), "f1", { source: "whatsapp", direction: null, number: null, contact: "Alice Example" });
    writeListing(whatsapp);
    const before = await runSourceOnce(callRecordingsSyncSource, { config: config() });
    expect(before.result).toMatchObject({ success: true, eventsAdded: 0, metadata: { skippedNoCall: 1, skippedAmbiguous: 0 } });

    const db = getDb();
    db.prepare(
      `INSERT INTO events (source, source_id, source_account, type, timestamp, duration_ms, title, people, raw_data, conversation_id)
       VALUES ('phone', 'sync-call', 'owner', 'call:incoming', '2026-06-02T16:59:40.000Z', 620000, 'Alice',
               '["phone:+447700900123","phone:owner"]', '{}', '+447700900123')`,
    ).run();
    db.close();
    const after = await runSourceOnce(callRecordingsSyncSource, { config: config() });
    expect(after.result).toMatchObject({ success: true, eventsAdded: 1, metadata: { skippedNoCall: 0 } });
    expect(after.events.inserted.samples.map((sample) => sample.title)).toEqual(["Alice"]);
  });

  it("reports the error calls prints when it fails", async () => {
    process.env.CALLS_FAKE_FAIL = "1";
    const result = await callRecordingsSyncSource.sync({ verbose: false, config: { sources: { [EVENT_SOURCE]: config() } } });
    expect(result).toMatchObject({ success: false, eventsAdded: 0 });
    expect(result.error).toBe("calls list exited with code 1: recordings folder missing");
  });

  it("fails on a schema version it does not know", async () => {
    writeFileSync(join(dir, "listing.json"), JSON.stringify({ schema_version: 2, count: 0, recordings: [] }));
    const result = await callRecordingsSyncSource.sync({ verbose: false, config: { sources: { [EVENT_SOURCE]: config() } } });
    expect(result.error).toMatch(/schema_version 2 is not supported/);
  });

  it("kills calls when it runs past the timeout or the sync is cancelled", async () => {
    process.env.CALLS_FAKE_HANG = "1";
    const started = Date.now();
    await expect(runCalls(command, ["list"], { timeoutMs: 200 })).rejects.toThrow("calls list timed out after 0 s");
    expect(Date.now() - started).toBeLessThan(5_000);
    const controller = new AbortController();
    const running = runCalls(command, ["list"], { signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toThrow("calls list was cancelled");
  });
});
