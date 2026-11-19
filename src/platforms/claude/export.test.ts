import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectClaudeCategory } from "./export";
import { detectZipContent } from "../../inbox/zip";
import { processAutoDetectZip } from "../../inbox/zip-handlers";
import { Database } from "../../db/sqlite";
import { initDb } from "../../db/schema";

test("ChatGPT content stays ChatGPT and unsupported Claude categories skip cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-detection-"));
  const db = new Database(":memory:");
  initDb(db);
  try {
    const conversations = join(root, "conversations.json");
    const user = join(root, "user.json");
    await writeFile(conversations, JSON.stringify([{ id: "chatgpt-conversation", title: "Example", mapping: {} }]));
    await writeFile(user, "{}");
    expect(await detectClaudeCategory("export.zip", root, [conversations, user])).toBe(false);
    expect(detectZipContent([conversations, user])).toBe("chatgpt");
    await mkdir(join(root, "reflections"));
    await writeFile(join(root, "reflections/account.json"), JSON.stringify({ account_uuid: "account", reflections: [], feedback: [] }));
    const zip = join(root, "feedback-000.zip");
    const proc = Bun.spawn(["zip", "-q", zip, "reflections/account.json"], { cwd: root });
    expect(await proc.exited).toBe(0);
    expect(await processAutoDetectZip(db, zip, "tester")).toEqual({ detectedType: "claude", eventsAdded: 0, eventsUpdated: 0, skipReason: "skipped: not imported (feedback)" });
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
