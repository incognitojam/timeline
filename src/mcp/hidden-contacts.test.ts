import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initAppStateDb } from "../db/app-state";
import { wrapDatabase } from "../db/pool";
import { invalidateHiddenClauseCaches } from "../db/queries";
import { initDb } from "../db/schema";
import { Database } from "../db/sqlite";
import { registerTools } from "../mcp-tools";
import { withoutHiddenContactEvents, withoutHiddenWindows } from "./hidden-contacts";
import { setProjectUsesAccountMemory } from "../db/memory-notes";
import { memoryInstructions } from "./memory";

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

describe("hidden contacts: left out unprompted, included when named", () => {
  test("naming a hidden contact, by name, id or identifier, includes them", async () => {
    for (const who of ["Hana Hidden", "Hid", "1", "discord:900", "900"]) {
      const info = await text("get_contact_info", { contact: who });
      expect(info).toContain("Contact: Hana Hidden (ID: 1)");
      expect(info).toContain("Hidden: yes");
      const events = await text("query_events", { contact: who });
      expect(events).toContain("secret picnic plans");
      expect(events).toContain("hana says picnic at noon");
      expect(await text("query_events", { contact: who, group_by_conversation: true })).toContain("Hana Hidden: 1 hit");
    }
    for (const search of ["Hid", "discord:900", "900"]) {
      expect(await text("list_contacts", { search })).toStartWith("1. Hana Hidden (hidden) (");
    }
    // Saving a note with a hidden contact links it.
    expect(await text("save_memory_note", { name: "hana", kind: "person", title: "Hana", summary: "S", contact: "Hana Hidden" }))
      .toBe("Created memory: Hana (hana, account)");
    expect(appDb.prepare("SELECT contact_id FROM memory_notes WHERE name = 'hana'").get()).toEqual({ contact_id: 1 });
  });

  test("a visible contact keeps an everyday name, and a broad search never lists a hidden one", async () => {
    const smith = db.prepare("INSERT INTO contacts (display_name) VALUES ('Hana Smith')").run().lastInsertRowid;
    db.prepare("INSERT INTO identities (platform, platform_id, display_name, contact_id) VALUES ('discord', '902', 'Hana Smith', ?)").run(smith);
    expect(await text("get_contact_info", { contact: "Hana" })).toStartWith("Contact: Hana Smith");
    expect(await text("query_events", { contact: "Hana" })).not.toContain("secret picnic plans");
    for (const search of ["Hana", "a", "%", " "]) expect(await text("list_contacts", { search })).not.toContain("Hana Hidden");
    expect(await text("get_contact_info", { contact: " " })).toBe('Contact " " not found.');
    // Their exact name finds them, even beside a visible name that contains it.
    db.prepare("UPDATE contacts SET display_name = 'Hana Hidden Smith' WHERE id = ?").run(smith);
    expect(await text("get_contact_info", { contact: "hana hidden" })).toStartWith("Contact: Hana Hidden (ID: 1)");
    expect(await text("list_contacts", { search: "Hana Hidden" })).toStartWith("1. Hana Hidden (hidden) (");
  });

  test("list_contacts leaves hidden contacts out and says how many", async () => {
    const listed = await text("list_contacts", {});
    expect(listed).not.toContain("Hana Hidden");
    expect(listed).toContain("Vic Visible");
    expect(listed).toEndWith("1 hidden contact not listed; search by name to include one.");
    db.prepare("UPDATE contacts SET hidden = 0").run();
    expect(await text("list_contacts", {})).not.toContain("not listed");
  });

  test("an event of a hidden contact opened by id comes with its conversation and context", async () => {
    expect(await text("export_conversation", { event_id: ids.hiddenDm })).toContain("secret picnic plans");
    expect(await text("get_context", { event_id: ids.hiddenDm, hours_window: 1 })).toContain("secret picnic plans");
    // Another hidden contact's events stay out of that window.
    db.prepare("UPDATE contacts SET hidden = 1 WHERE display_name = 'Vic Visible'").run();
    invalidateHiddenClauseCaches();
    const window = await text("get_context", { event_id: ids.hiddenDm, hours_window: 1 });
    expect(window).toContain("secret picnic plans");
    expect(window).not.toContain("vic says");
    db.prepare("UPDATE contacts SET hidden = 0 WHERE display_name = 'Vic Visible'").run();
    invalidateHiddenClauseCaches();
    const group = await tools.get("get_context")!({ event_id: ids.hiddenGroup, same_conversation: true });
    expect(group.isError).toBeUndefined();
    expect(group.content[0].text).toContain("hana says picnic at noon");
  });

  test("notes linked to a hidden contact are left out of the lists, with a count, and read by name", async () => {
    appDb.prepare(`INSERT INTO memory_notes (project, name, kind, title, summary, details, contact_id, created_at, updated_at)
      VALUES ('', 'hana', 'person', 'Hana', 'secret picnic friend', 'likes picnics', 1, '2026-07-01', '2026-07-01')`).run();
    const listed = await text("list_memory", {});
    expect(listed).not.toContain("secret picnic friend");
    expect(listed).toEndWith("1 note about hidden contacts not listed; get_contact_info lists a contact's notes.");
    expect(memoryInstructions(appDb, { hiddenContactIds: new Set([1]) })).toContain("1 note about hidden contacts not listed");
    expect(memoryInstructions(appDb, { hiddenContactIds: new Set([1]) })).not.toContain("secret picnic friend");
    // A project with account memory off counts only its own notes.
    setProjectUsesAccountMemory(appDb, "solo", false);
    expect(await text("list_memory", { project: "solo" })).not.toContain("not listed");
    // An index cut short keeps the count.
    const insert = appDb.prepare(`INSERT INTO memory_notes (project, name, kind, title, summary, details, created_at, updated_at)
      VALUES ('', ?, 'topic', 'A topic with a long enough title', 'A summary long enough to fill the index quickly', '', '2026-07-01', '2026-07-01')`);
    for (let i = 0; i < 160; i++) insert.run(`topic-${i}`);
    const long = memoryInstructions(appDb, { hiddenContactIds: new Set([1]) });
    expect(long).toContain("The index is cut short here");
    expect(long).toContain("1 note about hidden contacts not listed");
    appDb.prepare("DELETE FROM memory_notes WHERE name LIKE 'topic-%'").run();
    expect(await text("get_contact_info", { contact: "Hana Hidden" })).toContain("hana: Hana — secret picnic friend");
    expect(await text("get_memory_note", { name: "hana" })).toContain("likes picnics");
    expect(await text("save_memory_note", { name: "hana", summary: "picnic friend" })).toBe("Updated memory: Hana (hana, account)");
    // A second note about them names the first, so an agent that missed it can merge them.
    expect(await text("save_memory_note", { name: "hana-hidden", kind: "person", title: "Hana Hidden", summary: "Vegetarian", contact: "Hana Hidden" }))
      .toBe("Created memory: Hana Hidden (hana-hidden, account)\nHana Hidden already has hana; if this repeats it, merge it there and delete this one.");
    expect(await text("delete_memory_note", { name: "hana-hidden" })).toBe("Deleted memory: Hana Hidden (hana-hidden, account)");
    expect(await text("delete_memory_note", { name: "hana" })).toBe("Deleted memory: Hana (hana, account)");
    expect(await text("list_memory", {})).not.toContain("not listed");
  });

  test("broad searches leave out a hidden contact's DMs and own group messages, and name them where a visible one does", async () => {
    for (const args of [{ query: "picnic" }, { date: "2026-07-03" }, { source: "discord" }]) {
      const out = await text("query_events", args);
      expect(out).toContain("vic says picnic sounds good, ask @Hana Hidden");
      expect(out).not.toContain("secret picnic plans");
      expect(out).not.toContain(`#${ids.hiddenGroup} `);
    }
    const grouped = await text("query_events", { query: "picnic", group_by_conversation: true });
    expect(grouped).toContain("[discord] picnic crew: 2 hits"); // the visible reply and the forward
    expect(await text("query_events", { contact: "Vic Visible" })).not.toContain(`#${ids.hiddenGroup} `);
    const context = await text("get_context", { event_id: ids.visibleGroup });
    expect(context).toContain("vic says picnic sounds good, ask @Hana Hidden");
    expect(context).not.toContain("secret picnic plans");
    expect(context).not.toContain(`#${ids.hiddenGroup} `);
  });

  test("a conversation opened by id shows everyone's messages, with real names", async () => {
    const group = await text("export_conversation", { event_id: ids.visibleGroup });
    expect(group).toContain("<Hana Hidden> hana says picnic at noon");
    expect(group).toContain('"hana says picnic at noon") vic says picnic sounds good, ask @Hana Hidden');
    expect(await text("export_conversation", { conversation_id: "group-1" })).toContain("<Hana Hidden> hana says picnic at noon");
    expect(await text("export_conversation", { conversation_id: "dm-hana" })).toContain("secret picnic plans");
    const context = await text("get_context", { event_id: ids.visibleGroup, same_conversation: true });
    expect(context).toContain("hana says picnic at noon");
    const updates = await text("get_updates", { since: "id:0", conversation_id: "group-1" });
    expect(updates).toContain("<Hana Hidden> hana says picnic at noon");
    expect(await text("get_updates", { since: "id:0", conversation_id: "dm-hana" })).toContain("secret picnic plans");
    // A catch-up across everything still leaves them out.
    const catchUp = await text("get_updates", { since: "id:0" });
    expect(catchUp).toContain("vic says picnic sounds good");
    expect(catchUp).not.toContain("secret picnic plans");
    expect(catchUp).not.toContain("<Hana Hidden>");
  });

  test("get_schema reads every event", async () => {
    expect(await text("get_schema", { source: "discord" })).toContain("message:dm 1");
    expect(await text("get_schema", { source: "discord", type: "message:group" })).toContain("hana says picnic at noon");
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

  test("semantic_search drops a conversation window holding a hidden contact's own message", async () => {
    const windows = [
      [ids.visibleGroup], // mentions them
      [ids.visibleGroup, ids.hiddenGroup], // their own message
      [ids.visibleForward], // a forward of it, by someone visible
      [ids.visibleGroup, 999_999], // a message since deleted
      [ids.hiddenDm],
    ].map((eventIds) => ({ eventIds }));
    expect(await withoutHiddenWindows(wrapDatabase(db), windows)).toEqual([
      { eventIds: [ids.visibleGroup] },
      { eventIds: [ids.visibleForward] },
    ]);
  });
});
