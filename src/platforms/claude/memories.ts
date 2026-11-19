import { z } from "zod";
import { relative } from "node:path";
import type { Database } from "../../db/sqlite";
import { createBoundedWriter } from "../../db/bounded-writes";

const timestamp = z.string().refine((s) => Number.isFinite(Date.parse(s)), "Invalid memory timestamp");
const memorySchema = z.object({
  account_uuid: z.string().min(1),
  conversations_memory: z.string().nullish(),
  project_memories: z.record(z.string().uuid(), z.string()),
  memory_files: z.array(z.object({ path: z.string().startsWith("/"), content: z.string(), updated_at: timestamp }).passthrough()),
}).passthrough();

export async function importMemories(db: Database, root: string, files: string[], account: string, dryRun: boolean): Promise<{ added: number; otherAccountMemories: number; changed: number; present: number; skipped: number }> {
  const writer = createBoundedWriter(db);
  let added = 0;
  let otherAccountMemories = 0;
  const otherAccount = db.prepare("SELECT 1 FROM events WHERE source = 'claude' AND source_id = ? AND source_account != ? LIMIT 1");
  let changed = 0;
  let present = 0;
  let skipped = 0;
  for (const path of files.filter((file) => /^memories\/[^/]+\.json$/.test(relative(root, file)))) {
    const memory = memorySchema.parse(await Bun.file(path).json());
    const paths = new Set<string>();
    const records = [
      { id: "memory:0", content: memory.conversations_memory, timestamp: null as string | null, raw: { account_uuid: memory.account_uuid, conversations_memory: memory.conversations_memory } },
      ...Object.entries(memory.project_memories).map(([project, content]) => ({ id: `memory:project:${project}`, content, timestamp: null as string | null, raw: { account_uuid: memory.account_uuid, project_uuid: project, content } })),
      ...memory.memory_files.map((file) => {
        if (paths.has(file.path)) throw new Error("Duplicate Claude memory file path");
        paths.add(file.path);
        return { id: `memory:file:${file.path}`, content: file.content, timestamp: file.updated_at, raw: { ...file, account_uuid: memory.account_uuid } };
      }),
    ];
    for (const record of records) {
      const content = record.content;
      if (!content?.trim()) { skipped++; continue; }
      if (otherAccount.get(record.id, account)) otherAccountMemories++;
      const stored = db.prepare("SELECT id, content, raw_data, timestamp FROM events WHERE source = 'claude' AND source_account = ? AND source_id = ?").get(account, record.id) as { id: number; content: string; raw_data: string; timestamp: string | null } | null;
      if (!stored) added++;
      else if (stored.content !== content || (record.timestamp !== null && stored.timestamp !== record.timestamp)) changed++;
      else { present++; continue; }
      if (dryRun) continue;
      const raw = JSON.stringify(record.raw);
      await writer.add(() => {
        if (stored) {
          db.prepare("INSERT INTO event_versions (event_id, observed_at, source_edited_at, raw_data) VALUES (?, ?, ?, ?)").run(stored.id, new Date().toISOString(), stored.timestamp, stored.raw_data);
          db.prepare("UPDATE events SET content = ?, raw_data = ?, timestamp = ? WHERE id = ?").run(content, raw, record.timestamp ?? stored.timestamp, stored.id);
        } else {
          db.prepare("INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, import_batch) VALUES ('claude', ?, ?, 'claude:memory', ?, 'Claude Memory', ?, ?, ?)").run(record.id, account, record.timestamp, content, raw, `claude-${Date.now()}`);
        }
      }, raw.length * 2);
    }
  }
  await writer.flush();
  return { added, otherAccountMemories, changed, present, skipped };
}
