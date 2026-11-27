import { describe, expect, test } from "bun:test";
import { Database } from "../db/sqlite";
import { initDb } from "../db/schema";
import { SCHEMA_RECIPES } from "./schema";

describe("get_schema recipes", () => {
  test("every recipe runs and finds its event", () => {
    const db = new Database(":memory:");
    initDb(db);
    db.prepare("INSERT INTO contacts (id, display_name) VALUES (2, 'Alice')").run();
    db.prepare("INSERT INTO identities (platform, platform_id, contact_id) VALUES ('discord', '111', 2)").run();
    const insert = db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, people, tags, raw_data, conversation_id)
      VALUES (?, ?, 'me', ?, '2026-10-05T12:00:00.000Z', ?, ?, ?, ?, '{}', ?)
    `);
    insert.run("discord", "m1", "message:dm", "Alice", "up for mount si?", '["discord:111"]', null, "dm-1");
    insert.run("spotify", "s1", "listen:track", "Dreams", "Dreams by Fleetwood Mac", '["spotify:me"]', '["artist:Fleetwood Mac"]', null);

    for (const recipe of SCHEMA_RECIPES) {
      expect(db.query(recipe.sql).all().length, recipe.label).toBeGreaterThan(0);
    }
    db.close();
  });
});
