/**
 * claude.ai's memory files, from memories-000.zip in the account data export,
 * as Timeline memory notes. The older prose summaries beside them
 * (conversations_memory, project_memories) are not imported.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportedMemoryNote } from "../../db/memory-notes";
import { projectScope } from "../../db/memory-notes";
import { z } from "zod";
import { memorySchema } from "./memories";

// The export's envelope; each file is checked on its own so one bad file does not refuse the rest.
const exportSchema = memorySchema.extend({
  memory_files: z.array(z.object({ path: z.string(), content: z.string(), updated_at: z.string() }).passthrough()),
});

/** Largest upload, and largest memories JSON unzipped from it. */
export const MEMORY_EXPORT_MAX_BYTES = 16 * 1024 * 1024;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ZIP_ENTRY = new RegExp(`^memories/${UUID}\\.json$`);
// /preferences.md, /topics/<name>.md, /projects/<uuid>/<name>.md, /projects/<uuid>/people/<name>.md, …
const FILE_PATH = new RegExp(`^(?:/projects/(${UUID}))?/(?:(topics|areas|people)/)?([^/]{1,100})\\.md$`);
const FOLDER_KINDS = { topics: "topic", areas: "area", people: "person" } as const;

const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** Run unzip, returning stdout, killed once it passes `limit` bytes. Nothing is written to disk. */
async function unzip(args: string[], limit: number, tooLarge: string): Promise<Uint8Array> {
  const proc = Bun.spawn(["unzip", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of proc.stdout) {
    size += chunk.length;
    if (size > limit) {
      proc.kill();
      throw new Error(tooLarge);
    }
    chunks.push(chunk);
  }
  if ((await proc.exited) !== 0) throw new Error("The zip could not be read.");
  return Buffer.concat(chunks);
}

/** The memories JSON from memories-000.zip: its one entry, memories/<account-uuid>.json, read to memory. */
async function memoriesJsonFromZip(zip: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "timeline-memory-import-"));
  try {
    const path = join(dir, "upload.zip");
    await writeFile(path, zip);
    const entries = utf8(await unzip(["-Z1", path], 64 * 1024, "The zip lists more files than memories-000.zip holds.")).split("\n").filter((entry) => entry && entry !== "memories/");
    if (entries.length !== 1 || !ZIP_ENTRY.test(entries[0])) {
      throw new Error("The zip should hold just memories/<account-id>.json, as memories-000.zip from the claude.ai export does.");
    }
    // -P: an encrypted entry fails instead of prompting on the terminal.
    return await unzip(["-p", "-Px", path, entries[0]], MEMORY_EXPORT_MAX_BYTES, `The memories file unzips to more than ${MEMORY_EXPORT_MAX_BYTES / 1024 / 1024} MiB.`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The export's memories JSON from an upload of memories-000.zip or of the JSON inside it. */
export async function readClaudeMemoryUpload(upload: Uint8Array): Promise<unknown> {
  const isZip = upload[0] === 0x50 && upload[1] === 0x4b && upload[2] === 0x03 && upload[3] === 0x04;
  const bytes = isZip ? await memoriesJsonFromZip(upload) : upload;
  try {
    return JSON.parse(utf8(bytes));
  } catch {
    throw new Error(isZip
      ? "The memories file in the zip is not valid JSON."
      : "Upload memories-000.zip from the claude.ai export, or the JSON file inside it.");
  }
}

function scalar(key: string, raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "string") throw new Error(`Frontmatter ${key} is not a valid double-quoted string.`);
    return parsed;
  }
  const single = /^'((?:[^']|'')*)'$/.exec(value);
  if (single) return single[1].replace(/''/g, "'");
  if (/^['"[\]{}&*!|>%@`#]/.test(value)) throw new Error(`Frontmatter ${key} is in a form the importer does not read.`);
  return value;
}

function list(key: string, raw: string): string[] {
  const match = /^\[(.*)\]$/.exec(raw.trim());
  if (!match) throw new Error(`Frontmatter ${key} is not a [list].`);
  const inner = match[1].trim();
  if (!inner) return [];
  // Items split at commas, except inside an item that starts with a quote.
  const item = /\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,"'\s][^,]*|)\s*(,|$)/y;
  const values: string[] = [];
  for (let match = item.exec(inner); match; match = item.exec(inner)) {
    if (!match[1]) throw new Error(`Frontmatter ${key} has an empty item.`);
    values.push(scalar(key, match[1]));
    if (!match[2]) return values;
  }
  throw new Error(`Frontmatter ${key} is not a [list].`);
}

interface Frontmatter {
  name: string;
  description: string;
  aliases: string[];
  body: string;
}

/** The frontmatter claude.ai writes: single-line name, description, sources and aliases between --- lines. */
function parseMemoryFile(content: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (!match) throw new Error("The file does not start with frontmatter between --- lines.");
  const fields: Record<string, string | string[]> = {};
  for (const line of match[1].split("\n")) {
    const entry = /^(name|description|sources|aliases):(.*)$/.exec(line);
    if (!entry) throw new Error("Frontmatter has a line other than name, description, sources or aliases.");
    const [, key, raw] = entry;
    if (key in fields) throw new Error(`Frontmatter gives ${key} twice.`);
    fields[key] = key === "sources" || key === "aliases" ? list(key, raw) : scalar(key, raw);
  }
  const { name, description, aliases = [] } = fields;
  if (typeof name !== "string" || !name) throw new Error("Frontmatter has no name.");
  if (typeof description !== "string" || !description) throw new Error("Frontmatter has no description.");
  return { name, description, aliases: aliases as string[], body: content.slice(match[0].length) };
}

/** As claude.ai shows a note: its slug title-cased, "home-and-utilities" → "Home And Utilities". */
const titleFromSlug = (slug: string) => slug.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

export interface ClaudeMemoryNote extends ImportedMemoryNote {
  /** For person notes: names to find the person's contact by. */
  aliases: string[];
}

interface Parsed {
  path: string;
  updatedAt: string;
  project: string | undefined;
  folder: keyof typeof FOLDER_KINDS | undefined;
  file: string;
  /** The project's index.md, which gives its title. */
  index: boolean;
  frontmatter: Frontmatter;
}

function parseEntry(file: { path: string; content: string; updated_at: string }): Parsed {
  const path = FILE_PATH.exec(file.path);
  if (!path) throw new Error("Not a path claude.ai's memory uses.");
  const [, project, folder, name] = path;
  if (project === undefined && folder === undefined && name !== "preferences" && name !== "profile") {
    throw new Error("Not a path claude.ai's memory uses.");
  }
  const frontmatter = parseMemoryFile(file.content);
  const index = project !== undefined && folder === undefined && name === "index";
  if (!index && frontmatter.name !== name) throw new Error(`Frontmatter name "${frontmatter.name}" does not match the file name.`);
  return { path: file.path, updatedAt: file.updated_at, project, folder: folder as Parsed["folder"], file: name, index, frontmatter };
}

/** Each project's key, the slug of the title in its index.md, or why the project cannot be imported. */
function projectKeys(files: Parsed[]): Map<string, { key: string } | { problem: string }> {
  const projects = new Map<string, { key: string } | { problem: string }>();
  for (const uuid of new Set(files.flatMap((file) => (file.project ? [file.project] : [])))) {
    const index = files.find((file) => file.project === uuid && file.index);
    try {
      if (!index) throw new Error(`Project ${uuid} has no index.md giving its title.`);
      projects.set(uuid, { key: projectScope(index.frontmatter.name) });
    } catch (error) {
      projects.set(uuid, { problem: (error as Error).message });
    }
  }
  const keyed = [...projects].flatMap(([uuid, project]) => ("key" in project ? [{ uuid, key: project.key }] : []));
  for (const { uuid, key } of keyed) {
    const same = keyed.filter((other) => other.key === key).map((other) => other.uuid);
    if (same.length > 1) projects.set(uuid, { problem: `Projects ${same.sort().join(" and ")} both make the project key "${key}".` });
  }
  return projects;
}

/**
 * Map the export's memory files to notes, contact links left to the caller.
 * Throws when the JSON is not the export's shape; a file that cannot be
 * imported is listed as a problem with the reason.
 */
export function mapClaudeMemory(value: unknown): { notes: ClaudeMemoryNote[]; problems: { path: string; reason: string }[] } {
  const parsed = exportSchema.safeParse(value);
  if (!parsed.success) {
    const at = parsed.error.issues[0]?.path.join(".") || "the top level";
    throw new Error(`This is not claude.ai's memories export: unexpected content at ${at}.`);
  }
  const problems: { path: string; reason: string }[] = [];
  const files: Parsed[] = [];
  const paths = parsed.data.memory_files.map((file) => file.path);
  for (const file of parsed.data.memory_files) {
    try {
      if (paths.indexOf(file.path) !== paths.lastIndexOf(file.path)) throw new Error("The export lists this path more than once.");
      if (!Number.isFinite(Date.parse(file.updated_at))) throw new Error("updated_at is not a date.");
      files.push(parseEntry(file));
    } catch (error) {
      problems.push({ path: file.path.slice(0, 200), reason: (error as Error).message });
    }
  }
  const projects = projectKeys(files);

  const notes: ClaudeMemoryNote[] = [];
  for (const file of files) {
    const project = file.project ? projects.get(file.project) : { key: "" };
    if (!project) throw new Error("Project missing from its own keys");
    if ("problem" in project) {
      problems.push({ path: file.path, reason: project.problem });
      continue;
    }
    const note = { path: file.path, project: project.key, contactId: null, updatedAt: file.updatedAt, summary: file.frontmatter.description };
    if (file.index) {
      // The project's own overview file, when it has one, wins over its index, even when that file cannot be imported.
      if (!paths.includes(`/projects/${file.project}/overview.md`)) {
        notes.push({ ...note, name: "overview", kind: "project", title: file.frontmatter.name, details: "", aliases: [] });
      }
      continue;
    }
    const kind = file.folder ? FOLDER_KINDS[file.folder] : file.project ? "project" : "you";
    notes.push({ ...note, name: file.file, kind, title: titleFromSlug(file.file), details: file.frontmatter.body, aliases: file.frontmatter.aliases });
  }
  return { notes, problems };
}
