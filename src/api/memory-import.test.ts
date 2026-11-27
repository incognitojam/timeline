import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAppStateDb } from "../db/app-state";
import { createContact } from "../db/contacts";
import { getMemoryNote, MEMORY_LIMITS, saveMemoryNote } from "../db/memory-notes";
import { wrapDatabase } from "../db/pool";
import { initDb } from "../db/schema";
import { Database } from "../db/sqlite";
import type { MemoryImportResult } from "../shared/memory";
import { createMemoryRoutes } from "./memory";

const ACCOUNT = "00000000-0000-4000-8000-000000000000";
const GARDEN = "11111111-1111-4111-8111-111111111111";
const READING = "22222222-2222-4222-8222-222222222222";
const AT = "2026-09-12T10:15:30.123456+00:00";

const file = (path: string, frontmatter: string, body = "") => ({ path, content: `---\n${frontmatter}\n---\n${body}`, updated_at: AT });
const note = (path: string, name: string, description: string, body = "", aliases = "[]") =>
  file(path, `name: ${name}\ndescription: ${description}\nsources: [backfill, chat]\naliases: ${aliases}`, body);

const LONG_BODY = `## Suppliers\n${"- Meter readings go in the shared sheet\n".repeat(230)}`;

function exportJson(memoryFiles: ReturnType<typeof file>[]) {
  return {
    account_uuid: ACCOUNT,
    conversations_memory: "Older prose summary, not imported.",
    project_memories: { [GARDEN]: "**Purpose & context**\n\nNot imported." },
    memory_files: memoryFiles,
  };
}

const EXPORT = exportJson([
  note("/preferences.md", "preferences", "Plain answers, metric units"),
  note("/profile.md", "profile", '"Alex: engineer, climber, gardener"', "## Work\n- Engineer at a small studio\n"),
  note("/topics/climbing.md", "climbing", "Sport climbing grades and trips", "- Climbs with [[alice-b]] and [[bob]]\n"),
  note("/areas/home-and-utilities.md", "home-and-utilities", "Bills, meters and suppliers", LONG_BODY),
  note("/people/alice-b.md", "alice-b", "Climbing partner Alice Brown", "## Climbing\n- Leads up to 6b; shares a rack with [[bob]]\n", "[Alice Brown, Ali]"),
  note("/people/bob.md", "bob", "Friend from the climbing wall"),
  file(`/projects/${GARDEN}/index.md`, 'name: "Garden Planner"\ndescription: Watering and planting planner\nsources: [backfill]\naliases: []'),
  note(`/projects/${GARDEN}/watering.md`, "watering", "Watering schedule decisions", "- Drip lines on a timer\n"),
  note(`/projects/${GARDEN}/topics/soil.md`, "soil", "Soil mix notes"),
  note(`/projects/${GARDEN}/areas/beds.md`, "beds", "Raised beds layout"),
  note(`/projects/${GARDEN}/people/carol.md`, "carol", "Neighbour who shares seedlings"),
  file(`/projects/${READING}/index.md`, 'name: "Reading List"\ndescription: Books to read'),
  note(`/projects/${READING}/overview.md`, "overview", "What the reading list is for", "- Fiction first\n"),
]);

let appDb: Database;
let timelineDb: Database;
let app: ReturnType<typeof createMemoryRoutes>;
let dir: string;
let aliceId: number;

/** memories-000.zip as claude.ai exports it, built with zip(1). */
async function zipOf(value: unknown): Promise<Uint8Array> {
  const root = mkdtempSync(join(dir, "export-"));
  mkdirSync(join(root, "memories"));
  writeFileSync(join(root, "memories", `${ACCOUNT}.json`), JSON.stringify(value));
  const proc = Bun.spawn(["zip", "-q", "-r", "memories-000.zip", "memories"], { cwd: root });
  if ((await proc.exited) !== 0) throw new Error("zip failed");
  return new Uint8Array(await Bun.file(join(root, "memories-000.zip")).arrayBuffer());
}

/** A zip of these entries, stored uncompressed and named exactly as given, so tests can add names zip(1) would not. */
function storedZip(entries: [string, string | Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content as string);
    const header = (signature: number, size: number) => {
      const out = Buffer.alloc(size);
      out.writeUInt32LE(signature, 0);
      return out;
    };
    const local = header(0x04034b50, 30);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(Bun.hash.crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = header(0x02014b50, 46);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    local.copy(entry, 16, 14, 26);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}

/**
 * claude-memory-<date>.zip as claude.ai's Export memory downloads it: the
 * data export's memory files as Markdown below one dated folder, each project
 * folder named by the project's title.
 */
function memoryExportZip(files: { path: string; content: string }[], titles: Record<string, string> = { [GARDEN]: "Garden Planner", [READING]: "Reading List" }, root = "claude-memory-2026-11-27/"): Uint8Array {
  return storedZip([[root, ""], ...files.map((file): [string, string] => [`${root}${file.path.slice(1).replace(/^projects\/([^/]+)/, (_, id: string) => `projects/${titles[id] ?? id}`)}`, file.content])]);
}

type Response = { status: number; body: MemoryImportResult & { error?: string } };

async function upload(body: Uint8Array | string, plan?: string, headers: Record<string, string> = {}): Promise<Response> {
  const res = await app.request(`/api/memory/import${plan ? `?plan=${plan}` : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...headers },
    body: body as BodyInit,
  });
  return { status: res.status, body: (await res.json()) as Response["body"] };
}

/** Preview, then import what the preview showed, as the page does. */
async function importAll(body: Uint8Array | string): Promise<Response> {
  const preview = await upload(body);
  return preview.status === 200 ? upload(body, preview.body.planId) : preview;
}

const liveNotes = () => (appDb.prepare("SELECT COUNT(*) AS n FROM memory_notes WHERE replaced_at IS NULL").get() as { n: number }).n;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-import-"));
  appDb = new Database(":memory:");
  initAppStateDb(appDb);
  timelineDb = new Database(":memory:");
  initDb(timelineDb);
  aliceId = createContact(timelineDb, "alice brown");
  createContact(timelineDb, "Bobby Tables");
  app = createMemoryRoutes(wrapDatabase(timelineDb), () => appDb);
});

afterEach(() => {
  appDb.close();
  timelineDb.close();
});

describe("import from claude.ai's memory export", () => {
  test("previews without writing, then imports the notes the preview listed", async () => {
    const zip = await zipOf(EXPORT);
    const preview = await upload(zip);
    expect(preview.status).toBe(200);
    expect(liveNotes()).toBe(0);
    const expected: Omit<MemoryImportResult, "imported" | "planId"> = {
      add: [
        { project: "", kind: "you", count: 2 },
        { project: "", kind: "topic", count: 1 },
        { project: "", kind: "area", count: 1 },
        { project: "", kind: "person", count: 2 },
        { project: "garden-planner", kind: "project", count: 2 },
        { project: "garden-planner", kind: "topic", count: 1 },
        { project: "garden-planner", kind: "area", count: 1 },
        { project: "garden-planner", kind: "person", count: 1 },
        { project: "reading-list", kind: "project", count: 1 },
      ],
      links: [{ project: "", name: "alice-b", contact: "alice brown" }],
      existing: 0,
      problems: [],
      overLimit: null,
    };
    expect(preview.body).toEqual({ imported: false, planId: expect.any(String), ...expected });

    const imported = await upload(zip, preview.body.planId);
    expect(imported.body).toEqual({ imported: true, planId: preview.body.planId, ...expected });
    expect(liveNotes()).toBe(12);

    expect(getMemoryNote(appDb, "", "profile")).toMatchObject({
      kind: "you", title: "Profile", summary: "Alex: engineer, climber, gardener", details: "## Work\n- Engineer at a small studio\n",
      created_at: "2026-09-12T10:15:30.123Z", updated_at: "2026-09-12T10:15:30.123Z",
    });
    expect(getMemoryNote(appDb, "", "home-and-utilities")).toMatchObject({ kind: "area", title: "Home And Utilities", details: LONG_BODY });
    expect(LONG_BODY.length).toBeGreaterThan(8000);
    expect(getMemoryNote(appDb, "", "alice-b")).toMatchObject({ kind: "person", title: "Alice B", contact_id: aliceId });
    // "Bob" is part of a contact's name but not the name.
    expect(getMemoryNote(appDb, "", "bob")).toMatchObject({ kind: "person", contact_id: null });
    expect(getMemoryNote(appDb, "garden-planner", "overview")).toMatchObject({
      kind: "project", title: "Garden Planner", summary: "Watering and planting planner", details: "",
    });
    expect(getMemoryNote(appDb, "garden-planner", "carol")).toMatchObject({ kind: "person", title: "Carol" });
    expect(getMemoryNote(appDb, "reading-list", "overview")).toMatchObject({ title: "Overview", summary: "What the reading list is for" });

    // Re-running the same import adds nothing.
    const again = await importAll(zip);
    expect(again.body).toMatchObject({ imported: true, add: [], existing: 12, problems: [] });
    expect(liveNotes()).toBe(12);
  });

  test("takes claude.ai's memory export zip, dating notes by the export, into the same scopes as the data export", async () => {
    const zip = memoryExportZip(EXPORT.memory_files);
    const result = await importAll(zip);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ imported: true, existing: 0, problems: [], links: [{ project: "", name: "alice-b", contact: "alice brown" }] });
    expect(liveNotes()).toBe(12);
    expect(getMemoryNote(appDb, "garden-planner", "soil")).toMatchObject({ kind: "topic", created_at: "2026-11-27T00:00:00.000Z" });
    expect(getMemoryNote(appDb, "garden-planner", "overview")).toMatchObject({ title: "Garden Planner", summary: "Watering and planting planner" });
    expect(getMemoryNote(appDb, "reading-list", "overview")).toMatchObject({ summary: "What the reading list is for" });

    expect((await importAll(zip)).body).toMatchObject({ imported: true, add: [], existing: 12 });
    // The data export of the same memory names the same notes, so it adds nothing either.
    expect((await importAll(await zipOf(EXPORT))).body).toMatchObject({ imported: true, add: [], existing: 12 });
    expect(liveNotes()).toBe(12);
  });

  test("reads only the memory export's Markdown files at safe paths, listing the rest", async () => {
    const odd = "Shed [v2.0] *build*?";
    const result = await importAll(memoryExportZip([
      note("/topics/climbing.md", "climbing", "Fine"),
      file(`/projects/${odd}/index.md`, 'name: "Shed Build"\ndescription: Shed'),
      note(`/projects/${odd}/topics/wood.md`, "wood", "Timber"),
      { path: "/topics/notes.txt", content: "not markdown" },
      { path: "/topics/inner.zip", content: "PK" },
      note("/topics/../people/sneaky.md", "sneaky", "Traversal"),
      note("/topics//double.md", "double", "Empty segment"),
    ]));
    expect(result.status).toBe(200);
    expect(result.body.problems).toEqual([
      { path: "/topics/notes.txt", reason: "Not a Markdown memory file." },
      { path: "/topics/inner.zip", reason: "Not a Markdown memory file." },
      { path: "/topics/../people/sneaky.md", reason: "Not a path claude.ai's memory uses." },
      { path: "/topics//double.md", reason: "Not a path claude.ai's memory uses." },
    ]);
    expect(result.body.add).toEqual([
      { project: "", kind: "topic", count: 1 },
      { project: "shed-build", kind: "project", count: 1 },
      { project: "shed-build", kind: "topic", count: 1 },
    ]);
    expect(liveNotes()).toBe(3);
  });

  test("skips what a Mac adds when the export folder is zipped again", async () => {
    const root = "claude-memory-2026-11-27/";
    const result = await importAll(storedZip([
      [root, ""],
      [`${root}topics/climbing.md`, note("/topics/climbing.md", "climbing", "Fine").content],
      [`${root}.DS_Store`, "binary"],
      ["__MACOSX/", ""],
      [`__MACOSX/${root}topics/._climbing.md`, "resource fork"],
    ]));
    expect(result.body).toMatchObject({ imported: true, add: [{ project: "", kind: "topic", count: 1 }], problems: [] });
  });

  test("lists duplicate and unreadable entries without letting an index stand in for an unreadable overview", async () => {
    const root = "claude-memory-2026-11-27/";
    const result = await importAll(storedZip([
      [`${root}topics/climbing.md`, note("/topics/climbing.md", "climbing", "Fine").content],
      [`${root}topics/twice.md`, note("/topics/twice.md", "twice", "First").content],
      [`${root}topics/twice.md`, note("/topics/twice.md", "twice", "Second").content],
      [`${root}projects/Reading List/index.md`, file("/x", 'name: "Reading List"\ndescription: Books').content],
      [`${root}projects/Reading List/overview.md`, new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe])],
    ]));
    expect(result.body.problems).toEqual([
      { path: "/topics/twice.md", reason: "The export lists this path more than once." },
      { path: "/topics/twice.md", reason: "The export lists this path more than once." },
      { path: "/projects/Reading List/overview.md", reason: "The file is not UTF-8 text." },
    ]);
    expect(result.body.add).toEqual([{ project: "", kind: "topic", count: 1 }]);
    expect(getMemoryNote(appDb, "reading-list", "overview")).toBeNull();
  });

  test("takes the JSON inside the zip too, and leaves an existing note of the same name as it was", async () => {
    saveMemoryNote(appDb, { project: "", name: "bob", kind: "person", title: "Bob Stone", summary: "Saved by an agent" });
    const before = getMemoryNote(appDb, "", "bob");
    const result = await importAll(JSON.stringify(EXPORT));
    expect(result.body).toMatchObject({ imported: true, existing: 1, problems: [] });
    expect(getMemoryNote(appDb, "", "bob")).toEqual(before);
    expect(appDb.prepare("SELECT COUNT(*) AS n FROM memory_notes WHERE replaced_at IS NOT NULL").get()).toEqual({ n: 0 });
    expect(liveNotes()).toBe(12);
  });

  test("lists files it cannot import with the reason, and imports none of them", async () => {
    const shed = "33333333-3333-4333-8333-333333333333";
    const shed2 = "44444444-4444-4444-8444-444444444444";
    const orphan = "55555555-5555-4555-8555-555555555555";
    const result = await importAll(await zipOf(exportJson([
      note("/topics/climbing.md", "climbing", "Fine"),
      note("/topics/twice.md", "twice", "Listed twice"),
      note("/topics/twice.md", "twice", "Listed twice"),
      { ...note("/topics/dated.md", "dated", "Bad date"), updated_at: "last week" },
      file("/topics/broken.md", "name: broken\ntags: [x]"),
      { path: "/topics/no-frontmatter.md", content: "## Just a body\n", updated_at: AT },
      note("/notes/stray.md", "stray", "Unknown folder"),
      note("/topics/Not_A_Slug.md", "Not_A_Slug", "Bad name"),
      note("/topics/mismatch.md", "other-name", "Name differs"),
      file(`/projects/${shed}/index.md`, 'name: "Shed Build"\ndescription: Shed'),
      note(`/projects/${shed}/plans.md`, "plans", "Plans"),
      file(`/projects/${shed2}/index.md`, 'name: "Shed build!"\ndescription: Also a shed'),
      note(`/projects/${orphan}/topics/wood.md`, "wood", "No index for this project"),
      file(`/projects/${READING}/index.md`, 'name: "Reading List"\ndescription: Books'),
      file(`/projects/${READING}/overview.md`, "name: overview"),
    ])));
    expect(result.status).toBe(200);
    const collision = `Projects ${shed} and ${shed2} both make the project key "shed-build".`;
    expect(result.body.problems).toEqual([
      { path: "/topics/twice.md", reason: "The export lists this path more than once." },
      { path: "/topics/twice.md", reason: "The export lists this path more than once." },
      { path: "/topics/dated.md", reason: "updated_at is not a date." },
      { path: "/topics/broken.md", reason: "Frontmatter has a line other than name, description, sources or aliases." },
      { path: "/topics/no-frontmatter.md", reason: "The file does not start with frontmatter between --- lines." },
      { path: "/notes/stray.md", reason: "Not a path claude.ai's memory uses." },
      { path: "/topics/mismatch.md", reason: 'Frontmatter name "other-name" does not match the file name.' },
      { path: `/projects/${READING}/overview.md`, reason: "Frontmatter has no description." },
      { path: `/projects/${shed}/index.md`, reason: collision },
      { path: `/projects/${shed}/plans.md`, reason: collision },
      { path: `/projects/${shed2}/index.md`, reason: collision },
      { path: `/projects/${orphan}/topics/wood.md`, reason: `Project ${orphan} has no index.md giving its title.` },
      { path: "/topics/Not_A_Slug.md", reason: expect.stringContaining("Note name must be a lowercase slug") },
    ]);
    // The reading list's own overview cannot be imported, so its index does not stand in for it.
    expect(result.body.add).toEqual([{ project: "", kind: "topic", count: 1 }]);
    expect(liveNotes()).toBe(1);
  });

  test("refuses an upload that is not the export, writing nothing", async () => {
    expect((await upload(JSON.stringify(EXPORT), undefined, { "Sec-Fetch-Site": "same-site" })).status).toBe(403);
    expect((await upload(JSON.stringify(EXPORT), undefined, { "Content-Type": "text/plain" })).status).toBe(403);
    const unsupported = "Upload claude-memory-<date>.zip (in claude.ai: Settings → Your Claude → Memory → Export memory) or memories-000.zip (Settings → Privacy → Export data).";
    expect(await upload("hello")).toEqual({ status: 400, body: { error: unsupported } as never });
    const notExport = await upload(JSON.stringify({ memory_files: "nope" }), "any");
    expect(notExport.body.error).toStartWith("This is not claude.ai's memories export");

    const root = mkdtempSync(join(dir, "other-"));
    writeFileSync(join(root, "conversations.json"), "[]");
    await Bun.spawn(["zip", "-q", "other.zip", "conversations.json"], { cwd: root }).exited;
    const otherZip = await upload(new Uint8Array(await Bun.file(join(root, "other.zip")).arrayBuffer()));
    expect(otherZip.body.error).toBe(`This zip is not a claude.ai memory export. ${unsupported}`);
    // Memory files outside the dated folder, as if unzipped and zipped again, are not the export either.
    const rezipped = await upload(memoryExportZip([note("/topics/climbing.md", "climbing", "Fine")], {}, "my-memory/"));
    expect(rezipped.body.error).toBe(`This zip is not a claude.ai memory export. ${unsupported}`);
    const crowded = memoryExportZip(Array.from({ length: 2001 }, (_, i) => note(`/topics/t${i}.md`, `t${i}`, "Many")));
    expect((await upload(crowded)).body.error).toBe("The zip lists more than 2000 files.");

    const corrupt = await zipOf(EXPORT);
    corrupt.fill(0, 40, 400);
    expect((await upload(corrupt)).status).toBe(400);
    expect(liveNotes()).toBe(0);
  });

  test("refuses an import when memory changed since its preview", async () => {
    const preview = await upload(JSON.stringify(EXPORT));
    saveMemoryNote(appDb, { project: "", name: "climbing", kind: "topic", title: "Climbing", summary: "Saved by an agent meanwhile" });
    const refused = await upload(JSON.stringify(EXPORT), preview.body.planId);
    expect(refused).toEqual({ status: 400, body: { error: "Memory has changed since the preview. Choose the file again to see what the import would add now." } as never });
    expect(liveNotes()).toBe(1);
  });

  test("refuses the whole import when it would pass the note limit", async () => {
    const insert = appDb.prepare("INSERT INTO memory_notes (project, name, kind, title, summary, details, created_at, updated_at) VALUES ('', ?, 'topic', 't', 's', '', 'x', 'x')");
    for (let i = 0; i < MEMORY_LIMITS.notes - 5; i++) insert.run(`n${i}`);
    const preview = await upload(JSON.stringify(EXPORT));
    expect(preview.body.overLimit).toBe(`Memory holds ${MEMORY_LIMITS.notes - 5} notes; adding 12 would pass the limit of ${MEMORY_LIMITS.notes}. Delete notes first.`);
    const refused = await upload(JSON.stringify(EXPORT), preview.body.planId);
    expect(refused).toEqual({ status: 400, body: { error: preview.body.overLimit } as never });
    expect(liveNotes()).toBe(MEMORY_LIMITS.notes - 5);
  });
});
