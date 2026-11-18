import { expect, it, spyOn } from "bun:test";
import { Database } from "../../db/sqlite";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../../db/schema";
import type { SyncOptions } from "../../sync/types";
import { codexSyncSource } from "./sync";

it("an unchanged sync takes no schema or event write lock", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  const root = await mkdtemp(join(tmpdir(), "codex-sync-"));
  const path = join(root, "events.db");
  const setup = new Database(path);
  schema.initDb(setup);
  setup.close();
  await writeFile(join(root, "rollout-example.jsonl"), [
    { type: "session_meta", payload: { id: "example", source: "cli" } },
    { type: "event_msg", timestamp: "2026-01-01T00:00:00Z", payload: { type: "user_message", message: "Synthetic message" } },
  ].map(row => JSON.stringify(row)).join("\n"));
  const getDb = spyOn(schema, "getDb").mockImplementation(() => new Database(path));
  const holder = new Database(path);
  const config = { sources: { codex: { path: root, account: "alice" } } } as unknown as SyncOptions["config"];
  try {
    expect((await codexSyncSource.sync({ verbose: false, config })).eventsAdded).toBe(1);
    holder.exec("BEGIN IMMEDIATE");
    const next = await codexSyncSource.sync({ verbose: false, config });
    expect(next.success).toBe(true);
    expect(next.metadata).toMatchObject({ filesSkipped: 1, writeTransactions: 0 });
  } finally {
    if (holder.inTransaction) holder.exec("ROLLBACK");
    holder.close(); getDb.mockRestore(); clock.mockRestore(); await rm(root, { recursive: true, force: true });
  }
});
