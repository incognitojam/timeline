#!/usr/bin/env bun
/**
 * OpenCode Session Parser
 *
 * OpenCode has kept sessions in three stores, all under its data directory
 * (default ~/.local/share/opencode):
 *
 *   - `storage/`: JSON tree (project/, session/<project>/, message/<session>/,
 *     part/<message>/), written by OpenCode before 1.2.
 *   - `opencode.db` v1 tables `session` / `message` / `part`: OpenCode 1.x.
 *     Its json-migration copied `storage/` in with ids intact; each row's
 *     `data` is the JSON object minus the ids held in columns.
 *   - `opencode.db` v2 tables `session_v2` / `session_message`: OpenCode 2.
 *     Its V1Migration projects the v1 rows in, keeping session, message, and
 *     tool-call ids, and v2 writes only these. A database created by OpenCode
 *     2 has no v1 tables.
 *
 * All three key messages by the same ids, so each event's source_id is
 * `${rootSessionId}:${messageId}` whichever store it came from. Within a run
 * the first store holding a message wins, in the order above: storage and v1
 * rows are the original record, while the v2 projection drops some messages
 * and splits synthetic text into separate rows.
 *
 * Schema references: sst/opencode v1.2.27 (4ee426ba) for v1,
 * v2.0.28 (026b106b) for v2 (`packages/core/src/session/sql.ts`,
 * `packages/schema/src/session-message.ts`).
 *
 * Usage:
 *   bun run src/platforms/opencode/parser.ts [dataDir] [account] [--dry-run] [--refresh-raw-data]
 *   (dataDir may also be a bare storage/ tree or an opencode.db file)
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "fs";
import { readdir } from "fs/promises";
import { basename, join } from "path";
import { onImportComplete } from "../../db/queries";
import { getDb, initDb } from "../../db/schema";
import { type AiImportOptions, createIdentityCollector } from "../../ingest/ai/import";
import { type ContentBlock, extractText } from "../../ingest/ai/format-content";
import { recordFromUnknown } from "../../ingest/ai/image-blocks";

export const DEFAULT_OPENCODE_DIR = `${process.env.HOME}/.local/share/opencode`;

// ============ Type Definitions ============

/** Legacy project shape (storage/project/*.json). */
interface OpenCodeProject {
  id: string;
  worktree: string;
}

/** Legacy session shape (storage/session/<project>/*.json). */
interface OpenCodeSession {
  id: string;
  slug?: string;
  projectID: string;
  directory: string;
  parentID?: string; // For subagent sessions
  title?: string;
}

/** Legacy message shape (storage JSON, and v1 `message.data` plus ids). */
interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role: string;
  time: {
    created: number;
    completed?: number;
  };
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  agent?: string;
  path?: {
    cwd: string;
    root: string;
  };
  cost?: number;
  tokens?: OpenCodeTokens;
  finish?: string;
  summary?: unknown;
  model?: {
    providerID: string;
    modelID: string;
  };
}

interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

/** Legacy part shape (storage JSON, and v1 `part.data` plus ids). */
export interface OpenCodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  // For text and reasoning parts
  text?: string;
  time?: {
    start: number;
    end?: number;
  };
  // For tool parts
  callID?: string;
  tool?: string;
  state?: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    title?: string;
    metadata?: {
      output?: string;
      exit?: number;
      description?: string;
      truncated?: boolean;
    };
    time?: {
      start: number;
      end: number;
    };
  };
  // For step-finish parts
  reason?: string;
  snapshot?: string;
  cost?: number;
  tokens?: OpenCodeTokens;
}

export type OpenCodeStore = "storage" | "sqlite-v1" | "sqlite-v2";

const STORES: OpenCodeStore[] = ["storage", "sqlite-v1", "sqlite-v2"];

/** Session metadata merged across stores. */
interface SessionInfo {
  id: string;
  parentId: string | null;
  projectId: string;
  directory: string;
  title: string | null;
  slug: string | null;
}

/** A user or assistant message from any store, ready to become an event. */
interface NormalizedMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  created: number;
  completed: number | null;
  parentId?: string;
  model?: string;
  provider?: string;
  agent?: string;
  mode?: string;
  finish?: string;
  cost?: number;
  tokens?: unknown;
  summary?: unknown;
  cwd?: string;
  blocks: ContentBlock[];
  store: OpenCodeStore;
  /** Original record: legacy parts, or the v2 message's `data`. */
  source: { source_parts: OpenCodePart[] } | { source_message: Record<string, unknown> };
}

export interface ImportStats {
  sessions: number;
  /** Events inserted. */
  messages: number;
  /** Existing events rewritten (refreshRawData, or an open turn that changed). */
  updated: number;
  /** Messages already imported unchanged, or with no content blocks. */
  skipped: number;
  /** Messages selected from each store this run, whether or not written. */
  byStore: Record<OpenCodeStore, number>;
  /** Messages present in more than one store. */
  overlapping: number;
  identitiesUpserted: number;
}

// ============ Locating stores ============

export interface OpenCodeStores {
  storageDir: string | null;
  dbPath: string | null;
}

function isStorageDir(dir: string): boolean {
  return existsSync(join(dir, "session"));
}

/**
 * Resolve the stores to read from a path: OpenCode's data directory (reads
 * `opencode.db` and `storage/`), a bare legacy `storage/` tree, or an
 * `opencode.db` file. Throws when the path holds neither.
 */
export function resolveOpenCodeStores(path: string): OpenCodeStores {
  if (!existsSync(path)) {
    throw new Error(`OpenCode path not found: ${path}`);
  }
  if (statSync(path).isFile()) {
    return { storageDir: null, dbPath: path };
  }
  if (isStorageDir(path)) {
    return { storageDir: path, dbPath: null };
  }

  const dbPath = join(path, "opencode.db");
  const storageDir = join(path, "storage");
  const stores = {
    dbPath: existsSync(dbPath) ? dbPath : null,
    storageDir: isStorageDir(storageDir) ? storageDir : null,
  };
  if (!stores.dbPath && !stores.storageDir) {
    throw new Error(
      `No OpenCode data in ${path}: expected opencode.db or storage/session/`
    );
  }
  return stores;
}

// ============ Content normalization ============

/**
 * Convert legacy `part` objects (storage JSON and v1 rows) into the shared
 * ContentBlock form. A `tool` part becomes a `tool_use` and, once the tool
 * has run, a matching `tool_result` linked by `id` / `tool_use_id`. Reasoning
 * becomes a `thinking` block; step and snapshot parts are metadata and dropped.
 */
export function normalizePartsToBlocks(parts: OpenCodePart[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text) {
          blocks.push({ type: "text", text: part.text });
        }
        break;

      case "reasoning":
        if (part.text) {
          blocks.push({ type: "thinking", thinking: part.text });
        }
        break;

      case "tool": {
        if (!part.tool) break;
        const toolId = part.callID;
        blocks.push({
          type: "tool_use",
          name: part.tool,
          id: toolId,
          input: part.state?.input,
        });
        const status = part.state?.status;
        const isError = status === "error" || status === "failed";
        const output =
          part.state?.output ??
          part.state?.metadata?.output ??
          (isError ? part.state?.error : undefined);
        if (output !== undefined) {
          blocks.push({
            type: "tool_result",
            tool_use_id: toolId,
            ...(isError ? { error: output } : { content: output }),
          });
        }
        break;
      }
      // step-start / step-finish / patch / snapshot / file / agent / compaction are skipped.
    }
  }

  return blocks;
}

/** Tool output in v2 is a list of text and file items; flatten text-only output to a string. */
function v2ToolOutput(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const texts = content.map((item) => {
    const record = recordFromUnknown(item);
    return record?.type === "text" && typeof record.text === "string" ? record.text : null;
  });
  return texts.every((text) => text !== null) ? texts.join("\n") : content;
}

/** A v2 `tool` item: its `tool_use`, plus a `tool_result` once completed or failed. */
function v2ToolBlocks(record: Record<string, unknown>, name: string): ContentBlock[] {
  const id = typeof record.id === "string" ? record.id : undefined;
  const state = recordFromUnknown(record.state);
  const toolUse: ContentBlock = { type: "tool_use", name, id, input: state?.input };
  if (state?.status === "completed") {
    return [toolUse, { type: "tool_result", tool_use_id: id, content: v2ToolOutput(state.content) }];
  }
  if (state?.status === "error") {
    const error = recordFromUnknown(state.error);
    const message = typeof error?.message === "string" ? error.message : JSON.stringify(state.error);
    return [toolUse, { type: "tool_result", tool_use_id: id, error: message }];
  }
  return [toolUse];
}

/**
 * Convert a v2 assistant message's `content` array into ContentBlocks. A
 * `tool` item carries its own state (see v2ToolBlocks). Unrecognized items are
 * kept as `unknown` blocks.
 */
export function normalizeV2Content(content: unknown[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const item of content) {
    const record = recordFromUnknown(item);
    const text = typeof record?.text === "string" ? record.text : "";

    if (record?.type === "text") {
      if (text) blocks.push({ type: "text", text });
    } else if (record?.type === "reasoning") {
      if (text) blocks.push({ type: "thinking", thinking: text });
    } else if (record?.type === "tool" && typeof record.name === "string") {
      blocks.push(...v2ToolBlocks(record, record.name));
    } else {
      blocks.push({ type: "unknown", raw: item });
    }
  }

  return blocks;
}

// ============ Legacy storage (JSON tree) ============

async function loadJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await Bun.file(filePath).text();
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function loadAllInDirectory<T>(
  dirPath: string
): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  try {
    const files = await readdir(dirPath);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const id = basename(file, ".json");
      const data = await loadJsonFile<T>(join(dirPath, file));
      if (data) {
        result.set(id, data);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return result;
}

async function listDirectory(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}

interface StorageData {
  projects: Map<string, OpenCodeProject>;
  sessions: Map<string, OpenCodeSession>;
  messages: Map<string, OpenCodeMessage[]>;
  parts: Map<string, OpenCodePart[]>;
}

async function loadStorage(storageDir: string): Promise<StorageData> {
  const projects = await loadAllInDirectory<OpenCodeProject>(join(storageDir, "project"));

  const sessions = new Map<string, OpenCodeSession>();
  const sessionDir = join(storageDir, "session");
  for (const projectId of await listDirectory(sessionDir)) {
    for (const [id, session] of await loadAllInDirectory<OpenCodeSession>(join(sessionDir, projectId))) {
      sessions.set(id, session);
    }
  }

  const messages = new Map<string, OpenCodeMessage[]>();
  const messageDir = join(storageDir, "message");
  for (const sessionId of await listDirectory(messageDir)) {
    const loaded = await loadAllInDirectory<OpenCodeMessage>(join(messageDir, sessionId));
    messages.set(sessionId, [...loaded.values()]);
  }

  const parts = new Map<string, OpenCodePart[]>();
  const partDir = join(storageDir, "part");
  for (const messageId of await listDirectory(partDir)) {
    const loaded = await loadAllInDirectory<OpenCodePart>(join(partDir, messageId));
    // Part ids embed a timestamp, so id order is creation order.
    parts.set(messageId, [...loaded.values()].sort((a, b) => a.id.localeCompare(b.id)));
  }

  return { projects, sessions, messages, parts };
}

// ============ SQLite (opencode.db) ============

const V1_COLUMNS: Record<string, string[]> = {
  session: ["id", "project_id", "parent_id", "slug", "directory", "title"],
  message: ["id", "session_id", "time_created", "data"],
  part: ["id", "message_id", "session_id", "data"],
};

const V2_COLUMNS: Record<string, string[]> = {
  session_v2: ["id", "project_id", "parent_id", "slug", "directory", "title"],
  session_message: ["id", "session_id", "type", "seq", "time_created", "data"],
};

const PROJECT_COLUMNS = ["id", "worktree"];

/** v2 message types that are user/assistant turns; the rest are recognized but not imported. */
const V2_IMPORTED_TYPES = new Set(["user", "assistant"]);
const V2_SKIPPED_TYPES = new Set([
  "agent-switched",
  "model-switched",
  "location-switched",
  "synthetic",
  "system",
  "skill",
  "shell",
  "compaction",
  "idle",
]);

interface SessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  slug: string | null;
  directory: string;
  title: string | null;
}

interface V1MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface V1PartRow {
  id: string;
  message_id: string;
  session_id: string;
  data: string;
}

interface V2MessageRow {
  id: string;
  session_id: string;
  type: string;
  time_created: number;
  data: string;
}

function tableColumns(db: Database, table: string): Set<string> {
  const rows = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function requireColumns(db: Database, dbPath: string, table: string, required: string[]): void {
  const columns = tableColumns(db, table);
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(
      `Unrecognized OpenCode schema in ${dbPath}: table ${table} lacks ${missing.join(", ")}`
    );
  }
}

function parseJsonRecord(json: string, what: string): Record<string, unknown> {
  const record = recordFromUnknown(JSON.parse(json));
  if (!record) throw new Error(`OpenCode ${what} data is not a JSON object`);
  return record;
}

interface TableGenerations {
  /** v1 message/part tables. */
  hasV1: boolean;
  /** The v1 `session` table, which may be gone while message/part remain. */
  hasV1Sessions: boolean;
  /** v2 session_v2/session_message tables. */
  hasV2: boolean;
}

/** Detect which table generations opencode.db holds; throws on a layout it does not recognize. */
function detectGenerations(db: Database, dbPath: string): TableGenerations {
  const tables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
      .map((row) => row.name)
  );

  // v1 message/part may outlive the v1 `session` table: OpenCode 2's
  // loose_psylocke migration renames a pre-release v2 `session` table to
  // session_v2 and leaves message/part (whose sessions all exist in v2).
  const hasV1 = tables.has("message") && tables.has("part");
  const hasV1Sessions = hasV1 && tables.has("session");
  const hasV2 = tables.has("session_v2");
  if (tables.has("message") !== tables.has("part")) {
    throw new Error(`Unrecognized OpenCode schema in ${dbPath}: only one of message/part exists`);
  }
  if (tables.has("session_message") && !hasV2) {
    // Pre-release OpenCode 2 builds wrote session_message against a v2-shaped `session` table.
    throw new Error(
      `Unrecognized OpenCode schema in ${dbPath}: session_message without session_v2`
    );
  }
  if (!hasV1 && !hasV2) {
    throw new Error(
      `Unrecognized OpenCode schema in ${dbPath}: no session tables (expected message/part or session_v2)`
    );
  }
  if (hasV1 && !hasV1Sessions && !hasV2) {
    throw new Error(`Unrecognized OpenCode schema in ${dbPath}: message/part without a session table`);
  }
  requireColumns(db, dbPath, "project", PROJECT_COLUMNS);
  const required: Record<string, string[]> = {
    ...(hasV1 ? V1_COLUMNS : {}),
    ...(hasV2 ? V2_COLUMNS : {}),
  };
  if (!hasV1Sessions) delete required.session;
  for (const [table, columns] of Object.entries(required)) {
    requireColumns(db, dbPath, table, columns);
  }
  return { hasV1, hasV1Sessions, hasV2 };
}

/**
 * Read-only handle on opencode.db. Detects which table generations exist,
 * failing on a layout it does not recognize, and holds one read transaction
 * so every query sees the same snapshot while OpenCode keeps writing.
 */
function openOpenCodeDb(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  let generations: TableGenerations;
  try {
    db.run("PRAGMA busy_timeout = 5000");
    generations = detectGenerations(db, dbPath);
    db.run("BEGIN");
  } catch (error) {
    db.close();
    if ((error as { code?: string }).code === "SQLITE_READONLY_DIRECTORY") {
      throw new Error(
        `Cannot read ${dbPath}: it is in WAL mode and SQLite cannot create its -shm file in a read-only directory`,
        { cause: error }
      );
    }
    throw error;
  }
  const { hasV1, hasV1Sessions, hasV2 } = generations;

  const sessionColumns = "id, project_id, parent_id, slug, directory, title";
  const v1Sessions = hasV1Sessions ? (db.prepare(`SELECT ${sessionColumns} FROM session`).all() as SessionRow[]) : [];
  const v2Sessions = hasV2 ? (db.prepare(`SELECT ${sessionColumns} FROM session_v2`).all() as SessionRow[]) : [];
  const projects = new Map(
    (db.prepare(`SELECT id, worktree FROM project`).all() as OpenCodeProject[]).map((p) => [p.id, p.worktree])
  );

  const v1MessagesStmt = hasV1
    ? db.prepare(`SELECT id, session_id, time_created, data FROM message WHERE session_id = ?`)
    : null;
  const v1PartsStmt = hasV1
    ? db.prepare(`SELECT id, message_id, session_id, data FROM part WHERE session_id = ? ORDER BY id`)
    : null;
  const v2MessagesStmt = hasV2
    ? db.prepare(
        `SELECT id, session_id, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq`
      )
    : null;

  /** v1 rows rebuilt into the legacy JSON shapes (ids moved back into the objects). */
  const v1Messages = (sessionId: string): { message: OpenCodeMessage; parts: OpenCodePart[] }[] => {
    if (!v1MessagesStmt || !v1PartsStmt) return [];
    const partsByMessage = new Map<string, OpenCodePart[]>();
    for (const row of v1PartsStmt.all(sessionId) as V1PartRow[]) {
      const part = {
        ...parseJsonRecord(row.data, `part ${row.id}`),
        id: row.id,
        messageID: row.message_id,
        sessionID: row.session_id,
      } as OpenCodePart;
      const list = partsByMessage.get(row.message_id);
      if (list) list.push(part);
      else partsByMessage.set(row.message_id, [part]);
    }
    return (v1MessagesStmt.all(sessionId) as V1MessageRow[]).map((row) => {
      const data = parseJsonRecord(row.data, `message ${row.id}`);
      const time = recordFromUnknown(data.time);
      const message = {
        ...data,
        id: row.id,
        sessionID: row.session_id,
        time: { ...time, created: typeof time?.created === "number" ? time.created : row.time_created },
      } as OpenCodeMessage;
      return { message, parts: partsByMessage.get(row.id) ?? [] };
    });
  };

  const v2Messages = (sessionId: string): V2MessageRow[] =>
    v2MessagesStmt ? (v2MessagesStmt.all(sessionId) as V2MessageRow[]) : [];

  const close = () => {
    db.run("COMMIT");
    db.close();
  };

  return { v1Sessions, v2Sessions, projects, v1Messages, v2Messages, close };
}

// ============ Normalization into messages ============

function messageFromLegacy(
  msg: OpenCodeMessage,
  parts: OpenCodePart[],
  store: OpenCodeStore
): NormalizedMessage {
  if (msg.role !== "user" && msg.role !== "assistant") {
    throw new Error(`OpenCode message ${msg.id} has unrecognized role ${JSON.stringify(msg.role)}`);
  }
  if (typeof msg.time?.created !== "number") {
    throw new Error(`OpenCode message ${msg.id} has no time.created`);
  }
  return {
    id: msg.id,
    sessionId: msg.sessionID,
    role: msg.role,
    created: msg.time.created,
    completed: msg.time.completed ?? null,
    parentId: msg.parentID,
    model: msg.modelID || msg.model?.modelID,
    provider: msg.providerID || msg.model?.providerID,
    agent: msg.agent,
    mode: msg.mode,
    finish: msg.finish,
    cost: msg.cost,
    tokens: msg.tokens,
    summary: msg.summary,
    cwd: msg.path?.cwd,
    blocks: normalizePartsToBlocks(parts),
    store,
    source: { source_parts: parts },
  };
}

/** Convert a v2 row; returns null for recognized non-chat types, throws on unknown ones. */
function messageFromV2(row: V2MessageRow): NormalizedMessage | null {
  if (V2_SKIPPED_TYPES.has(row.type)) return null;
  if (!V2_IMPORTED_TYPES.has(row.type)) {
    throw new Error(
      `OpenCode session_message ${row.id} has unrecognized type ${JSON.stringify(row.type)}`
    );
  }

  const data = parseJsonRecord(row.data, `session_message ${row.id}`);
  const time = recordFromUnknown(data.time);
  const completed = typeof time?.completed === "number" ? time.completed : null;
  const base = {
    id: row.id,
    sessionId: row.session_id,
    created: row.time_created,
    store: "sqlite-v2" as const,
    source: { source_message: data },
  };

  if (row.type === "user") {
    if (typeof data.text !== "string") {
      throw new Error(`OpenCode session_message ${row.id} (user) has no text field`);
    }
    const text = data.text;
    return {
      ...base,
      role: "user",
      completed: null,
      blocks: text ? [{ type: "text", text }] : [],
    };
  }

  if (!Array.isArray(data.content)) {
    throw new Error(`OpenCode session_message ${row.id} (assistant) has no content array`);
  }
  const model = recordFromUnknown(data.model);
  return {
    ...base,
    role: "assistant",
    completed,
    model: typeof model?.id === "string" ? model.id : undefined,
    provider: typeof model?.providerID === "string" ? model.providerID : undefined,
    agent: typeof data.agent === "string" ? data.agent : undefined,
    finish: typeof data.finish === "string" ? data.finish : undefined,
    cost: typeof data.cost === "number" ? data.cost : undefined,
    tokens: data.tokens,
    blocks: normalizeV2Content(data.content),
  };
}

function projectNameFromPath(directory: string | undefined): string {
  if (!directory) return "unknown";
  const parts = directory.split("/");
  return parts[parts.length - 1] || "unknown";
}

/** Follow parent links to the top-level session; subagent sessions fold into it. */
function findRootSession(id: string, sessions: Map<string, SessionInfo>): string {
  const seen = new Set<string>();
  let current = id;
  while (true) {
    seen.add(current);
    const parentId = sessions.get(current)?.parentId;
    if (!parentId || !sessions.has(parentId) || seen.has(parentId)) return current;
    current = parentId;
  }
}

function toolUsage(blocks: ContentBlock[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const block of blocks) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      counts[block.name] = (counts[block.name] || 0) + 1;
    }
  }
  return counts;
}

// ============ Session index ============

type OpenCodeDb = ReturnType<typeof openOpenCodeDb>;

interface SessionIndex {
  sessions: Map<string, SessionInfo>;
  projectWorktrees: Map<string, string>;
  /** Top-level session id → that session and its subagent sessions. */
  groups: Map<string, string[]>;
}

function sessionFromStorage(s: OpenCodeSession): SessionInfo {
  return {
    id: s.id,
    parentId: s.parentID ?? null,
    projectId: s.projectID,
    directory: s.directory,
    title: s.title || null,
    slug: s.slug || null,
  };
}

function sessionFromRow(row: SessionRow): SessionInfo {
  return {
    id: row.id,
    parentId: row.parent_id,
    projectId: row.project_id,
    directory: row.directory,
    title: row.title || null,
    slug: row.slug || null,
  };
}

/** Merge session and project metadata from every store; later stores reflect current state. */
function buildSessionIndex(storage: StorageData | null, sqlite: OpenCodeDb | null): SessionIndex {
  const sessions = new Map<string, SessionInfo>();
  const merge = (info: SessionInfo) => {
    const existing = sessions.get(info.id);
    sessions.set(info.id, {
      ...info,
      title: info.title ?? existing?.title ?? null,
      slug: info.slug ?? existing?.slug ?? null,
    });
  };
  for (const s of storage?.sessions.values() ?? []) merge(sessionFromStorage(s));
  for (const row of sqlite?.v1Sessions ?? []) merge(sessionFromRow(row));
  for (const row of sqlite?.v2Sessions ?? []) merge(sessionFromRow(row));

  const projectWorktrees = new Map<string, string>();
  for (const p of storage?.projects.values() ?? []) projectWorktrees.set(p.id, p.worktree);
  for (const [id, worktree] of sqlite?.projects ?? []) projectWorktrees.set(id, worktree);

  const groups = new Map<string, string[]>();
  for (const id of [...sessions.keys()].sort()) {
    const root = findRootSession(id, sessions);
    const group = groups.get(root);
    if (group) group.push(id);
    else groups.set(root, [id]);
  }

  return { sessions, projectWorktrees, groups };
}

/**
 * Pick one copy of each message across a session group's stores. Stores are
 * read in order (storage, v1, v2) and the first copy with content wins; a
 * later copy replaces an earlier one only when the earlier has no blocks.
 */
function selectMessages(
  sessionIds: string[],
  storage: StorageData | null,
  sqlite: OpenCodeDb | null
): { messages: NormalizedMessage[]; overlapping: number } {
  const selected = new Map<string, NormalizedMessage>();
  const copies = new Map<string, number>();
  const add = (id: string, candidate: NormalizedMessage | null) => {
    copies.set(id, (copies.get(id) ?? 0) + 1);
    if (!candidate) return;
    const existing = selected.get(id);
    if (!existing || (existing.blocks.length === 0 && candidate.blocks.length > 0)) {
      selected.set(id, candidate);
    }
  };

  for (const sessionId of sessionIds) {
    for (const msg of storage?.messages.get(sessionId) ?? []) {
      add(msg.id, messageFromLegacy(msg, storage?.parts.get(msg.id) ?? [], "storage"));
    }
  }
  for (const sessionId of sessionIds) {
    for (const { message, parts } of sqlite?.v1Messages(sessionId) ?? []) {
      add(message.id, messageFromLegacy(message, parts, "sqlite-v1"));
    }
  }
  for (const sessionId of sessionIds) {
    for (const row of sqlite?.v2Messages(sessionId) ?? []) {
      add(row.id, messageFromV2(row));
    }
  }

  const messages = [...selected.values()].sort(
    (a, b) => a.created - b.created || a.id.localeCompare(b.id)
  );
  const overlapping = [...copies.values()].filter((count) => count > 1).length;
  return { messages, overlapping };
}

// ============ Event construction ============

interface OpenCodeEvent {
  sourceId: string;
  type: string;
  timestamp: string;
  endTimestamp: string | null;
  durationMs: number | null;
  title: string;
  content: string;
  people: string[];
  tags: string[];
  rawData: string;
  conversationId: string;
}

function eventTags(msg: NormalizedMessage, projectName: string): string[] {
  const tags: string[] = ["editor:opencode", `project:${projectName}`];
  if (msg.model) tags.push(`model:${msg.model}`);
  if (msg.provider && msg.provider !== "opencode") tags.push(`provider:${msg.provider}`);
  if (msg.agent) tags.push(`agent:${msg.agent}`);
  if (msg.mode) tags.push(`mode:${msg.mode}`);
  return tags;
}

function buildEvent(
  msg: NormalizedMessage,
  root: SessionInfo,
  index: SessionIndex,
  identities: ReturnType<typeof createIdentityCollector>
): OpenCodeEvent {
  const worktree = index.projectWorktrees.get(root.projectId);
  // OpenCode's "global" project (sessions outside a repository) has worktree "/".
  const projectPath = worktree && worktree !== "/" ? worktree : root.directory;
  const projectName = projectNameFromPath(projectPath);

  const sessionInfo = index.sessions.get(msg.sessionId);
  const sessionTitle = sessionInfo?.title || (sessionInfo?.slug ? `(${sessionInfo.slug})` : "");

  const usage = toolUsage(msg.blocks);
  const rawData = JSON.stringify({
    session_id: root.id,
    message_id: msg.id,
    message_session_id: msg.sessionId, // Differs for subagent messages
    parent_message_id: msg.parentId,
    project_id: root.projectId,
    project_path: projectPath,
    session_slug: root.slug ?? undefined,
    session_title: root.title ?? undefined,
    model: msg.model,
    provider: msg.provider,
    agent: msg.agent,
    mode: msg.mode,
    finish_reason: msg.finish,
    cost: msg.cost,
    tokens: msg.tokens,
    tool_usage: Object.keys(usage).length > 0 ? usage : undefined,
    summary: msg.summary,
    cwd: msg.cwd ?? sessionInfo?.directory,
    store: msg.store,
    content: msg.blocks,
    ...msg.source,
  });

  return {
    sourceId: `${root.id}:${msg.id}`,
    type: msg.role === "user" ? "opencode:message:user" : "opencode:message:assistant",
    timestamp: new Date(msg.created).toISOString(),
    endTimestamp: msg.completed ? new Date(msg.completed).toISOString() : null,
    durationMs: msg.role === "assistant" && msg.completed ? msg.completed - msg.created : null,
    title: sessionTitle ? `${projectName}: ${sessionTitle}` : projectName,
    content: extractText(msg.blocks),
    people:
      msg.role === "user"
        ? [identities.userIdentifier]
        : [identities.registerAssistant(msg.model ?? null), identities.userIdentifier],
    tags: eventTags(msg, projectName),
    rawData,
    conversationId: root.id,
  };
}

type WriteOutcome = "inserted" | "updated" | "skipped";

/**
 * Event writes with OpenCode's update rules. A new message is inserted. An
 * existing one is rewritten when refreshRawData is set, or while it is still
 * open (an assistant turn with no end_timestamp, e.g. imported mid-stream) and
 * either its data has changed or it has since completed. Legacy raw_data omits
 * the completion time, so a turn whose only change is completing still counts.
 * In dry-run mode the outcome is computed but not written.
 */
function createOpenCodeWriter(
  db: Database,
  options: { sourceAccount: string; importBatch: string; refreshRawData: boolean; dryRun: boolean }
) {
  const find = db.prepare(`
    SELECT end_timestamp IS NULL AND type = 'opencode:message:assistant' AS open, raw_data = ? AS same
    FROM events WHERE source = 'opencode' AND source_id = ? AND source_account = ?
  `);
  const insert = db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp, duration_ms,
      title, content, people, tags, raw_data, import_batch, conversation_id
    ) VALUES ('opencode', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE events SET content = ?, raw_data = ?, end_timestamp = ?, duration_ms = ?
    WHERE source = 'opencode' AND source_id = ? AND source_account = ?
  `);

  return (event: OpenCodeEvent): WriteOutcome => {
    const existing = find.get(event.rawData, event.sourceId, options.sourceAccount) as
      | { open: number; same: number }
      | null;

    if (!existing) {
      if (!options.dryRun) {
        insert.run(
          event.sourceId, options.sourceAccount, event.type, event.timestamp, event.endTimestamp,
          event.durationMs, event.title, event.content, JSON.stringify(event.people),
          JSON.stringify(event.tags), event.rawData, options.importBatch, event.conversationId
        );
      }
      return "inserted";
    }

    const changed = !existing.same || event.endTimestamp !== null;
    if (options.refreshRawData || (existing.open && changed)) {
      if (!options.dryRun) {
        update.run(
          event.content, event.rawData, event.endTimestamp, event.durationMs,
          event.sourceId, options.sourceAccount
        );
      }
      return "updated";
    }
    return "skipped";
  };
}

// ============ Main Import Function ============

function storesLabel(storage: StorageData | null, sqlite: OpenCodeDb | null): string {
  return [
    storage && "storage/",
    sqlite?.v1Sessions.length && "opencode.db v1",
    sqlite?.v2Sessions.length && "opencode.db v2",
  ]
    .filter(Boolean)
    .join(", ");
}

interface GroupWriteContext {
  index: SessionIndex;
  storage: StorageData | null;
  sqlite: OpenCodeDb | null;
  identities: ReturnType<typeof createIdentityCollector>;
  write: ReturnType<typeof createOpenCodeWriter>;
  /** Receives session, per-store, and overlap counts. */
  stats: ImportStats;
}

/** Select and write each top-level session's messages; returns write outcome counts. */
function writeSessionGroups(ctx: GroupWriteContext): Record<WriteOutcome, number> {
  const { index, stats } = ctx;
  const outcomes: Record<WriteOutcome, number> = { inserted: 0, updated: 0, skipped: 0 };

  for (const [rootId, sessionIds] of index.groups) {
    const root = index.sessions.get(rootId);
    if (!root) throw new Error(`OpenCode session ${rootId} missing from merged metadata`);

    const { messages, overlapping } = selectMessages(sessionIds, ctx.storage, ctx.sqlite);
    stats.overlapping += overlapping;
    if (messages.length === 0) continue;

    for (const msg of messages) {
      // Skip messages with no structured blocks at all. Pure tool-use
      // assistant messages are kept: their text may be empty but
      // raw_data.content preserves the structured blocks.
      if (msg.blocks.length === 0) {
        outcomes.skipped++;
        continue;
      }
      stats.byStore[msg.store]++;
      outcomes[ctx.write(buildEvent(msg, root, index, ctx.identities))]++;
    }
    stats.sessions++;
  }

  return outcomes;
}

/** Print run totals; `importBatch` is null for a dry run. */
function printSummary(stats: ImportStats, importBatch: string | null): void {
  console.log(`\n${"=".repeat(50)}`);
  console.log(importBatch ? "Import complete:" : "Dry run complete (would write):");
  console.log(`  Sessions: ${stats.sessions}`);
  console.log(`  Inserted: ${stats.messages.toLocaleString()}`);
  console.log(`  Updated: ${stats.updated.toLocaleString()}`);
  console.log(`  Skipped: ${stats.skipped.toLocaleString()}`);
  console.log(
    `  Selected by store: ${STORES.map((store) => `${store} ${stats.byStore[store]}`).join(", ")}`
  );
  console.log(`  Messages in more than one store: ${stats.overlapping.toLocaleString()}`);
  if (importBatch) {
    console.log(`  Identities: ${stats.identitiesUpserted}`);
    console.log(`  Batch ID: ${importBatch}`);
  }
}

/**
 * Import OpenCode sessions for one account from `openCodePath` (see
 * resolveOpenCodeStores for accepted paths).
 */
export async function importOpenCode(
  db: Database,
  openCodePath: string,
  sourceAccount: string,
  options: AiImportOptions = {}
): Promise<ImportStats> {
  const importBatch = `opencode-${sourceAccount}-${Date.now()}`;
  const dryRun = options.dryRun ?? false;
  const refreshRawData = options.refreshRawData ?? false;
  const stores = resolveOpenCodeStores(openCodePath);

  const stats: ImportStats = {
    sessions: 0,
    messages: 0,
    updated: 0,
    skipped: 0,
    byStore: { storage: 0, "sqlite-v1": 0, "sqlite-v2": 0 },
    overlapping: 0,
    identitiesUpserted: 0,
  };

  const storage = stores.storageDir ? await loadStorage(stores.storageDir) : null;
  const sqlite = stores.dbPath ? openOpenCodeDb(stores.dbPath) : null;

  try {
    const index = buildSessionIndex(storage, sqlite);
    console.log(
      `OpenCode: ${index.sessions.size} sessions (${index.groups.size} top-level) from ${storesLabel(storage, sqlite)}`
    );
    if (dryRun) {
      console.log("\n=== DRY RUN - No changes will be made ===\n");
    }

    const identities = createIdentityCollector("opencode", sourceAccount);
    const write = createOpenCodeWriter(db, { sourceAccount, importBatch, refreshRawData, dryRun });
    let outcomes: Record<WriteOutcome, number>;

    db.run("BEGIN TRANSACTION");
    try {
      outcomes = writeSessionGroups({ index, storage, sqlite, identities, write, stats });
      db.run(dryRun ? "ROLLBACK" : "COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }

    stats.messages = outcomes.inserted;
    stats.updated = outcomes.updated;
    stats.skipped = outcomes.skipped;
    if (!dryRun) {
      stats.identitiesUpserted = identities.upsertAll(db);
    }
  } finally {
    sqlite?.close();
  }

  printSummary(stats, dryRun ? null : importBatch);
  if (!dryRun) {
    onImportComplete(db);
  }

  return stats;
}

// ============ CLI ============

if (import.meta.main) {
  const args = process.argv.slice(2);

  const dryRun = args.includes("--dry-run");
  const refreshRawData = args.includes("--refresh-raw-data");
  const filteredArgs = args.filter((a) => !a.startsWith("--"));

  const openCodePath = filteredArgs[0]
    ? filteredArgs[0].replace(/^~/, process.env.HOME || "")
    : DEFAULT_OPENCODE_DIR;
  const accountName = filteredArgs[1] || "default";

  console.log(`Importing OpenCode sessions from ${openCodePath}`);
  console.log(`Account: ${accountName}`);
  if (dryRun) {
    console.log("Mode: DRY RUN");
  }
  if (refreshRawData) {
    console.log("Refresh mode: existing rows will have content + raw_data rewritten");
  }
  console.log();

  const db = getDb();
  initDb(db);

  await importOpenCode(db, openCodePath, accountName, {
    dryRun,
    refreshRawData,
  });

  db.close();
}
