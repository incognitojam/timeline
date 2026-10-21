import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import { importRedditData } from "./reddit";

describe("reddit parser", () => {
  let db: Database;
  let fixtureDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    fixtureDir = join(tmpdir(), `reddit-fixture-${randomUUID()}`);
    await mkdir(fixtureDir, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("keys messages on the sorted participants regardless of direction", async () => {
    const csv = [
      "id,permalink,thread_id,date,ip,from,to,subject,body",
      "aaa111,https://www.reddit.com/message/messages/aaa111,,2017-04-11 21:24:12 UTC,203.0.113.7,alice,bob,hello,Hi there",
      "bbb222,https://www.reddit.com/message/messages/bbb222,t4_xyz789,2017-04-12 08:01:00 UTC,203.0.113.7,u/bob,alice,re: hello,Hi back",
    ].join("\n");
    await writeFile(join(fixtureDir, "messages_archive.csv"), csv);

    await importRedditData(db, fixtureDir, "alice");

    const rows = db
      .prepare(
        "SELECT source_id, conversation_id FROM events WHERE source = 'reddit' ORDER BY source_id",
      )
      .all() as { source_id: string; conversation_id: string | null }[];

    expect(rows).toEqual([
      { source_id: "message:aaa111", conversation_id: "alice~bob" },
      { source_id: "message:bbb222", conversation_id: "alice~bob" },
    ]);
  });

  it("leaves conversation_id null on posts", async () => {
    const csv = [
      "id,permalink,date,ip,subreddit,gildings,title,url,body",
      "ccc333,https://www.reddit.com/r/somesub/comments/ccc333,2017-04-11 21:24:12 UTC,203.0.113.7,somesub,0,A post,,Post body",
    ].join("\n");
    await writeFile(join(fixtureDir, "posts.csv"), csv);

    await importRedditData(db, fixtureDir, "alice");

    const rows = db
      .prepare("SELECT type, conversation_id FROM events WHERE source = 'reddit'")
      .all() as { type: string; conversation_id: string | null }[];

    expect(rows).toEqual([{ type: "post", conversation_id: null }]);
  });
});
