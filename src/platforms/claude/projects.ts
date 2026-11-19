import { z } from "zod";
import { relative } from "node:path";
import { extractedExports, exportZips, categoryPattern } from "./export";
import { basename } from "node:path";
import type { Database } from "../../db/sqlite";
import { createBoundedWriter } from "../../db/bounded-writes";
const date = z.string().refine((value) => Number.isFinite(Date.parse(value)), "Invalid project timestamp");
const projectSchema = z.object({
  uuid: z.string().uuid(), name: z.string(), description: z.string().nullish(), prompt_template: z.string().nullish(),
  is_private: z.boolean(), is_starter_project: z.boolean(), created_at: date, updated_at: date,
  creator: z.object({ uuid: z.string(), full_name: z.string().nullish() }).passthrough(),
  docs: z.array(z.object({ uuid: z.string(), filename: z.string().nullish(), content: z.string().nullish(), created_at: date }).passthrough()),
}).passthrough();
export type ClaudeProject = z.infer<typeof projectSchema>;

export async function loadProjects(path: string): Promise<ClaudeProject[]> {
  const projects: ClaudeProject[] = [];
  for (const zip of await exportZips(path)) {
    if (categoryPattern.exec(basename(zip))?.[1] !== "projects") continue;
    for await (const { tempDir, files } of extractedExports(zip)) {
      for (const file of files.filter((file) => /^projects\/[^/]+\.json$/.test(relative(tempDir, file)))) {
        const project = projectSchema.parse(await Bun.file(file).json());
        if (basename(file) !== `${project.uuid}.json`) throw new Error("Project filename does not match its UUID");
        projects.push(project);
      }
    }
  }
  return projects;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function projectCandidates(messages: { content?: unknown[] }[], projects: Set<string>): Set<string> {
  const matches = new Set<string>();
  const collect = (value: unknown) => {
    if (Array.isArray(value)) for (const segment of value) if (typeof segment === "string" && projects.has(segment)) matches.add(segment);
  };
  for (const message of messages) for (const block of message.content ?? []) {
    const data = object(block);
    const structured = object((data?.type === "unknown" ? object(data.raw) : data)?.structured_content);
    collect(structured?.path_segments);
    if (Array.isArray(structured?.documents)) for (const document of structured.documents) collect(object(document)?.path_segments);
  }
  return matches;
}

export function inferProject(messages: { content?: unknown[] }[], projects: Set<string>): string | null {
  const matches = projectCandidates(messages, projects);
  return matches.size === 1 ? [...matches][0] : null;
}

export async function importProjects(db: Database, projects: ClaudeProject[], account: string, dryRun: boolean): Promise<{ added: number; otherAccountProjects: number; changed: number; present: number }> {
  const writer = createBoundedWriter(db);
  let added = 0;
  let otherAccountProjects = 0;
  const otherAccount = db.prepare("SELECT 1 FROM events WHERE source = 'claude' AND source_id = ? AND source_account != ? LIMIT 1");
  let changed = 0;
  let present = 0;
  for (const project of projects) {
    const raw = JSON.stringify(project);
    const id = `project:${project.uuid}`;
    if (otherAccount.get(id, account)) otherAccountProjects++;
    const stored = db.prepare("SELECT id, raw_data FROM events WHERE source = 'claude' AND source_account = ? AND source_id = ?").get(account, id) as { id: number; raw_data: string } | null;
    if (!stored) added++;
    else if (stored.raw_data !== raw) changed++;
    else { present++; continue; }
    if (dryRun) continue;
    const title = project.name || `Claude Project (${project.uuid.slice(0, 8)})`;
    const content = [project.description, project.prompt_template, ...project.docs.map((doc) => `${doc.filename ?? ""}\n${doc.content ?? ""}`)].join("\n\n");
    await writer.add(() => {
      if (stored) {
        db.prepare("INSERT INTO event_versions (event_id, observed_at, source_edited_at, raw_data) VALUES (?, ?, ?, ?)").run(stored.id, new Date().toISOString(), projectSchema.parse(JSON.parse(stored.raw_data)).updated_at, stored.raw_data);
        db.prepare("UPDATE events SET title = ?, content = ?, raw_data = ?, timestamp = ? WHERE id = ?").run(title, content, raw, project.updated_at, stored.id);
      } else {
        db.prepare("INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, tags) VALUES ('claude', ?, ?, 'claude:project', ?, ?, ?, ?, ?)").run(id, account, project.updated_at, title, content, raw, JSON.stringify([`project:${project.uuid}`]));
      }
    }, raw.length * 2);
  }
  await writer.flush();
  return { added, otherAccountProjects, changed, present };
}

/** Reconcile only link tags; raw export data and unrelated tags remain untouched. */
export async function reconcileProjectLinks(db: Database, account: string, projects: Set<string>, dryRun: boolean) {
  const writer = createBoundedWriter(db);
  const marker = "project-link:inferred-memory-path";
  let tagChanges = 0;
  let linked = 0;
  const update = async (id: number, storedTags: string | null, project: string | null, inferred: boolean) => {
    const tags = storedTags ? z.array(z.string()).parse(JSON.parse(storedTags)) : [];
    // Only this marker's project tags are managed by inference. Other tags,
    // including attachment tags absent from a newer export, are preserved.
    const next = inferred && tags.includes(marker)
      ? tags.filter((tag) => tag !== marker && !(tag.startsWith("project:") && projects.has(tag.slice(8))))
      : [...tags];
    if (project) {
      if (!next.includes(`project:${project}`)) next.push(`project:${project}`);
      if (inferred) next.push(marker);
    }
    if (JSON.stringify(next) === JSON.stringify(tags)) return;
    tagChanges++;
    if (!dryRun) await writer.add(() => { db.prepare("UPDATE events SET tags = ? WHERE id = ?").run(JSON.stringify(next), id); }, JSON.stringify(next).length * 2);
  };
  if (projects.size) {
    const groups = new Map<string, { rows: { id: number; tags: string | null }[]; matches: Set<string> }>();
    const rows = db.prepare("SELECT id, conversation_id, tags, raw_data FROM events WHERE source = 'claude' AND source_account = ? AND type IN ('claude:message:user', 'claude:message:assistant') ORDER BY conversation_id");
    for (const row of rows.iterate(account) as Iterable<{ id: number; conversation_id: string | null; tags: string | null; raw_data: string }>) {
      const raw = object(JSON.parse(row.raw_data));
      const conversation = row.conversation_id ?? raw?.conversation_uuid;
      if (typeof conversation !== "string") continue;
      let group = groups.get(conversation);
      if (!group) { group = { rows: [], matches: new Set() }; groups.set(conversation, group); }
      group.rows.push({ id: row.id, tags: row.tags });
      const blocks = raw?.original_content ?? raw?.content;
      for (const candidate of projectCandidates([{ content: Array.isArray(blocks) ? blocks : [] }], projects)) group.matches.add(candidate);
    }
    for (const group of groups.values()) {
      const project = group.matches.size === 1 ? [...group.matches][0] : null;
      if (project) linked++;
      for (const row of group.rows) await update(row.id, row.tags, project, true);
      await writer.breathe();
    }
    const memories = db.prepare("SELECT id, source_id, tags FROM events WHERE source = 'claude' AND source_account = ? AND type = 'claude:memory'").all(account) as { id: number; source_id: string; tags: string | null }[];
    for (const row of memories) {
      const segments = row.source_id.startsWith("memory:file:") ? row.source_id.slice(12).split("/") : [row.source_id.slice("memory:project:".length)];
      const matches = [...new Set(segments.filter((segment) => projects.has(segment)))];
      if (matches.length === 1) await update(row.id, row.tags, matches[0], false);
    }
  }
  await writer.flush();
  return { linked, tagChanges };
}
