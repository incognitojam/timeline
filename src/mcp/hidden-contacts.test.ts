import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initAppStateDb } from "../db/app-state";
import { wrapDatabase } from "../db/pool";
import { invalidateHiddenClauseCaches } from "../db/queries";
import { initDb } from "../db/schema";
import { Database } from "../db/sqlite";
import { registerTools } from "../mcp-tools";
import { withoutHiddenContactEvents, withoutHiddenWindows } from "./hidden-contacts";
import { getMcpSession, getMcpSessionStats, listMcpToolCalls, recordMcpToolCall, upsertMcpSession } from "./recording";
import { renderMcpSessionMarkdown } from "./render";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;

let db: Database;
let appDb: Database;
let tools: Map<string, Handler>;
const ids: Record<string, number> = {};

const text = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!(args)).content[0].text;

beforeEach(() => {
  db = new Database(":memory:");
  initDb(db);
  appDb = new Database(":memory:");
  initAppStateDb(appDb);
  const contact = (name: string, hidden: number, discordId: string) => {
    const id = Number(db.prepare("INSERT INTO contacts (display_name, hidden) VALUES (?, ?)").run(name, hidden).lastInsertRowid);
    db.prepare("INSERT INTO identities (platform, platform_id, display_name, contact_id) VALUES ('discord', ?, ?, ?)").run(discordId, name, id);
  };
  contact("Hana Hidden", 1, "900");
  contact("Vic Visible", 0, "901");
  const insert = db.prepare(`
    INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, people, raw_data, conversation_id)
    VALUES ('discord', ?, 'me', ?, ?, ?, ?, ?, ?, ?)
  `);
  const event = (key: string, type: string, at: string, title: string, content: string, people: string[], conversation: string, sourceId = key, raw = {}) => {
    ids[key] = Number(insert.run(sourceId, type, `2026-07-03T${at}:00.000Z`, title, content, JSON.stringify(people), JSON.stringify(raw), conversation).lastInsertRowid);
  };
  event("hiddenDm", "message:dm", "10:00", "Hana Hidden", "secret picnic plans", ["discord:900", "discord:me"], "dm-hana");
  event("hiddenGroup", "message:group", "10:05", "picnic crew", "hana says picnic at noon", ["discord:900", "discord:901", "discord:me"], "group-1", "1001");
  // A visible reply to the hidden message, whose export would quote it.
  event("visibleGroup", "message:group", "10:10", "picnic crew", "vic says picnic sounds good, ask <@900>", ["discord:901", "discord:900", "discord:me"], "group-1", "1002", {
    message_reference: { message_id: "1001" },
    referenced_message: { content: "hana says picnic at noon", author: { id: "900", username: "hidden_handle" } },
    mentions: [{ id: "900", username: "hidden_handle" }],
  });
  // A visible forward of the hidden message carries its text.
  event("visibleForward", "message:group:forward", "10:15", "picnic crew", "hana says picnic at noon", ["discord:901", "discord:me"], "group-1", "1003", {
    message_reference: { type: 1, message_id: "1001" },
    message_snapshots: [{ message: { content: "hana says picnic at noon" } }],
  });
  invalidateHiddenClauseCaches();

  tools = new Map();
  const server = { tool: (name: string, _d: unknown, _s: unknown, _a: unknown, handler: Handler) => tools.set(name, handler) } as unknown as McpServer;
  registerTools(server, wrapDatabase(db), { appStateDb: appDb });
});

afterEach(() => {
  db.close();
  appDb.close();
  invalidateHiddenClauseCaches();
});

describe("hidden contacts in the named MCP tools", () => {
  test("asking for a hidden contact or their note reads exactly as asking for one that does not exist", async () => {
    appDb.prepare(`INSERT INTO memory_notes (project, name, kind, title, summary, details, contact_id, created_at, updated_at)
      VALUES ('', 'hana', 'person', 'Hana', 'secret picnic friend', '', 1, '2026-07-01', '2026-07-01')`).run();
    const reply = async (name: string, args: Record<string, unknown>) => {
      const result = await tools.get(name)!(args);
      return { isError: result.isError ?? false, text: result.content.map((c) => c.text).join("\n") };
    };
    // [tool, arguments with the hidden contact or note, the same with someone unknown]
    const pairs: [string, (who: string) => Record<string, unknown>, string, string][] = [];
    for (const [hidden, unknown] of [["Hana Hidden", "Zara Nobody"], ["Hid", "Zar"], ["1", "999"], ["discord:900", "discord:999"], ["900", "999"]]) {
      pairs.push(["get_contact_info", (who) => ({ contact: who }), hidden, unknown]);
      pairs.push(["query_events", (who) => ({ contact: who }), hidden, unknown]);
      pairs.push(["query_events", (who) => ({ contact: who, group_by_conversation: true }), hidden, unknown]);
      pairs.push(["list_contacts", (who) => ({ search: who }), hidden, unknown]);
      pairs.push(["save_memory_note", (who) => ({ name: "someone-new", kind: "person", title: "T", summary: "S", contact: who }), hidden, unknown]);
    }
    pairs.push(["get_memory_note", (who) => ({ name: who }), "hana", "zara"]);
    pairs.push(["delete_memory_note", (who) => ({ name: who }), "hana", "zara"]);
    pairs.push(["save_memory_note", (who) => ({ name: who, summary: "changed" }), "hana", "zara"]);
    // Calls that could not create a note anyway fail as they would for a free name.
    pairs.push(["save_memory_note", (who) => ({ name: who, summary: "x", contact: "Zara Nobody" }), "hana", "zara"]);
    pairs.push(["save_memory_note", (who) => ({ name: who, kind: "person", title: "T", summary: "S", contact: "Zara Nobody" }), "hana", "zara"]);
    const compare = async () => {
      for (const [name, args, hidden, unknown] of pairs) {
        const forHidden = await reply(name, args(hidden));
        const forUnknown = await reply(name, args(unknown));
        expect({ name, ...forHidden, text: forHidden.text.replaceAll(hidden, unknown) }).toEqual({ name, ...forUnknown });
      expect(forHidden.text.replaceAll(hidden, "").toLowerCase()).not.toContain("hidden");
      }
    };
    await compare();
    // The one reply that differs: creating a note under the hidden one's name must not overwrite it.
    const taken = await reply("save_memory_note", { name: "hana", kind: "person", title: "T", summary: "S" });
    expect(taken).toEqual({ isError: true, text: 'Error: Note "hana" can\'t be saved: the name is taken.' });

    // At the note limit, that call could not create a note either.
    const insert = appDb.prepare(`INSERT INTO memory_notes (project, name, kind, title, summary, details, created_at, updated_at)
      VALUES ('', ?, 'topic', 'T', 'S', '', '2026-07-01', '2026-07-01')`);
    for (let i = 1; i < 500; i++) insert.run(`filler-${i}`);
    pairs.length = 0;
    pairs.push(["save_memory_note", (who) => ({ name: who, kind: "person", title: "T", summary: "S" }), "hana", "zara"]);
    await compare();
  });

  test("contact and memory tools list nothing of a hidden contact's", async () => {
    db.prepare("INSERT INTO contacts (display_name) VALUES ('Hana Smith')").run();
    // One visible match resolves to it, so a one-name "multiple" list cannot betray a hidden one.
    expect(await text("get_contact_info", { contact: "Hana" })).toContain("Contact: Hana Smith");
    expect(await text("get_contact_info", { contact: "Hana" })).not.toContain("Hana Hidden");
    appDb.prepare(`INSERT INTO memory_notes (project, name, kind, title, summary, details, contact_id, created_at, updated_at)
      VALUES ('', 'hana', 'person', 'Hana', 'secret picnic friend', '', 1, '2026-07-01', '2026-07-01')`).run();
    expect(await text("list_memory", {})).not.toContain("secret picnic friend");
    expect(await text("get_memory_note", { name: "hana" })).toContain('No note named "hana"');

    expect(await text("list_contacts", {})).not.toContain("Hana Hidden");
    expect(await text("list_contacts", { search: "900" })).toBe("No contacts found.");
  });

  test("query_events leaves out a hidden contact's DMs and own group messages, keeping the group", async () => {
    for (const args of [{ query: "picnic" }, { date: "2026-07-03" }, { source: "discord" }]) {
      const out = await text("query_events", args);
      expect(out).toContain("vic says picnic sounds good");
      expect(out).not.toContain("secret picnic plans");
      expect(out).not.toContain("hana says");
    }
    const grouped = await text("query_events", { query: "picnic", group_by_conversation: true });
    expect(grouped).toContain("[discord] picnic crew: 2 hits"); // the visible reply and the forward
    expect(grouped).not.toContain("Hana");
    expect(await text("query_events", { contact: "Vic Visible" })).not.toContain("hana says");
  });

  test("get_context and export_conversation leave out the hidden contact's events", async () => {
    const context = await text("get_context", { event_id: ids.visibleGroup });
    expect(context).toContain("vic says");
    expect(context).not.toContain("@Hana Hidden");
    expect(context).not.toContain("hidden_handle");
    expect((await tools.get("get_context")!({ event_id: ids.hiddenGroup, same_conversation: true })).isError).toBe(true);
    expect(context).not.toContain("secret picnic plans");
    expect(context).not.toContain("hana says");

    // A reply to the forward would quote its text, and an image described under the forward would show it.
    db.prepare(`INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, people, raw_data, conversation_id)
      VALUES ('discord', '1004', 'me', 'message:group', '2026-07-03T10:20:00.000Z', 'picnic crew', 'vic replies to the forward', '["discord:901"]', ?, 'group-1')`)
      .run(JSON.stringify({ message_reference: { message_id: "1003" } }));
    db.prepare("INSERT INTO attachment_descriptions (content_hash, model, description, created_at) VALUES ('h1', 'm', 'a picnic map in hana''s hand', '2026-07-03')").run();
    db.prepare(`INSERT INTO attachments (event_id, source, source_id, content_hash, mime_type, storage_path, status)
      VALUES (?, 'discord', 'a1', 'h1', 'image/png', 'discord/a1.png', 'stored')`).run(ids.visibleForward);

    const group = await text("export_conversation", { event_id: ids.visibleGroup });
    expect(group).toContain("vic replies to the forward");
    expect(group).not.toContain("picnic map");
    expect(group).toContain("vic says picnic sounds good");
    expect(group).not.toContain("hana says");
    expect(group).not.toContain("@Hana Hidden");
    expect(group).not.toContain("hidden_handle");
    expect(await text("export_conversation", { event_id: ids.hiddenDm })).toContain(`No event found with id ${ids.hiddenDm}`);
    expect(await text("export_conversation", { conversation_id: "dm-hana" })).not.toContain("secret picnic plans");
  });

  test("get_schema's samples leave out a hidden contact's events", async () => {
    expect(await text("get_schema", { source: "discord", type: "message:dm" })).toBe('No events found for source="discord" type="message:dm"');
    // A visible reply's raw_data embeds the hidden message it answers.
    const sample = await text("get_schema", { source: "discord", type: "message:group" });
    expect(sample).toContain("$.referenced_message.content");
    expect(sample).not.toContain("hana says");
    expect(sample).not.toContain("hidden_handle");
  });

  test("a contact hidden after a call is left out of the next one", async () => {
    db.prepare("UPDATE contacts SET hidden = 0").run();
    invalidateHiddenClauseCaches();
    expect(await text("query_events", { query: "picnic" })).toContain("secret picnic plans");
    db.prepare("UPDATE contacts SET hidden = 1 WHERE display_name = 'Hana Hidden'").run();
    expect(await text("query_events", { query: "picnic" })).not.toContain("secret picnic plans");
  });

  test("semantic_search's filter drops hits filed under a hidden contact", async () => {
    const kept = await withoutHiddenContactEvents(wrapDatabase(db), [{ id: ids.hiddenDm }, { id: ids.visibleGroup }, { id: ids.hiddenGroup }]);
    expect(kept).toEqual([{ id: ids.visibleGroup }]);
  });

  test("semantic_search drops a conversation window whose snippet could show a hidden contact", async () => {
    const plain = Number(db.prepare(`INSERT INTO events (source, source_id, source_account, type, timestamp, content, people, raw_data, conversation_id)
      VALUES ('discord', '1005', 'me', 'message:group', '2026-07-03T10:25:00.000Z', 'vic brings snacks', '["discord:901"]', '{}', 'group-1')`).run().lastInsertRowid);
    const windows = [
      [plain],
      [plain, ids.hiddenGroup], // their own message
      [plain, ids.visibleForward], // a forward of it
      [plain, ids.visibleGroup], // a mention of them
      [plain, 999_999], // a message since deleted
    ].map((eventIds) => ({ eventIds }));
    expect(await withoutHiddenWindows(wrapDatabase(db), windows)).toEqual([{ eventIds: [plain] }]);
  });

  test("semantic_search drops a conversation window with a poll a hidden contact voted in", async () => {
    const poll = Number(db.prepare(`INSERT INTO events (source, source_id, source_account, type, timestamp, content, people, raw_data, conversation_id)
      VALUES ('discord', '1006', 'me', 'message:group:poll', '2026-07-03T10:30:00.000Z', '', '["discord:901"]', ?, 'group-1')`).run(JSON.stringify({
      poll: {
        question: { text: "Where?" },
        answers: [{ answer_id: 1, poll_media: { text: "Park" } }],
        allow_multiselect: false,
        voters: { answers: { 1: [{ id: "900", name: "Hana Hidden", username: "hidden_handle", avatar: null }] } },
      },
    })).lastInsertRowid);
    expect(await withoutHiddenWindows(wrapDatabase(db), [{ eventIds: [poll] }])).toEqual([]);
  });

  test("get_context around a hidden event reads as around a missing one", async () => {
    const missing = await text("get_context", { event_id: 999_999, hours_window: 1 });
    expect(await text("get_context", { event_id: ids.hiddenDm, hours_window: 1 })).toBe(missing);
  });

  test("get_updates treats a hidden contact's conversation id as unknown", async () => {
    expect(await text("get_updates", { since: "id:0", conversation_id: "dm-hana" })).toContain('No conversation has conversation_id "dm-hana"');
  });

  test("get_schema(source) does not count a hidden contact's events", async () => {
    expect(await text("get_schema", { source: "discord" })).not.toContain("message:dm");
  });
});

describe("recorded MCP tool calls", () => {
  test("nothing a call returned, nor a note's saved content, is readable once its contact is hidden or the note deleted", async () => {
    db.prepare("UPDATE contacts SET hidden = 0 WHERE display_name = 'Hana Hidden'").run();
    const sessionId = "stdio:test";
    upsertMcpSession({ id: sessionId, transport: "stdio" }, appDb);
    const recorded = new Map<string, Handler>();
    const server = { tool: (name: string, _d: unknown, _s: unknown, _a: unknown, handler: Handler) => recorded.set(name, handler) } as unknown as McpServer;
    registerTools(server, wrapDatabase(db), {
      appStateDb: appDb,
      defaultSessionId: () => sessionId,
      recordToolCall: (rec) => recordMcpToolCall({ ...rec, sessionId }, appDb),
    });
    const call = async (name: string, args: Record<string, unknown>) => (await recorded.get(name)!(args)).content[0].text;

    await call("save_memory_note", { name: "hana", kind: "person", title: "Hana", summary: "picnic organiser", details: "allergic to walnuts", contact: "Hana Hidden" });
    await call("save_memory_note", { name: "scratch", kind: "topic", title: "Scratch", summary: "burner", details: "the spare key is under the mat" });
    expect(await call("get_memory_note", { name: "hana" })).toContain("allergic to walnuts");
    expect(await call("query_events", { contact: "Hana Hidden" })).toContain("secret picnic plans");
    expect(await call("get_context", { event_id: ids.hiddenGroup })).toContain("hana says picnic at noon");
    await call("delete_memory_note", { name: "scratch" });
    // A call to the retired remember_contact_fact, still in the log.
    recordMcpToolCall({ sessionId, toolName: "remember_contact_fact", args: { contact: "Hana Hidden", fact: "picnic organiser" }, resultText: "Saved", isError: false, durationMs: 1 }, appDb);
    db.prepare("UPDATE contacts SET hidden = 1 WHERE display_name = 'Hana Hidden'").run();

    const secrets = ["secret picnic plans", "hana says picnic", "allergic to walnuts", "picnic organiser", "spare key", "burner"];
    const searches: Record<string, unknown>[] = [
      {}, { session_id: "current" }, { session_id: sessionId }, { errors_only: true }, { sessions: true },
      ...["save_memory_note", "get_memory_note", "query_events", "get_context", "delete_memory_note", "remember_contact_fact"].map((tool_name) => ({ tool_name })),
    ];
    for (const args of searches) {
      const out = await call("search_mcp_tool_calls", args);
      for (const secret of secrets) expect({ args, leaked: out.includes(secret) ? secret : null }).toEqual({ args, leaked: null });
      expect(out).not.toContain("Result chars");
    }
    // An agent still sees which calls were made, with what it asked for.
    const all = await call("search_mcp_tool_calls", { tool_name: "save_memory_note" });
    expect(all).toContain('"name": "hana"');
    expect(all).toContain('"contact": "Hana Hidden"');

    // The owner's sessions page keeps every call's result.
    const owner = renderMcpSessionMarkdown(
      getMcpSession(sessionId, appDb)!,
      listMcpToolCalls(sessionId, { limit: 50, offset: 0 }, appDb),
      getMcpSessionStats(sessionId, appDb),
    );
    expect(owner).toContain("allergic to walnuts");
    expect(owner).toContain("secret picnic plans");
  });
});
