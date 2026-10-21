/**
 * Discord Servers API Tests
 *
 * Seeds a couple of guilds' worth of Discord events (with conversation_id and
 * raw_data._channel metadata) and checks the server index + detail endpoints.
 * Run with: bun test src/api/discord-servers.test.ts
 */

process.env.NODE_ENV = "test";

import { describe, test, expect, beforeAll } from "bun:test";
import { app } from "./index";

const GUILD_A = "900000000000000001";
const GUILD_B = "900000000000000002";
const GUILD_A_ICON = "abc123def4567890abc123def4567890";
const EMOJI_PARTY = "940000000000000001";
const EMOJI_WAVE = "940000000000000002";
const EMOJI_BLOB = "940000000000000003";

interface SeedEvent {
  sourceId: string;
  type: string;
  timestamp: string;
  title: string;
  conversationId: string | null;
  channel: Record<string, unknown> | null;
  sender: string;
}

function channel(
  id: string,
  name: string,
  type: string,
  guildId: string | null,
  guildName: string | null,
  category: string | null,
) {
  return { id, name, type, guild_id: guildId, guild_name: guildName, category, recipients: [] };
}

describe("Discord Servers API", () => {
  beforeAll(async () => {
    const { getDb, initDb } = await import("../db/schema");
    const db = getDb();
    initDb(db);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, people, tags, raw_data, import_batch, conversation_id
      ) VALUES ('discord', ?, 'servers-test', ?, ?, ?, ?, ?, NULL, ?, 'discord-servers-test', ?)
    `);

    const events: SeedEvent[] = [
      // Guild A — "Text" category: #general (3 msgs: alice, alice, bob)
      { sourceId: "sv-a-gen-1", type: "message:guild", timestamp: "2099-03-01T10:00:00.000Z", title: "Test Server Alpha #general", conversationId: "910000000000000001", channel: channel("910000000000000001", "general", "GuildTextChat", GUILD_A, "Test Server Alpha", "Text"), sender: "discord:alice" },
      { sourceId: "sv-a-gen-2", type: "message:guild", timestamp: "2099-03-02T10:00:00.000Z", title: "Test Server Alpha #general", conversationId: "910000000000000001", channel: channel("910000000000000001", "general", "GuildTextChat", GUILD_A, "Test Server Alpha", "Text"), sender: "discord:alice" },
      { sourceId: "sv-a-gen-3", type: "message:guild", timestamp: "2099-03-03T10:00:00.000Z", title: "Test Server Alpha #general", conversationId: "910000000000000001", channel: channel("910000000000000001", "general", "GuildTextChat", GUILD_A, "Test Server Alpha", "Text"), sender: "discord:bob" },
      // Guild A — "Text" category: #memes (1 msg: alice)
      { sourceId: "sv-a-memes-1", type: "message:guild", timestamp: "2099-03-04T10:00:00.000Z", title: "Test Server Alpha #memes", conversationId: "910000000000000002", channel: channel("910000000000000002", "memes", "GuildTextChat", GUILD_A, "Test Server Alpha", "Text"), sender: "discord:alice" },
      // Guild A — "Text" category: a thread (1 msg: bob)
      { sourceId: "sv-a-thread-1", type: "message:guild", timestamp: "2099-03-05T10:00:00.000Z", title: "Test Server Alpha #side-thread", conversationId: "910000000000000003", channel: channel("910000000000000003", "side-thread", "GuildPublicThread", GUILD_A, "Test Server Alpha", "Text"), sender: "discord:bob" },
      // Guild A — uncategorised #music (1 msg: alice). Uses an empty-string
      // category (what Discord emits for no category) to check it normalises to
      // a null category name (rendered as "Other"), not a blank header.
      { sourceId: "sv-a-music-1", type: "message:guild", timestamp: "2099-03-06T10:00:00.000Z", title: "Test Server Alpha #music", conversationId: "910000000000000004", channel: channel("910000000000000004", "music", "GuildTextChat", GUILD_A, "Test Server Alpha", ""), sender: "discord:alice" },
      // Guild B — "General" category: #beta-chat (2 msgs: carol), two months
      // apart so the detail endpoint's activityByMonth exercises the gap fill.
      { sourceId: "sv-b-1", type: "message:guild", timestamp: "2099-03-01T10:00:00.000Z", title: "Test Server Beta #beta-chat", conversationId: "920000000000000001", channel: channel("920000000000000001", "beta-chat", "GuildTextChat", GUILD_B, "Test Server Beta", "General"), sender: "discord:carol" },
      { sourceId: "sv-b-2", type: "message:guild", timestamp: "2099-05-02T10:00:00.000Z", title: "Test Server Beta #beta-chat", conversationId: "920000000000000001", channel: channel("920000000000000001", "beta-chat", "GuildTextChat", GUILD_B, "Test Server Beta", "General"), sender: "discord:carol" },
      // A DM (no guild) — must NOT appear as a server
      { sourceId: "sv-dm-1", type: "message:dm", timestamp: "2099-03-01T10:00:00.000Z", title: "dave", conversationId: "930000000000000001", channel: channel("930000000000000001", "dave", "DM", null, null, null), sender: "discord:dave" },
    ];

    for (const e of events) {
      insert.run(
        e.sourceId,
        e.type,
        e.timestamp,
        e.title,
        "hello",
        JSON.stringify([e.sender]),
        e.channel ? JSON.stringify({ _channel: e.channel }) : null,
        e.conversationId,
      );
    }

    // Guild icons captured from fetchGuild: Guild A has an icon, Guild B has
    // none (null icon). Drives the iconUrl field on the index + detail views.
    const insertGuild = db.prepare(
      `INSERT OR REPLACE INTO discord_guilds (guild_id, icon) VALUES (?, ?)`,
    );
    insertGuild.run(GUILD_A, GUILD_A_ICON);
    insertGuild.run(GUILD_B, null);

    const insertEmoji = db.prepare(`
      INSERT OR REPLACE INTO discord_guild_emojis (
        guild_id, emoji_id, name, animated, available, managed, require_colons,
        uploader_id, uploader_username, uploader_display_name, uploader_avatar_url, raw_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    `);
    insertEmoji.run(
      GUILD_A,
      EMOJI_PARTY,
      "party",
      0,
      1,
      0,
      1,
      "alice",
      "alice_user",
      "Alice Uploader",
      "https://cdn.discordapp.com/avatars/alice/avatar-a.png?size=128",
      JSON.stringify({ id: EMOJI_PARTY, name: "party" }),
    );
    insertEmoji.run(
      GUILD_A,
      EMOJI_WAVE,
      "wave",
      1,
      1,
      0,
      1,
      "alice",
      "alice_user",
      "Alice Uploader",
      "https://cdn.discordapp.com/avatars/alice/avatar-a.png?size=128",
      JSON.stringify({ id: EMOJI_WAVE, name: "wave", animated: true }),
    );
    insertEmoji.run(
      GUILD_A,
      EMOJI_BLOB,
      "blob",
      0,
      1,
      0,
      1,
      "bob",
      "bob_user",
      "Bob Uploader",
      null,
      JSON.stringify({ id: EMOJI_BLOB, name: "blob" }),
    );

    db.close();
  });

  test("GET /api/discord/servers lists guilds, excludes DMs", async () => {
    const res = await app.request("/api/discord/servers");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.servers)).toBe(true);

    const a = json.servers.find((s: { guildId: string }) => s.guildId === GUILD_A);
    const b = json.servers.find((s: { guildId: string }) => s.guildId === GUILD_B);
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    expect(a.name).toBe("Test Server Alpha");
    expect(a.channelCount).toBe(4);
    expect(a.messageCount).toBe(6);
    expect(a.firstMessage).toBe("2099-03-01T10:00:00.000Z");
    expect(a.lastMessage).toBe("2099-03-06T10:00:00.000Z");
    // Guild A's icon hash resolves to its Discord CDN URL (sized for display).
    expect(a.iconUrl).toBe(`https://cdn.discordapp.com/icons/${GUILD_A}/${GUILD_A_ICON}.png?size=128`);

    expect(b.channelCount).toBe(1);
    expect(b.messageCount).toBe(2);
    // Guild B has no icon → null, so the UI falls back to the acronym.
    expect(b.iconUrl).toBeNull();

    // No DM/group channel leaks in as a server (the DM has a null guild_id).
    const dmAsServer = json.servers.find((s: { name: string }) => s.name === "dave");
    expect(dmAsServer).toBeUndefined();
  });

  test("GET /api/discord/servers/:id returns categories, participants, activity", async () => {
    const res = await app.request(`/api/discord/servers/${GUILD_A}`);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.guildId).toBe(GUILD_A);
    expect(json.name).toBe("Test Server Alpha");
    expect(json.iconUrl).toBe(`https://cdn.discordapp.com/icons/${GUILD_A}/${GUILD_A_ICON}.png?size=128`);
    expect(json.channelCount).toBe(4);
    expect(json.messageCount).toBe(6);

    // Categories ordered by message count: "Text" (5 msgs across 3 channels)
    // before the uncategorised #music (1 msg).
    const textCat = json.categories.find((cat: { name: string | null }) => cat.name === "Text");
    // #music's empty-string category normalises to a null name (UI shows "Other").
    const noCat = json.categories.find((cat: { name: string | null }) => cat.name === null);
    expect(textCat).toBeDefined();
    expect(noCat).toBeDefined();
    expect(json.categories[0].name).toBe("Text");
    expect(textCat.channels.length).toBe(3);
    expect(noCat.channels.length).toBe(1);

    // Channels within "Text" ordered by message count: general (3) first.
    expect(textCat.channels[0].name).toBe("general");
    expect(textCat.channels[0].messageCount).toBe(3);
    expect(textCat.channels[0].lastEventId).toBeGreaterThan(0);

    // Thread flagged from its channel type.
    const thread = textCat.channels.find((ch: { name: string }) => ch.name === "side-thread");
    expect(thread.isThread).toBe(true);

    // Participant leaderboard from event_people senders: alice (4) > bob (2).
    expect(json.participants[0].name).toBe("alice");
    expect(json.participants[0].count).toBe(4);
    expect(json.participants[1].name).toBe("bob");
    expect(json.participants[1].count).toBe(2);

    // All seeded activity falls in 2099-03.
    const march = json.activityByMonth.find((m: { month: string }) => m.month === "2099-03");
    expect(march).toBeDefined();
    expect(march.count).toBe(6);

    expect(json.emojiCount).toBe(3);
    expect(json.emojiUploaders[0].name).toBe("Alice Uploader");
    expect(json.emojiUploaders[0].count).toBe(2);
    expect(json.emojiUploaders[0].avatarUrl).toBe("https://cdn.discordapp.com/avatars/alice/avatar-a.png?size=128");
    expect(json.emojiUploaders[0].emojis).toEqual([
      {
        emojiId: EMOJI_PARTY,
        name: "party",
        animated: false,
        imageUrl: `/api/discord/emoji/${EMOJI_PARTY}.png`,
      },
      {
        emojiId: EMOJI_WAVE,
        name: "wave",
        animated: true,
        imageUrl: `/api/discord/emoji/${EMOJI_WAVE}.gif`,
      },
    ]);
    expect(json.emojiUploaders[1].name).toBe("Bob Uploader");
    expect(json.emojiUploaders[1].count).toBe(1);
  });

  test("GET /api/discord/servers/:id fills zero-count months in activity", async () => {
    const res = await app.request(`/api/discord/servers/${GUILD_B}`);
    expect(res.status).toBe(200);
    const json = await res.json();

    // Guild B's messages are in 2099-03 and 2099-05; the silent April is
    // filled with a zero bucket rather than spliced out.
    expect(json.activityByMonth).toEqual([
      { month: "2099-03", count: 1 },
      { month: "2099-04", count: 0 },
      { month: "2099-05", count: 1 },
    ]);
  });

  test("GET /api/discord/servers/:id returns 404 for unknown guild", async () => {
    const res = await app.request("/api/discord/servers/900000000000000099");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toHaveProperty("error");
  });

  test("GET /api/discord/servers/:id returns 400 for non-numeric id", async () => {
    const res = await app.request("/api/discord/servers/not-a-snowflake");
    expect(res.status).toBe(400);
  });
});
