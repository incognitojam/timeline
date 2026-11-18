import { expect, it, spyOn } from "bun:test";
import { Database } from "../../db/sqlite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../../db/schema";
import type { SyncOptions } from "../../sync/types";
import { claudeCodeSyncSource } from "./sync";

it("an unchanged sync takes no schema or event write lock", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  const root = await mkdtemp(join(tmpdir(), "claude-code-sync-"));
  const path = join(root, "events.db");
  const setup = new Database(path);
  schema.initDb(setup);
  setup.close();
  await mkdir(join(root, "project"));
  await writeFile(join(root, "project", "example.jsonl"), JSON.stringify({
    type: "user", uuid: "example", timestamp: "2026-01-01T00:00:00Z",
    message: { role: "user", content: "Synthetic message" },
  }));
  const getDb = spyOn(schema, "getDb").mockImplementation(() => new Database(path));
  const holder = new Database(path);
  const config = { sources: { "claude-code": { path: root, account: "alice" } } } as unknown as SyncOptions["config"];
  try {
    expect((await claudeCodeSyncSource.sync({ verbose: false, config })).eventsAdded).toBe(1);
    holder.exec("BEGIN IMMEDIATE");
    const next = await claudeCodeSyncSource.sync({ verbose: false, config });
    expect(next.success).toBe(true);
    expect(next.metadata).toMatchObject({ filesSkipped: 1, writeTransactions: 0 });
  } finally {
    if (holder.inTransaction) holder.exec("ROLLBACK");
    holder.close(); getDb.mockRestore(); clock.mockRestore(); await rm(root, { recursive: true, force: true });
  }
});
