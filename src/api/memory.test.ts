import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initAppStateDb } from "../db/app-state";
import { createContact, deleteContact } from "../db/contacts";
import { getMemoryNote, saveMemoryNote } from "../db/memory-notes";
import { wrapDatabase } from "../db/pool";
import { initDb } from "../db/schema";
import { Database } from "../db/sqlite";
import { registerTools } from "../mcp-tools";
import type { MemoryIndexWithContacts, MemoryNote, MemoryVersion } from "../shared/memory";
import { createMemoryRoutes } from "./memory";

let appDb: Database;
let timelineDb: Database;
let app: ReturnType<typeof createMemoryRoutes>;

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function index(): Promise<MemoryIndexWithContacts> {
  return (await app.request("/api/memory")).json() as Promise<MemoryIndexWithContacts>;
}

async function versions(name: string, project = ""): Promise<MemoryVersion[]> {
  const res = await app.request(`/api/memory/notes/${name}/versions?project=${project}`);
  return ((await res.json()) as { versions: MemoryVersion[] }).versions;
}

beforeEach(() => {
  appDb = new Database(":memory:");
  initAppStateDb(appDb);
  timelineDb = new Database(":memory:");
  initDb(timelineDb);
  app = createMemoryRoutes(wrapDatabase(timelineDb), () => appDb);
  saveMemoryNote(appDb, { project: "", name: "tone", kind: "you", title: "Tone", summary: "Plain and short" });
  saveMemoryNote(appDb, { project: "", name: "rowan", kind: "person", title: "Rowan Hale", summary: "Climbing partner", contactId: 2 });
  saveMemoryNote(appDb, { project: "garden-app", name: "overview", kind: "project", title: "Garden app", summary: "Watering planner" });
});

afterEach(() => {
  appDb.close();
  timelineDb.close();
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

/** The MCP tools as an agent calls them, over the same databases. */
function agentTools() {
  const tools = new Map<string, Handler>();
  const server = { tool: (name: string, _d: string, _s: unknown, _a: unknown, handler: Handler) => tools.set(name, handler) } as unknown as McpServer;
  registerTools(server, wrapDatabase(timelineDb), { appStateDb: appDb });
  return async (name: string, args: Record<string, unknown>) => {
    const handler = tools.get(name);
    if (!handler) throw new Error(`${name} is not registered`);
    return (await handler(args)).content[0].text;
  };
}

describe("memory API", () => {
  test("index lists account notes, each project's notes and the switch", async () => {
    const { account, projects, deleted } = await index();
    expect(account.map((note) => note.name)).toEqual(["rowan", "tone"]);
    expect(account[0].contact_id).toBe(2);
    expect(projects).toEqual([{ key: "garden-app", useAccountMemory: true, notes: [expect.objectContaining({ name: "overview" })] }]);
    expect(deleted).toEqual([]);
  });

  test("reads and updates a note, refusing what the store refuses", async () => {
    const read = await app.request("/api/memory/notes/overview?project=garden-app");
    expect(((await read.json()) as { note: MemoryNote }).note.title).toBe("Garden app");
    expect((await app.request("/api/memory/notes/overview")).status).toBe(404);

    const updated = await app.request("/api/memory/notes/tone", json("PATCH", { summary: "Plain, short, direct", details: "See [[rowan]]" }));
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { note: MemoryNote }).note).toMatchObject({ title: "Tone", summary: "Plain, short, direct", details: "See [[rowan]]" });

    const multiline = await app.request("/api/memory/notes/tone", json("PATCH", { title: "Two\nlines" }));
    expect(multiline.status).toBe(400);
    expect(await multiline.json()).toEqual({ error: "Note title must be one line of plain text." });
    expect((await app.request("/api/memory/notes/tone", json("PATCH", { kind: "project" }))).status).toBe(400);
    expect((await app.request("/api/memory/notes/missing", json("PATCH", { title: "New" }))).status).toBe(404);
    expect((await app.request("/api/memory/notes/missing", json("PATCH", { kind: "topic", title: "New", summary: "New" }))).status).toBe(404);
    expect((await app.request("/api/memory/notes/tone", json("PATCH", []))).status).toBe(400);
    expect((await index()).account.map((note) => note.name)).toEqual(["rowan", "tone"]);
  });

  test("restores an earlier version, keeping the one it replaces", async () => {
    await app.request("/api/memory/notes/tone", json("PATCH", { summary: "Second" }));
    await app.request("/api/memory/notes/tone", json("PATCH", { summary: "Third" }));
    const [second, first] = await versions("tone");
    expect([second.summary, first.summary]).toEqual(["Second", "Plain and short"]);

    const restored = await app.request(`/api/memory/versions/${first.id}/restore`, { method: "POST" });
    expect(((await restored.json()) as { note: MemoryNote }).note.summary).toBe("Plain and short");
    expect((await versions("tone")).map((version) => version.summary)).toEqual(["Third", "Second", "Plain and short"]);
    expect((await app.request("/api/memory/versions/999/restore", { method: "POST" })).status).toBe(404);
  });

  test("a deleted note is listed as recently deleted and comes back on restore", async () => {
    expect((await app.request("/api/memory/notes/rowan", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/api/memory/notes/rowan", { method: "DELETE" })).status).toBe(404);
    const { account, deleted } = await index();
    expect(account.map((note) => note.name)).toEqual(["tone"]);
    expect(deleted).toEqual([expect.objectContaining({ name: "rowan", project: "", title: "Rowan Hale" })]);

    await app.request(`/api/memory/versions/${deleted[0].id}/restore`, { method: "POST" });
    const after = await index();
    expect(after.account.find((note) => note.name === "rowan")).toMatchObject({ summary: "Climbing partner", contact_id: 2 });
    expect(after.deleted).toEqual([]);
  });

  test("switching account memory off for a project leaves only its notes in list_memory", async () => {
    const agent = agentTools();
    const listMemory = (args: Record<string, unknown>) => agent("list_memory", args);

    expect(await listMemory({ project: "garden-app" })).toContain("- tone: Tone");
    const off = await app.request("/api/memory/projects/garden-app", json("PUT", { useAccountMemory: false }));
    expect(off.status).toBe(200);
    expect((await index()).projects[0].useAccountMemory).toBe(false);

    const project = await listMemory({ project: "garden-app" });
    expect(project).toContain("- overview: Garden app");
    expect(project).not.toContain("tone");
    expect(project).toContain("switched account notes off for this project");
    expect(await listMemory({})).toContain("- tone: Tone");
    expect(await listMemory({ project: "other-app" })).toContain("- tone: Tone");

    // Deleting the project's last note keeps it listed, so the switch can be turned back on.
    await app.request("/api/memory/notes/overview?project=garden-app", { method: "DELETE" });
    expect((await index()).projects).toEqual([{ key: "garden-app", useAccountMemory: false, notes: [] }]);
    await app.request("/api/memory/projects/garden-app", json("PUT", { useAccountMemory: true }));
    expect((await index()).projects).toEqual([]);
    expect(await listMemory({ project: "garden-app" })).toContain("- tone: Tone");
    expect((await app.request("/api/memory/projects/Not%20A%20Key", json("PUT", { useAccountMemory: false }))).status).toBe(400);
  });

  test("links a person note to a contact, keeping it from agents while the contact is hidden", async () => {
    const agent = agentTools();
    createContact(timelineDb, "Kit Marsh");
    const rowan = createContact(timelineDb, "Rowan Hale");
    expect(rowan).toBe(2);
    const sam = createContact(timelineDb, "Sam Quill");
    const hidden = createContact(timelineDb, "Dana Hidden");
    timelineDb.prepare("UPDATE contacts SET hidden = 1 WHERE id = ?").run(hidden);
    saveMemoryNote(appDb, { project: "", name: "dana", kind: "person", title: "Dana", summary: "Old friend" });
    const patch = (body: unknown, name = "dana") => app.request(`/api/memory/notes/${name}`, json("PATCH", body));
    // A contact change says whether agents could read the note before and can after, as the page showed it.
    const link = (contactId: unknown, agentsCouldRead: boolean, agentsCanRead: boolean, name = "dana") =>
      patch({ contactId, agentsCouldRead, agentsCanRead }, name);
    const readable = async () => !(await agent("get_memory_note", { name: "dana" })).startsWith("Error") && (await agent("list_memory", {})).includes("- dana:");

    // The index names each linked note's contact.
    expect((await index()).contacts).toEqual({ [rowan]: { id: rowan, name: "Rowan Hale", hidden: false } });
    expect((await link(sam, true, true)).status).toBe(200);
    expect((await index()).contacts[sam]).toEqual({ id: sam, name: "Sam Quill", hidden: false });
    expect(await readable()).toBe(true);

    // A page that thinks the hidden contact is visible is refused.
    expect((await link(hidden, true, true)).status).toBe(409);
    const linked = await link(hidden, true, false);
    expect(((await linked.json()) as { note: MemoryNote }).note.contact_id).toBe(hidden);
    expect((await index()).contacts[hidden]).toEqual({ id: hidden, name: "Dana Hidden", hidden: true });
    expect(await readable()).toBe(false);
    // Each change is a version, as other edits are; only the owner's page lists them.
    const [unhiddenVersion] = await versions("dana");
    expect((await versions("dana")).map((version) => version.contact_id)).toEqual([sam, null]);
    // Restoring an earlier version's text keeps the note's contact, so the note stays kept from agents.
    expect((await app.request(`/api/memory/versions/${unhiddenVersion.id}/restore`, { method: "POST" })).status).toBe(200);
    expect(getMemoryNote(appDb, "", "dana")?.contact_id).toBe(hidden);
    expect(await readable()).toBe(false);

    // Unlinking from a hidden contact is refused unless the page said agents could not read it before.
    expect((await link(null, true, true)).status).toBe(409);
    expect((await link(null, false, true)).status).toBe(200);
    expect(getMemoryNote(appDb, "", "dana")?.contact_id).toBeNull();
    expect(await readable()).toBe(true);
    // Only the named note changed.
    expect(getMemoryNote(appDb, "", "rowan")?.contact_id).toBe(rowan);

    expect(await (await link(sam, true, true, "tone")).json()).toEqual({ error: "Only a note about a person can be linked to a contact." });
    expect(await (await patch({ kind: "topic", contactId: sam, agentsCouldRead: true, agentsCanRead: true })).json()).toEqual({ error: "Only a note about a person can be linked to a contact." });
    // A linked person note cannot become another kind while it keeps its contact.
    expect(await (await patch({ kind: "topic" }, "rowan")).json()).toEqual({ error: "Only a note about a person can be linked to a contact." });
    expect((await patch({ contactId: sam })).status).toBe(400);
    deleteContact(timelineDb, sam);
    expect(await (await link(sam, true, true)).json()).toEqual({ error: "That contact is no longer in your contacts." });
    expect((await link("1", true, true)).status).toBe(400);
    expect((await link(1.5, true, true)).status).toBe(400);
    expect((await link(rowan, true, true, "missing")).status).toBe(404);
    expect(getMemoryNote(appDb, "", "dana")).toMatchObject({ kind: "person", contact_id: null });
    expect(getMemoryNote(appDb, "", "tone")?.contact_id).toBeNull();
  });
});
