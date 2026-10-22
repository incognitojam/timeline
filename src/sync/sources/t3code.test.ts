import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "crypto";
import { mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import * as schema from "../../db/schema";
import { createT3CodeV2Fixture, FIXTURE, insertMessage } from "../../parsers/fixtures/t3code/statev2-fixture";
import { T3_V2_CURSOR_OVERLAP_MS } from "../../parsers/t3code-v2";
import type { SyncOptions } from "../types";
import { t3codeSyncSource } from "./t3code";

interface State {
  cursors: Record<string, string>;
  reconciledAt: Record<string, string>;
}

describe("t3code sync source", () => {
  let root: string;
  let t3Path: string;
  let dbPath: string;
  let priorState: unknown;
  let priorMediaPath: string | undefined;
  let getDbSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    root = join(tmpdir(), `t3code-sync-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
    process.env.TIMELINE_MEDIA_PATH = join(root, "media");
    t3Path = join(root, "statev2.sqlite");
    dbPath = join(root, "timeline.db");
    createT3CodeV2Fixture(t3Path).close();
    getDbSpy = spyOn(schema, "getDb").mockImplementation(() => new Database(dbPath));
    priorState = getSyncState(getAppStateDb(), "t3code");
    setSyncState(getAppStateDb(), "t3code", {});
  });

  afterEach(async () => {
    getDbSpy.mockRestore();
    setSyncState(getAppStateDb(), "t3code", priorState ?? {});
    if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
    else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
    await rm(root, { recursive: true, force: true });
  });

  async function sync() {
    const config = { sources: { t3code: { path: t3Path, account: "alice" } } } as unknown as SyncOptions["config"];
    const result = await t3codeSyncSource.sync({ verbose: false, config });
    expect(result.error).toBeUndefined();
    return result;
  }

  it("picks up a row older than the cursor overlap at the next full read", async () => {
    await sync();
    const key = `alice|${t3Path}`;
    const state = getSyncState<State>(getAppStateDb(), "t3code");
    const cursor = state?.cursors[key];
    if (!state || !cursor) throw new Error("expected a cursor");
    expect(state.reconciledAt[key]).toBeDefined();

    const t3 = new Database(t3Path);
    insertMessage(t3, {
      id: "message-late",
      threadId: FIXTURE.threads.main,
      runId: FIXTURE.runs.claude,
      role: "assistant",
      text: "Arrived late",
      createdAt: new Date(Date.parse(cursor) - T3_V2_CURSOR_OVERLAP_MS * 2).toISOString(),
    });
    t3.close();

    expect((await sync()).eventsAdded).toBe(0);

    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    setSyncState(getAppStateDb(), "t3code", { ...state, reconciledAt: { [key]: dayAgo } });
    expect((await sync()).eventsAdded).toBe(1);

    const after = getSyncState<State>(getAppStateDb(), "t3code");
    expect(after?.reconciledAt[key]).not.toBe(dayAgo);
  });
});
