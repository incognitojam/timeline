import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "./schema";
import { resolveIdentities, upsertIdentity, getIdentitiesForContact } from "./queries";
import { wrapDatabase } from "./pool";

let db: Database;

function setupTestDatabase(): void {
  db = new Database(":memory:");
  initDb(db);
}

function teardownTestDatabase(): void {
  db.close();
}

describe("resolveIdentities", () => {
  beforeEach(setupTestDatabase);
  afterEach(teardownTestDatabase);

  test("handles batches larger than SQLite parameter limit", async () => {
    const identifiers = Array.from({ length: 650 }, (_, i) => `discord:user_${i}`);

    upsertIdentity(db, { platform: "discord", platformId: "user_0", displayName: "User 0" });
    upsertIdentity(db, { platform: "discord", platformId: "user_399", displayName: "User 399" });
    upsertIdentity(db, { platform: "discord", platformId: "user_400", displayName: "User 400" });
    upsertIdentity(db, { platform: "discord", platformId: "user_649", displayName: "User 649" });

    const contactResult = db.prepare("INSERT INTO contacts (display_name) VALUES (?)").run("Linked User");
    const contactId = Number(contactResult.lastInsertRowid);
    db.prepare(`
      UPDATE identities SET contact_id = ?
      WHERE platform = ? AND platform_id = ?
    `).run(contactId, "discord", "user_400");

    const resolved = await resolveIdentities(wrapDatabase(db), identifiers);

    expect(Object.keys(resolved)).toHaveLength(identifiers.length);
    expect(resolved["discord:user_0"]).toEqual({ name: "User 0", username: null, contactId: null, avatarUrl: null, isSelf: false, hidden: false });
    expect(resolved["discord:user_399"]?.name).toBe("User 399");
    expect(resolved["discord:user_400"]).toEqual({
      name: "Linked User",
      username: null,
      contactId,
      avatarUrl: null,
      isSelf: false,
      hidden: false,
    });
    expect(resolved["discord:user_649"]?.name).toBe("User 649");
    expect(resolved["discord:user_10"]).toEqual({ name: null, username: null, contactId: null, avatarUrl: null, isSelf: false, hidden: false });
  });

  test("flags identities linked to the self contact", async () => {
    upsertIdentity(db, { platform: "spotify", platformId: "owner", displayName: "Owner" });
    upsertIdentity(db, { platform: "discord", platformId: "friend", displayName: "Alice Example" });
    const selfId = Number(
      db.prepare("INSERT INTO contacts (display_name, is_self) VALUES (?, 1)").run("Owner").lastInsertRowid,
    );
    db.prepare("UPDATE identities SET contact_id = ? WHERE platform = 'spotify'").run(selfId);

    const resolved = await resolveIdentities(wrapDatabase(db), [
      "spotify:owner",
      "discord:friend",
      `contact:${selfId}`,
    ]);

    expect(resolved["spotify:owner"]?.isSelf).toBe(true);
    expect(resolved[`contact:${selfId}`]?.isSelf).toBe(true);
    expect(resolved["discord:friend"]?.isSelf).toBe(false);
  });
});

describe("upsertIdentity avatarUrl", () => {
  beforeEach(setupTestDatabase);
  afterEach(teardownTestDatabase);

  test("stores and retrieves avatar_url", async () => {
    upsertIdentity(db, {
      platform: "discord",
      platformId: "alice_123",
      displayName: "Alice",
      avatarUrl: "https://cdn.discordapp.com/avatars/123/abc.png",
    });

    const contactResult = db.prepare("INSERT INTO contacts (display_name) VALUES (?)").run("Alice");
    const contactId = Number(contactResult.lastInsertRowid);
    db.prepare("UPDATE identities SET contact_id = ? WHERE platform = 'discord' AND platform_id = 'alice_123'")
      .run(contactId);

    const identities = await getIdentitiesForContact(wrapDatabase(db), contactId);
    expect(identities).toHaveLength(1);
    expect(identities[0].avatar_url).toBe("https://cdn.discordapp.com/avatars/123/abc.png");
  });

  test("resolveIdentities returns avatarUrl when set", async () => {
    upsertIdentity(db, {
      platform: "github",
      platformId: "bob",
      displayName: "Bob",
      avatarUrl: "https://avatars.githubusercontent.com/u/42",
    });

    const resolved = await resolveIdentities(wrapDatabase(db), ["github:bob"]);
    expect(resolved["github:bob"]).toEqual({
      name: "Bob",
      username: null,
      contactId: null,
      avatarUrl: "https://avatars.githubusercontent.com/u/42",
      isSelf: false,
      hidden: false,
    });
  });

  test("upsert preserves existing avatar_url when new value is undefined", async () => {
    upsertIdentity(db, {
      platform: "discord",
      platformId: "carol",
      displayName: "Carol",
      avatarUrl: "https://cdn.discordapp.com/avatars/456/def.png",
    });

    // Upsert again without avatarUrl
    upsertIdentity(db, {
      platform: "discord",
      platformId: "carol",
      displayName: "Carol Updated",
    });

    const resolved = await resolveIdentities(wrapDatabase(db), ["discord:carol"]);
    expect(resolved["discord:carol"]?.name).toBe("Carol Updated");
    expect(resolved["discord:carol"]?.avatarUrl).toBe("https://cdn.discordapp.com/avatars/456/def.png");
  });
});
