/**
 * claude.ai's memory files as Timeline memory notes, from either export:
 * claude-memory-<date>.zip (Settings → Your Claude → Memory → Export memory),
 * the memory tree as Markdown files under one dated folder, or memories-000.zip
 * from the account data export, the same files in one JSON with an updated_at
 * each. The data export's older prose summaries (conversations_memory,
 * project_memories) are not imported.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportedMemoryNote } from "../../db/memory-notes";
import { projectScope } from "../../db/memory-notes";
import { z } from "zod";
import { memorySchema } from "./memories";

interface MemoryFile {
  path: string;
  content: string;
  updated_at: string;
}

// The data export's envelope; each file is checked on its own so one bad file does not refuse the rest.
const exportSchema = memorySchema.extend({
  memory_files: z.array(z.object({ path: z.string(), content: z.string(), updated_at: z.string() }).passthrough()),
});

/** Largest upload, and most bytes unzipped from it. */
export const MEMORY_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
/** Most entries a memory export zip may list, folders included: well past the note limit. */
const MAX_ZIP_ENTRIES = 2000;

const UNSUPPORTED_UPLOAD = "Upload claude-memory-<date>.zip (in claude.ai: Settings → Your Claude → Memory → Export memory) or memories-000.zip (Settings → Privacy → Export data).";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DATA_EXPORT_ENTRY = new RegExp(`^memories/${UUID}\\.json$`);
const MEMORY_EXPORT_ROOT = /^(claude-memory-(\d{4}-\d{2}-\d{2}))\//;
// /preferences.md, /topics/<name>.md, /projects/<project>/<name>.md, /projects/<project>/people/<name>.md, …
// <project> is a UUID in the data export and the project's title in the memory export.
const FILE_PATH = /^(?:\/projects\/([^/]{1,200}))?\/(?:(topics|areas|people)\/)?([^/]{1,100})\.md$/;
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

const TOO_LARGE = `The zip unzips to more than ${MEMORY_EXPORT_MAX_BYTES / 1024 / 1024} MiB.`;

/** One entry's bytes; -P makes an encrypted entry fail instead of prompting, and the name is escaped so unzip matches it literally. */
const unzipEntry = (zip: string, entry: string, limit: number) =>
  unzip(["-p", "-Px", zip, entry.replace(/[[\]*?]/g, "\\$&")], limit, TOO_LARGE);

function dataExportFiles(value: unknown): MemoryFile[] {
  const parsed = exportSchema.safeParse(value);
  if (!parsed.success) {
    const at = parsed.error.issues[0]?.path.join(".") || "the top level";
    throw new Error(`This is not claude.ai's memories export: unexpected content at ${at}.`);
  }
  return parsed.data.memory_files;
}

type Problem = { path: string; reason: string };
export interface MemoryUpload {
  files: MemoryFile[];
  /** Entries of the zip that were not read, with the reason. */
  problems: Problem[];
}

/**
 * The memory export's Markdown files, each at its path below the dated folder
 * and dated by the export, since the zip carries no time per memory. Only
 * entries with a safe path ending .md are unzipped; nothing is written to disk.
 */
async function memoryExportFiles(zip: string, entries: string[], root: string, date: string): Promise<MemoryUpload> {
  const updatedAt = `${date}T00:00:00.000Z`;
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error(`The folder ${root} does not name a real date.`);
  const upload: MemoryUpload = { files: [], problems: [] };
  let budget = MEMORY_EXPORT_MAX_BYTES;
  for (const entry of entries) {
    if (entry.endsWith("/")) continue;
    const path = entry.slice(root.length);
    if (/[\\\0-\x1f]/.test(path) || path.split("/").slice(1).some((segment) => !segment || segment === "." || segment === "..")) {
      upload.problems.push({ path: path.slice(0, 200), reason: "Not a path claude.ai's memory uses." });
      continue;
    }
    if (!path.endsWith(".md")) {
      upload.problems.push({ path: path.slice(0, 200), reason: "Not a Markdown memory file." });
      continue;
    }
    const bytes = await unzipEntry(zip, entry, budget);
    budget -= bytes.length;
    try {
      upload.files.push({ path, content: utf8(bytes), updated_at: updatedAt });
    } catch {
      upload.problems.push({ path: path.slice(0, 200), reason: "The file is not UTF-8 text." });
    }
  }
  return upload;
}

/** The memory files in an upload of either export's zip, or of the data export's memories JSON. */
export async function readClaudeMemoryUpload(upload: Uint8Array): Promise<MemoryUpload> {
  const isZip = upload[0] === 0x50 && upload[1] === 0x4b && upload[2] === 0x03 && upload[3] === 0x04;
  if (!isZip) {
    let value: unknown;
    try {
      value = JSON.parse(utf8(upload));
    } catch {
      throw new Error(UNSUPPORTED_UPLOAD);
    }
    return { files: dataExportFiles(value), problems: [] };
  }
  const dir = await mkdtemp(join(tmpdir(), "timeline-memory-import-"));
  try {
    const zip = join(dir, "upload.zip");
    await writeFile(zip, upload);
    const listing = await unzip(["-Z1", zip], 1024 * 1024, `The zip lists more than ${MAX_ZIP_ENTRIES} files.`);
    let entries: string[];
    try {
      entries = utf8(listing).split("\n").filter(Boolean);
    } catch {
      throw new Error("The zip lists a file name that is not UTF-8.");
    }
    if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`The zip lists more than ${MAX_ZIP_ENTRIES} files.`);

    const files = entries.filter((entry) => entry !== "memories/");
    if (files.length === 1 && DATA_EXPORT_ENTRY.test(files[0])) {
      const bytes = await unzipEntry(zip, files[0], MEMORY_EXPORT_MAX_BYTES);
      let value: unknown;
      try {
        value = JSON.parse(utf8(bytes));
      } catch {
        throw new Error("The memories file in the zip is not valid JSON.");
      }
      return { files: dataExportFiles(value), problems: [] };
    }

    const root = MEMORY_EXPORT_ROOT.exec(entries[0] ?? "");
    if (root && entries.every((entry) => entry.startsWith(root[0]))) {
      return await memoryExportFiles(zip, entries, root[1], root[2]);
    }
    throw new Error(`This zip is not a claude.ai memory export. ${UNSUPPORTED_UPLOAD}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
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

function parseEntry(file: MemoryFile): Parsed {
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

/** Each project folder's key, the slug of the title in its index.md, or why the project cannot be imported. */
function projectKeys(files: Parsed[]): Map<string, { key: string } | { problem: string }> {
  const projects = new Map<string, { key: string } | { problem: string }>();
  for (const folder of new Set(files.flatMap((file) => (file.project ? [file.project] : [])))) {
    const index = files.find((file) => file.project === folder && file.index);
    try {
      if (!index) throw new Error(`Project ${folder} has no index.md giving its title.`);
      projects.set(folder, { key: projectScope(index.frontmatter.name) });
    } catch (error) {
      projects.set(folder, { problem: (error as Error).message });
    }
  }
  const keyed = [...projects].flatMap(([folder, project]) => ("key" in project ? [{ folder, key: project.key }] : []));
  for (const { folder, key } of keyed) {
    const same = keyed.filter((other) => other.key === key).map((other) => other.folder);
    if (same.length > 1) projects.set(folder, { problem: `Projects ${same.sort().join(" and ")} both make the project key "${key}".` });
  }
  return projects;
}

/**
 * Map an export's memory files to notes, contact links left to the caller.
 * A file that cannot be imported is listed as a problem with the reason.
 */
export function mapClaudeMemory(memoryFiles: MemoryFile[]): { notes: ClaudeMemoryNote[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const files: Parsed[] = [];
  const paths = memoryFiles.map((file) => file.path);
  for (const file of memoryFiles) {
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
