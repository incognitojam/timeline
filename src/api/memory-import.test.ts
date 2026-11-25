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

function exportJson(memoryFiles: object[]) {
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
    expect(await upload("hello")).toEqual({ status: 400, body: { error: "Upload memories-000.zip from the claude.ai export, or the JSON file inside it." } as never });
    const notExport = await upload(JSON.stringify({ memory_files: "nope" }), "any");
    expect(notExport.body.error).toStartWith("This is not claude.ai's memories export");

    const root = mkdtempSync(join(dir, "other-"));
    writeFileSync(join(root, "conversations.json"), "[]");
    await Bun.spawn(["zip", "-q", "other.zip", "conversations.json"], { cwd: root }).exited;
    const otherZip = await upload(new Uint8Array(await Bun.file(join(root, "other.zip")).arrayBuffer()));
    expect(otherZip.body.error).toContain("The zip should hold just memories/<account-id>.json");

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
