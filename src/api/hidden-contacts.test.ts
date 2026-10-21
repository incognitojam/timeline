/**
 * Hidden-contact leak sweep.
 *
 * Every GET API route must be classified here so new endpoints cannot expose
 * hidden-contact event content without an explicit decision.
 *
 * Two coverage kinds exist:
 * - `coveredSweep`: aggregate surfaces where MARKER must be absent from the
 *   entire response body (day view, search, recent, music).
 * - `coveredCustom`: container-model routes where MARKER may legitimately
 *   appear in a hidden-only container's title or in messages the caller
 *   asked for by id; each has an explicit assertion instead of the sweep.
 */

process.env.NODE_ENV = "test";

import { describe, expect, test } from "bun:test";
import { invalidateHiddenClauseCaches } from "../db/events";
import { getDb } from "../db/schema";
import { app } from "./index";

const MARKER = "ZZHIDDENZZ";
const SOURCE = "hidden-contact-leak-test";
const DATE = "2097-07-16";
const GUILD_ID = "999977772097";

const exempt = {
  "/api/attachments": "Attachment inventory is audited separately from event visibility.",
  "/api/attachments/:id": "Direct attachment lookup is an explicit resource access path.",
  "/api/attachments/description-history": "Returns aggregate attachment-description history only.",
  "/api/attachments/stats": "Returns attachment aggregates only.",
  "/api/auth/status": "Returns authentication state only.",
  "/api/coding/projects": "Coding-project aggregation is outside this slice.",
  "/api/coding/projects/:name/conversations": "Project-scoped conversation access is outside this slice.",
  "/api/contacts": "Hidden contacts are already omitted by the contacts query.",
  "/api/contacts/:id": "Direct contact lookup is an explicit escape hatch.",
  "/api/contacts/:id/conversations": "Contact-scoped conversation lookup is an explicit escape hatch.",
  "/api/contacts/:id/events": "Contact-scoped event lookup is an explicit escape hatch tested below.",
  "/api/contacts/:id/identities": "Direct contact identity lookup contains no event content.",
  "/api/contacts/:id/spotify-summary": "Contact-scoped summary is an explicit escape hatch.",
  "/api/contacts/:id/suggestions": "Returns contact-link suggestions only.",
  "/api/contacts/count": "Returns a contact count only.",
  "/api/contacts/resolve": "Returns an explicitly resolved contact only.",
  "/api/contacts/suggestions": "Returns contact-link suggestions only.",
  "/api/conversation": "Direct thread access stays unfiltered and is tested below.",
  "/api/conversation/around": "Direct thread access stays unfiltered.",
  "/api/conversation/media": "Direct thread media access stays unfiltered.",
  "/api/conversations/sources": "Returns source names only.",
  "/api/day/:date/health": "Returns health aggregates only.",
  "/api/day/:date/summary": "Existing cached summaries are intentionally not invalidated by this slice.",
  "/api/discord/emoji/:id": "Direct emoji lookup contains no event content.",
  "/api/eval/cases": "Returns evaluation fixtures, not timeline events.",
  "/api/eval/cases/:id": "Returns an evaluation fixture, not timeline events.",
  "/api/events/:id": "Direct event lookup is an explicit resource access path.",
  "/api/events/:id/attachments": "Direct event attachment lookup is an explicit resource access path.",
  "/api/events/:id/context": "Direct event context is an explicit resource access path.",
  "/api/health": "Returns service health only.",
  "/api/health/biomarkers": "Returns health aggregates only.",
  "/api/health/stats": "Returns health aggregates only.",
  "/api/identities/:identifier": "Direct identity lookup contains no event content.",
  "/api/identities/:identifier/suggested-contacts": "Returns contact-link suggestions only.",
  "/api/identities/events": "Identity-scoped event lookup is an explicit escape hatch.",
  "/api/identities/link-suggestions": "Returns contact-link suggestions only.",
  "/api/identities/skipped": "Returns skipped identity metadata only.",
  "/api/identities/skipped/count": "Returns a skipped identity count only.",
  "/api/identities/unlinked": "Returns unlinked identity metadata only.",
  "/api/identities/unlinked/count": "Returns an unlinked identity count only.",
  "/api/jobs": "Returns background-job metadata only.",
  "/api/jobs/:id": "Returns background-job metadata only.",
  "/api/journal/:date": "Journal-specific access is outside contact filtering.",
  "/api/location": "Location filtering is a documented later audit.",
  "/api/map/day/:date": "Map filtering is a documented later audit.",
  "/api/mcp/sessions": "Returns MCP session metadata only.",
  "/api/mcp/sessions/:id": "Direct MCP transcript access remains unfiltered.",
  "/api/mcp/sessions/:id{.+\\.md}": "Direct MCP transcript access remains unfiltered.",
  "/api/media/*": "Direct media access is an explicit resource path.",
  "/api/music/rankings": "Music-specific aggregation is outside this slice.",
  "/api/music/recent": "Music-specific aggregation is outside this slice.",
  "/api/playlists": "Returns playlist follower data, not timeline event content.",
  "/api/playlists/:id": "Returns playlist follower data, not timeline event content.",
  "/api/search/semantic": "Semantic search post-filtering is a documented gap.",
  "/api/sources": "Returns source/type aggregates only.",
  "/api/releases/latest": "Returns release notes and download metadata only.",
  "/api/spotify/track-images": "Returns Spotify image metadata only.",
  "/api/stats": "Statistics already apply hidden-contact filtering.",
  "/api/status": "Returns service status only.",
  "/api/status/inbox-sources": "Returns inbox configuration only.",
  "/api/status/storage": "Returns storage status only.",
  "/api/status/sync-history": "Returns sync metadata only.",
  "/api/status/trigger-sync": "Returns sync capability metadata only.",
  "/api/summary": "Returns aggregate source/type metadata; event-list filtering is covered separately.",
  "/api/summary/models": "Returns configured model metadata only.",
  "/api/settings/network": "Returns blocked Wi-Fi network names only.",
  "/api/sync/sources": "Returns sync-source configuration only.",
  "/api/timeline/date-index": "Returns date/count aggregates only.",
  "/api/timeline/dates": "Returns date/source aggregates only.",
  "/api/wakatime/projects/:name": "WakaTime-specific aggregation is outside this slice.",
  "/api/wakatime/projects/:name/sessions": "WakaTime-specific aggregation is outside this slice.",
  "/api/wakatime/stats": "Returns WakaTime aggregates only.",
} satisfies Record<string, string>;

describe("hidden contacts", () => {
  test("timeline surfaces hide their events while direct access remains available", async () => {
    const db = getDb();
    // Seeded VISIBLE and hidden via the API below, so the PATCH path (and
    // the cache purge it triggers) is exercised rather than assumed.
    const hiddenContact = Number(db.prepare(`
      INSERT INTO contacts (display_name, hidden) VALUES ('Hidden Test Contact', 0)
    `).run().lastInsertRowid);
    const visibleContact = Number(db.prepare(`
      INSERT INTO contacts (display_name, hidden) VALUES ('Visible Test Contact', 0)
    `).run().lastInsertRowid);

    db.prepare(`
      INSERT INTO identities (platform, platform_id, display_name, contact_id)
      VALUES ('discord', 'hidden-test-person', 'Hidden Test Contact', ?)
    `).run(hiddenContact);
    db.prepare(`
      INSERT INTO identities (platform, platform_id, display_name, contact_id)
      VALUES ('discord', 'visible-test-person', 'Visible Test Contact', ?)
    `).run(visibleContact);
    db.prepare(`
      INSERT INTO identities (platform, platform_id, display_name, contact_id)
      VALUES ('spotify', 'hidden-test-spotify', 'Hidden Test Contact', ?)
    `).run(hiddenContact);
    db.prepare(`
      INSERT INTO identities (platform, platform_id, display_name, contact_id)
      VALUES ('spotify', 'visible-test-spotify', 'Visible Test Contact', ?)
    `).run(visibleContact);

    const insertEvent = db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp, title, content,
        people, conversation_id, raw_data
      ) VALUES (?, ?, 'test-account', ?, ?, ?, ?, ?, ?, ?)
    `);
    // Hidden 1:1 DM (hidden speaker only). Under the container model the row
    // stays listed (dim/badge is a later slice), so its title carrying the
    // marker is expected in /api/conversations.
    insertEvent.run(SOURCE, "hidden-dm-event", "message:dm", `${DATE}T09:00:00Z`, `${MARKER} direct`, `${MARKER} direct content`, JSON.stringify(["discord:hidden-test-person"]), "hidden-dm", "{}");
    // Shared group thread: hidden speaker earlier, visible speaker later,
    // so the summary title comes from the visible-speaker message and no
    // MARKER shows in /api/conversations for this row.
    insertEvent.run(SOURCE, "hidden-group-event-a", "message:group", `${DATE}T10:00:00Z`, `${MARKER} group`, `${MARKER} group content`, JSON.stringify(["discord:hidden-test-person"]), "hidden-group", "{}");
    insertEvent.run(SOURCE, "hidden-group-event-b", "message:group", `${DATE}T10:30:00Z`, "Shared group thread", "Visible speaker reply", JSON.stringify(["discord:visible-test-person"]), "hidden-group", "{}");
    insertEvent.run(SOURCE, "hidden-plain-event", "test:event", `${DATE}T11:00:00Z`, `${MARKER} plain`, `${MARKER} plain content`, JSON.stringify(["discord:hidden-test-person"]), null, "{}");
    insertEvent.run(SOURCE, "visible-dm-event", "message:dm", `${DATE}T12:00:00Z`, "Visible control", "Visible control content", JSON.stringify(["discord:visible-test-person"]), "visible-dm", "{}");
    insertEvent.run("spotify-friends", "hidden-friend-listen", "listen:track:friend", `${DATE}T13:00:00Z`, `${MARKER} track`, null, JSON.stringify(["spotify:hidden-test-spotify"]), null, "{}");
    insertEvent.run("spotify-friends", "visible-friend-listen", "listen:track:friend", `${DATE}T14:00:00Z`, "Visible control track", null, JSON.stringify(["spotify:visible-test-spotify"]), null, "{}");
    // Discord guild channel: hidden speaker + visible speaker. Populates
    // /api/discord/servers* so its top-participants filter can be asserted.
    const guildChannelRaw = JSON.stringify({
      _channel: { guild_id: GUILD_ID, guild_name: "Hidden Test Guild", name: "general", type: "GuildText" },
    });
    insertEvent.run("discord", "guild-hidden-msg", "message:group", `${DATE}T15:00:00Z`, `${MARKER} guild msg`, `${MARKER} guild msg content`, JSON.stringify(["discord:hidden-test-person"]), "hidden-guild-channel", guildChannelRaw);
    insertEvent.run("discord", "guild-visible-msg", "message:group", `${DATE}T15:30:00Z`, "Shared guild channel", "Visible speaker reply", JSON.stringify(["discord:visible-test-person"]), "hidden-guild-channel", guildChannelRaw);
    // Guild emojis: one uploaded by each person, so the server page's
    // emoji-uploader attribution is covered alongside top participants.
    const insertEmoji = db.prepare(`
      INSERT INTO discord_guild_emojis (guild_id, emoji_id, name, uploader_id, raw_data)
      VALUES (?, ?, ?, ?, '{}')
    `);
    insertEmoji.run(GUILD_ID, "999977772097001", "hiddenuploademoji", "hidden-test-person");
    insertEmoji.run(GUILD_ID, "999977772097002", "visibleuploademoji", "visible-test-person");
    db.close();
    invalidateHiddenClauseCaches();

    try {
      // Prime the Discord caches while the contact is still visible. This
      // also makes the test independent of whatever earlier test files left
      // in the process-wide cache: the PATCH below must purge it.
      const primedServer = await app.request(`/api/discord/servers/${GUILD_ID}`);
      expect(primedServer.status).toBe(200);
      expect(await primedServer.text()).toContain("Hidden Test Contact");
      await app.request("/api/discord/servers");

      const hide = await app.request(`/api/contacts/${hiddenContact}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      });
      expect(hide.status).toBe(200);

      // Aggregate surfaces — MARKER must not appear anywhere in the body.
      const coveredSweep: Record<string, string> = {
        "/api/day": `/api/day?date=${DATE}`,
        "/api/events": `/api/events?date=${DATE}&source=${SOURCE}`,
        "/api/music/friends/latest": "/api/music/friends/latest",
        "/api/recent": `/api/recent?source=${SOURCE}`,
        "/api/search": `/api/search?q=${MARKER}&source=${SOURCE}&exclude_sources=`,
      };
      // Container-model routes — a MARKER in a hidden-only container title
      // is legitimate, so each has its own assertion below.
      const coveredCustom = {
        "/api/conversations": true,
        "/api/conversation/stats": true,
        "/api/discord/servers": true,
        "/api/discord/servers/:id": true,
      } satisfies Record<string, true>;

      const getRoutes = new Set(
        app.routes
          .filter((route) => route.method === "GET" && route.path.startsWith("/api/"))
          .map((route) => route.path),
      );
      const classified = new Set([
        ...Object.keys(coveredSweep),
        ...Object.keys(coveredCustom),
        ...Object.keys(exempt),
      ]);
      expect([...getRoutes].filter((route) => !classified.has(route))).toEqual([]);
      expect([...classified].filter((route) => !getRoutes.has(route))).toEqual([]);

      for (const requestPath of Object.values(coveredSweep)) {
        const response = await app.request(requestPath);
        expect(response.status).toBe(200);
        expect(await response.text()).not.toContain(MARKER);
      }

      const visibleDay = await app.request(`/api/day?date=${DATE}`);
      expect(await visibleDay.text()).toContain("Visible control");

      const visibleFriends = await app.request("/api/music/friends/latest");
      expect(await visibleFriends.text()).toContain("Visible control track");

      const contactEvents = await app.request(`/api/contacts/${hiddenContact}/events`);
      expect(contactEvents.status).toBe(200);
      expect(await contactEvents.text()).toContain(MARKER);

      const directConversation = await app.request(`/api/conversation?source=${SOURCE}&conversationId=hidden-dm`);
      expect(directConversation.status).toBe(200);
      expect(await directConversation.text()).toContain(MARKER);

      // /api/conversations: the shared group thread is LISTED (fixing #859's
      // over-exclusion). The hidden 1:1 is also listed — this slice keeps
      // dim/badge for hidden-only rows out of scope (a proper participants
      // table is a prerequisite for making the container predicate fast).
      const conversations = await app.request(`/api/conversations?source=${SOURCE}`);
      expect(conversations.status).toBe(200);
      const conversationsBody = await conversations.text();
      expect(conversationsBody).toContain("Shared group thread");
      expect(conversationsBody).toContain("Visible control");
      const conversationsJson = JSON.parse(conversationsBody) as {
        conversations: { conversationId: string }[];
      };
      const groupRow = conversationsJson.conversations.find((c) => c.conversationId === "hidden-group");
      const visibleRow = conversationsJson.conversations.find((c) => c.conversationId === "visible-dm");
      const hiddenDmRow = conversationsJson.conversations.find((c) => c.conversationId === "hidden-dm");
      expect(groupRow).toBeDefined();
      expect(visibleRow).toBeDefined();
      expect(hiddenDmRow).toBeDefined();

      // /api/conversation/stats: membership is a fact about the container
      // you chose to open, so the hidden contact stays in the participants
      // header (hidden state is rendered as dim + icon in a later slice).
      const groupStats = await app.request(`/api/conversation/stats?source=${SOURCE}&conversationId=hidden-group`);
      expect(groupStats.status).toBe(200);
      const groupStatsBody = await groupStats.text();
      expect(groupStatsBody).toContain("Visible Test Contact");
      expect(groupStatsBody).toContain("Hidden Test Contact");

      // /api/discord/servers* : top participants drop the hidden contact.
      const servers = await app.request("/api/discord/servers");
      expect(servers.status).toBe(200);
      const serversBody = await servers.text();
      expect(serversBody).toContain("Hidden Test Guild");

      const server = await app.request(`/api/discord/servers/${GUILD_ID}`);
      expect(server.status).toBe(200);
      const serverBody = await server.text();
      expect(serverBody).toContain("Visible Test Contact");
      expect(serverBody).not.toContain("Hidden Test Contact");
      // Emoji attribution: the visible uploader's emoji is listed under their
      // name; the hidden uploader's emoji is not attributed to anyone.
      expect(serverBody).toContain("visibleuploademoji");
      expect(serverBody).not.toContain("hiddenuploademoji");
      // Attribution is hidden, the total is not: both seeded emojis count.
      expect((JSON.parse(serverBody) as { emojiCount: number }).emojiCount).toBe(2);

      const unhide = await app.request(`/api/contacts/${hiddenContact}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: false }),
      });
      expect(unhide.status).toBe(200);

      const unhiddenDay = await app.request(`/api/day?date=${DATE}`);
      expect(await unhiddenDay.text()).toContain(MARKER);

      // After unhiding, the top participants show up again on the cached
      // Discord server page, which the PATCH must have purged.
      const serverAfter = await app.request(`/api/discord/servers/${GUILD_ID}`);
      expect(await serverAfter.text()).toContain("Hidden Test Contact");
    } finally {
      // The last server-page fetch refilled the process-wide cache with the
      // fixture guild; any contact PATCH purges it (invalidateContactsCaches),
      // so later test files can't read the deleted fixture for the TTL.
      await app.request(`/api/contacts/${hiddenContact}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: false }),
      });
      const cleanup = getDb();
      cleanup.prepare("DELETE FROM events WHERE source = ?").run(SOURCE);
      cleanup.prepare("DELETE FROM events WHERE source = 'spotify-friends' AND source_id IN ('hidden-friend-listen', 'visible-friend-listen')").run();
      cleanup.prepare("DELETE FROM events WHERE source = 'discord' AND source_id IN ('guild-hidden-msg', 'guild-visible-msg')").run();
      cleanup.prepare("DELETE FROM discord_guild_emojis WHERE guild_id = ?").run(GUILD_ID);
      cleanup.prepare("DELETE FROM identities WHERE platform = 'discord' AND platform_id IN ('hidden-test-person', 'visible-test-person')").run();
      cleanup.prepare("DELETE FROM identities WHERE platform = 'spotify' AND platform_id IN ('hidden-test-spotify', 'visible-test-spotify')").run();
      cleanup.prepare("DELETE FROM contacts WHERE id IN (?, ?)").run(hiddenContact, visibleContact);
      cleanup.close();
      invalidateHiddenClauseCaches();
    }
  });

  test("deleting a hidden contact makes its events visible to cached aggregates", async () => {
    const source = "hidden-delete-source";
    const db = getDb();
    const contactId = Number(db.prepare(`
      INSERT INTO contacts (display_name, hidden) VALUES ('Deleted Hidden Contact', 0)
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO identities (platform, platform_id, display_name, contact_id)
      VALUES ('discord', 'deleted-hidden-person', 'Deleted Hidden Contact', ?)
    `).run(contactId);
    db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data)
      VALUES (?, 'deleted-hidden-event', 'test-account', 'test:event', ?, 'Deleted hidden event', ?, '{}')
    `).run(source, `${DATE}T09:00:00Z`, JSON.stringify(["discord:deleted-hidden-person"]));
    db.close();
    invalidateHiddenClauseCaches();

    const sourceTotals = async () => {
      const res = await app.request("/api/sources");
      expect(res.status).toBe(200);
      const json = (await res.json()) as { sources: Record<string, { total: number }> };
      return json.sources[source]?.total ?? 0;
    };

    try {
      const hide = await app.request(`/api/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      });
      expect(hide.status).toBe(200);
      // Fills the process-wide "sources" cache with the hidden-filtered totals.
      expect(await sourceTotals()).toBe(0);

      const remove = await app.request(`/api/contacts/${contactId}`, { method: "DELETE" });
      expect(remove.status).toBe(200);
      // Nothing hides the event any more, so the cached aggregate must refresh.
      expect(await sourceTotals()).toBe(1);
      // The manual cascade unlinks the identity rather than orphaning it on
      // a deleted contact id (which would drop it from the unlinked lists).
      const check = getDb();
      const identity = check.prepare(
        "SELECT contact_id FROM identities WHERE platform = 'discord' AND platform_id = 'deleted-hidden-person'",
      ).get() as { contact_id: number | null };
      check.close();
      expect(identity.contact_id).toBeNull();
    } finally {
      const cleanup = getDb();
      cleanup.prepare("DELETE FROM events WHERE source = ?").run(source);
      cleanup.prepare("DELETE FROM identities WHERE platform = 'discord' AND platform_id = 'deleted-hidden-person'").run();
      cleanup.prepare("DELETE FROM contacts WHERE id = ?").run(contactId);
      cleanup.close();
      invalidateHiddenClauseCaches();
    }
  });

  test("unlinking a hidden contact's identity refreshes cached source totals", async () => {
    const source = "hidden-unlink-source";
    const identifier = "discord:unlinked-hidden-person";
    const db = getDb();
    const contactId = Number(db.prepare(`
      INSERT INTO contacts (display_name, hidden) VALUES ('Unlinked Hidden Contact', 0)
    `).run().lastInsertRowid);
    db.prepare(`
      INSERT INTO identities (platform, platform_id, display_name, contact_id)
      VALUES ('discord', 'unlinked-hidden-person', 'Unlinked Hidden Contact', ?)
    `).run(contactId);
    db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data)
      VALUES (?, 'unlinked-hidden-event', 'test-account', 'test:event', ?, 'Unlinked hidden event', ?, '{}')
    `).run(source, `${DATE}T09:00:00Z`, JSON.stringify([identifier]));
    db.close();
    invalidateHiddenClauseCaches();

    const sourceTotals = async () => {
      const res = await app.request("/api/sources");
      expect(res.status).toBe(200);
      const json = (await res.json()) as { sources: Record<string, { total: number }> };
      return json.sources[source]?.total ?? 0;
    };

    try {
      const hide = await app.request(`/api/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      });
      expect(hide.status).toBe(200);
      expect(await sourceTotals()).toBe(0);

      const unlink = await app.request(`/api/identities/${encodeURIComponent(identifier)}/unlink`, { method: "POST" });
      expect(unlink.status).toBe(200);
      // The identity no longer belongs to a hidden contact, so its event
      // counts again and the cached aggregate must refresh.
      expect(await sourceTotals()).toBe(1);
    } finally {
      // Any contact PATCH purges the process-wide caches for later files.
      await app.request(`/api/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden: false }),
      });
      const cleanup = getDb();
      cleanup.prepare("DELETE FROM events WHERE source = ?").run(source);
      cleanup.prepare("DELETE FROM identities WHERE platform = 'discord' AND platform_id = 'unlinked-hidden-person'").run();
      cleanup.prepare("DELETE FROM contacts WHERE id = ?").run(contactId);
      cleanup.close();
      invalidateHiddenClauseCaches();
    }
  });
});
