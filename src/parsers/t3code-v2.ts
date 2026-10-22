/**
 * Reader for T3 Code's orchestration v2 store (`statev2.sqlite`), written by
 * current T3 Code and its styal fork. Plans timeline events from:
 *
 * - `orchestration_v2_projection_messages` — user/assistant text, attachments
 * - `orchestration_v2_projection_turn_items` — tool calls, proposed plans,
 *   reasoning (message items duplicate the messages table and are skipped)
 * - `orchestration_v2_projection_runs` — provider + model per turn, so a
 *   thread that switches provider mid-way attributes each turn correctly
 * - `orchestration_v2_projection_provider_threads` — the provider-native
 *   session (Claude Code / Codex / OpenCode / ...) each thread drove
 *
 * Threads migrated from the v1 store keep their v1 message ids, and their
 * tool items reference the v1 `tool.completed` activity, so both map to the
 * source ids the v1 reader used and an existing v1 import is not duplicated.
 */

import type { Database } from "bun:sqlite";
import type { ContentBlock } from "./shared/format-content";
import { recordFromUnknown } from "./shared/image-blocks";
import {
  asString,
  type PlannedT3Event,
  t3EventTags,
  t3EventTitle,
} from "./t3code-events";

/** Tables and columns this reader queries; checked before any read. */
export const T3_V2_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  orchestration_v2_projection_threads: [
    "thread_id", "project_id", "title", "provider_instance_id",
    "created_at", "updated_at", "archived_at", "deleted_at", "payload_json",
  ],
  orchestration_v2_projection_messages: [
    "message_id", "thread_id", "run_id", "role", "streaming", "created_at", "updated_at", "payload_json",
  ],
  orchestration_v2_projection_turn_items: [
    "turn_item_id", "thread_id", "run_id", "type", "status", "updated_at", "payload_json",
  ],
  orchestration_v2_projection_runs: ["run_id", "provider_instance_id", "payload_json"],
  orchestration_v2_projection_provider_threads: ["thread_id", "driver", "provider_instance_id", "payload_json"],
  orchestration_v2_legacy_imports: ["thread_id", "transcript_imported_at"],
  projection_projects: ["project_id", "title", "workspace_root", "updated_at"],
};

/**
 * Every table the v2 reader touches. A snapshot holding just these tables
 * (plus the `attachments/` directory beside the database, for images)
 * imports the same as the full store.
 */
export const T3_V2_TABLES: readonly string[] = Object.keys(T3_V2_REQUIRED_COLUMNS);

/**
 * Rows are re-read from this long before the stored cursor: `updated_at` is
 * stamped by the writer before commit, so concurrent writers can commit
 * slightly out of order. Re-reads are skipped as duplicates.
 */
export const T3_V2_CURSOR_OVERLAP_MS = 10 * 60 * 1000;

const TERMINAL_ITEM_STATUSES = ["completed", "failed", "cancelled", "interrupted"];
const TOOL_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "dynamic_tool",
  "web_search",
  "file_search",
  "subagent",
  "user_input_request",
];
const IMPORTED_ITEM_TYPES = [...TOOL_ITEM_TYPES, "proposed_plan", "reasoning"];

const sqlList = (values: string[]) => values.map((v) => `'${v}'`).join(", ");

export interface T3V2ReadStats {
  /** Highest change timestamp observed; pass back as `cursor` next run. */
  cursor: string | null;
  /** Migrated v1 threads whose transcript T3 has not copied into v2 yet. */
  pendingTranscriptThreads: number;
  /** Rows read but not planned, by reason. */
  skipped: Record<string, number>;
}

interface ProviderTurn {
  provider: string | null;
  providerInstanceId: string | null;
  model: string | null;
  modelOptions: unknown;
}

interface V2Thread extends ProviderTurn {
  title: string;
  projectTitle: string | null;
  branch: string | null;
  /**
   * Latest change to anything copied onto every event (thread title, flags,
   * worktree; project title/root). Kept out of raw_data so it stays stable.
   */
  changedAt: string;
  /** Fields persisted on every event of the thread. */
  raw: Record<string, unknown> & { thread_id: string };
}

interface ThreadRow {
  thread_id: string;
  title: string;
  provider_instance_id: string | null;
  created_at: string;
  updated_at: string;
  project_updated_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  payload_json: string;
  project_title: string | null;
  workspace_root: string | null;
}

interface RunRow {
  run_id: string;
  provider_instance_id: string | null;
  model_selection: string | null;
}

interface MessageRow {
  message_id: string;
  thread_id: string;
  run_id: string | null;
  role: string;
  created_at: string;
  updated_at: string;
  payload_json: string;
}

interface TurnItemRow {
  turn_item_id: string;
  thread_id: string;
  run_id: string | null;
  type: string;
  status: string;
  updated_at: string;
  payload_json: string;
}

function parsePayload(json: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`T3 Code ${what} has malformed payload_json: ${(error as Error).message}`);
  }
  const record = recordFromUnknown(parsed);
  if (!record) throw new Error(`T3 Code ${what} payload_json is not an object`);
  return record;
}

function modelSelectionFields(value: unknown): { model: string | null; modelOptions: unknown } {
  const selection = recordFromUnknown(value);
  return { model: asString(selection?.model), modelOptions: selection?.options };
}

function maxTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

interface T3ProviderSession {
  threadId: string;
  /** T3 provider driver: claudeAgent, codex, opencode, antigravity, ... */
  driver: string;
  /** The provider's own session/thread id (Claude session, Codex thread, ...). */
  nativeId: string;
}

/**
 * Threads and runs record a provider instance (which may be a custom one,
 * e.g. a second Claude account); provider threads also record its driver.
 */
function loadInstanceDrivers(t3Db: Database): Map<string, string> {
  const rows = t3Db.prepare(`
    SELECT DISTINCT provider_instance_id, driver FROM orchestration_v2_projection_provider_threads
    WHERE provider_instance_id IS NOT NULL AND driver IS NOT NULL
  `).all() as { provider_instance_id: string; driver: string }[];
  return new Map(rows.map((row) => [row.provider_instance_id, row.driver]));
}

/** Provider-native sessions each thread drove, from the provider thread refs. */
function readT3CodeV2ProviderSessions(t3Db: Database): T3ProviderSession[] {
  const rows = t3Db.prepare(`
    SELECT thread_id, driver, json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id
    FROM orchestration_v2_projection_provider_threads
    WHERE thread_id IS NOT NULL
  `).all() as { thread_id: string; driver: string | null; native_id: unknown }[];
  const sessions: T3ProviderSession[] = [];
  for (const row of rows) {
    const nativeId = asString(row.native_id);
    if (nativeId && row.driver) sessions.push({ threadId: row.thread_id, driver: row.driver, nativeId });
  }
  return sessions;
}

function loadThreads(t3Db: Database, drivers: Map<string, string>): Map<string, V2Thread> {
  const nativeSessions = new Map<string, { driver: string; native_id: string }[]>();
  for (const session of readT3CodeV2ProviderSessions(t3Db)) {
    let sessions = nativeSessions.get(session.threadId);
    if (!sessions) {
      sessions = [];
      nativeSessions.set(session.threadId, sessions);
    }
    sessions.push({ driver: session.driver, native_id: session.nativeId });
  }

  const rows = t3Db.prepare(`
    SELECT
      t.thread_id, t.title, t.provider_instance_id,
      t.created_at, t.updated_at, t.archived_at, t.deleted_at, t.payload_json,
      p.title AS project_title, p.workspace_root, p.updated_at AS project_updated_at
    FROM orchestration_v2_projection_threads t
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
  `).all() as ThreadRow[];

  const threads = new Map<string, V2Thread>();
  for (const row of rows) {
    const payload = parsePayload(row.payload_json, `thread ${row.thread_id}`);
    const lineage = recordFromUnknown(payload.lineage);
    const { model, modelOptions } = modelSelectionFields(payload.modelSelection);
    const branch = asString(payload.branch);
    threads.set(row.thread_id, {
      title: row.title,
      projectTitle: row.project_title,
      branch,
      changedAt: [row.created_at, row.updated_at, row.project_updated_at].reduce(maxTimestamp, null) ?? row.created_at,
      ...providerFields(row.provider_instance_id, drivers),
      model,
      modelOptions,
      raw: {
        store: "v2",
        thread_id: row.thread_id,
        thread_title: row.title,
        thread_created_at: row.created_at,
        thread_archived: row.archived_at !== null,
        thread_deleted: row.deleted_at !== null,
        thread_created_by: asString(payload.createdBy),
        thread_creation_source: asString(payload.creationSource),
        // Subagent and fork children are their own conversations; these
        // ids (parent/root conversation ids) let them be grouped later.
        parent_thread_id: asString(lineage?.parentThreadId),
        root_thread_id: asString(lineage?.rootThreadId),
        thread_relationship: asString(lineage?.relationshipToParent),
        branch,
        worktree_path: asString(payload.worktreePath),
        project_title: row.project_title,
        workspace_root: row.workspace_root,
        // Provider-native conversations (Claude Code session, Codex rollout,
        // ...) this thread drove; their own transcripts duplicate it.
        provider_sessions: nativeSessions.get(row.thread_id) ?? [],
      },
    });
  }
  return threads;
}

/** Driver (claudeAgent, codex, ...) and instance; tags use the driver. */
function providerFields(instanceId: string | null, drivers: Map<string, string>) {
  return {
    provider: (instanceId !== null ? drivers.get(instanceId) : undefined) ?? instanceId,
    providerInstanceId: instanceId,
  };
}

function loadRuns(t3Db: Database, drivers: Map<string, string>): Map<string, ProviderTurn> {
  const rows = t3Db.prepare(`
    SELECT run_id, provider_instance_id,
      json_extract(payload_json, '$.modelSelection') AS model_selection
    FROM orchestration_v2_projection_runs
  `).all() as RunRow[];
  const runs = new Map<string, ProviderTurn>();
  for (const row of rows) {
    const selection = row.model_selection ? JSON.parse(row.model_selection) : null;
    runs.set(row.run_id, {
      ...providerFields(row.provider_instance_id, drivers),
      ...modelSelectionFields(selection),
    });
  }
  return runs;
}

function legacyCompletedActivityId(payload: Record<string, unknown>): string | null {
  const activities = Array.isArray(payload.legacyActivities) ? payload.legacyActivities : [];
  for (const value of activities) {
    const activity = recordFromUnknown(value);
    if (activity?.kind === "tool.completed") return asString(activity.id);
  }
  return null;
}

function stringifyOutput(value: unknown): string | null {
  if (typeof value === "string") return asString(value);
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/**
 * Map one tool-like turn item to tool_use/tool_result blocks, normalized to
 * the Anthropic tool vocabulary (Bash / Edit / WebSearch / Grep / Task /
 * AskUserQuestion) so the web app's per-tool summaries apply. Provider
 * tools (Read, MCP tools, ...) keep their own names.
 */
export function turnItemToBlocks(item: Record<string, unknown>): ContentBlock[] {
  const id =
    asString(recordFromUnknown(item.nativeItemRef)?.nativeId) ?? asString(item.id) ?? "tool";
  const failed = item.status === "failed";
  const toolUse = (name: string, input: Record<string, unknown> | undefined): ContentBlock => ({
    type: "tool_use",
    name,
    id,
    input,
  });
  const withResult = (use: ContentBlock, content: unknown, error: string | null): ContentBlock[] => {
    if (error !== null) return [use, { type: "tool_result", tool_use_id: id, error }];
    if (content === undefined || content === null || content === "") return [use];
    return [use, { type: "tool_result", tool_use_id: id, content }];
  };

  switch (item.type) {
    case "command_execution": {
      const command = asString(item.input);
      if (!command) return [];
      const output = asString(item.output);
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      const error =
        (exitCode !== null && exitCode !== 0) || failed
          ? (output ?? (exitCode !== null ? `exit code ${exitCode}` : "Command failed"))
          : null;
      return withResult(toolUse("Bash", { command }), output, error);
    }
    case "file_change": {
      const filePath = asString(item.fileName);
      if (!filePath) return [];
      const diff = asString(item.diffStr) ?? asString(item.newStr);
      return withResult(
        toolUse("Edit", { file_path: filePath }),
        diff,
        failed ? "File change failed" : null
      );
    }
    case "dynamic_tool": {
      const name = asString(item.toolName) ?? asString(item.title) ?? "tool";
      const input =
        recordFromUnknown(item.input) ??
        (item.input === undefined || item.input === null ? undefined : { input: item.input });
      return withResult(
        toolUse(name, input),
        item.output,
        failed ? (stringifyOutput(item.output) ?? "Tool call failed") : null
      );
    }
    case "web_search": {
      const patterns = Array.isArray(item.patterns)
        ? item.patterns.filter((p): p is string => typeof p === "string" && p.length > 0)
        : [];
      const input =
        patterns.length === 0
          ? undefined
          : patterns.length === 1
            ? { query: patterns[0] }
            : { query: patterns[0], queries: patterns };
      return withResult(toolUse("WebSearch", input), item.results, failed ? "Search failed" : null);
    }
    case "file_search": {
      const pattern = asString(item.pattern);
      return withResult(
        toolUse("Grep", pattern ? { pattern } : undefined),
        item.results,
        failed ? "Search failed" : null
      );
    }
    case "subagent": {
      const input: Record<string, unknown> = { prompt: item.prompt };
      const description = asString(item.title);
      if (description) input.description = description;
      const result = asString(item.result);
      return withResult(
        toolUse("Task", input),
        result,
        failed ? (result ?? "Subagent failed") : null
      );
    }
    case "user_input_request": {
      const answers = recordFromUnknown(item.questionAnswer)?.answers;
      return withResult(toolUse("AskUserQuestion", { questions: item.questions }), answers, null);
    }
    default:
      return [];
  }
}

/**
 * Plan events from a v2 store. With a `cursor` (from a previous run's
 * stats), only rows changed since then are read, plus every row of threads
 * that are new, changed metadata, or whose migrated v1 transcript landed
 * since then — their rows keep older `updated_at` values.
 *
 * Call inside a read transaction so every query sees one snapshot.
 */
export function* readT3CodeV2Events(
  t3Db: Database,
  options: { cursor: string | null },
  stats: T3V2ReadStats
): Generator<PlannedT3Event> {
  const skip = (reason: string) => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
  };

  const since = options.cursor
    ? new Date(Date.parse(options.cursor) - T3_V2_CURSOR_OVERLAP_MS).toISOString()
    : null;
  stats.cursor = options.cursor;

  const drivers = loadInstanceDrivers(t3Db);
  const threads = loadThreads(t3Db, drivers);
  const runs = loadRuns(t3Db, drivers);

  // Migrated v1 threads are read once T3 has copied their transcript in;
  // until then the v2 tables hold only a partial shell.
  const pendingThreads = new Set<string>();
  const wholeThreads = new Set<string>();
  const legacyRows = t3Db.prepare(`
    SELECT thread_id, transcript_imported_at FROM orchestration_v2_legacy_imports
  `).all() as { thread_id: string; transcript_imported_at: string | null }[];
  for (const row of legacyRows) {
    if (row.transcript_imported_at === null) {
      pendingThreads.add(row.thread_id);
      continue;
    }
    stats.cursor = maxTimestamp(stats.cursor, row.transcript_imported_at);
    if (since !== null && row.transcript_imported_at > since) wholeThreads.add(row.thread_id);
  }
  stats.pendingTranscriptThreads = pendingThreads.size;
  // New threads (forks copy history with old timestamps) and threads whose
  // title/flags/project changed are re-read whole; unchanged rows cost no
  // writes, changed ones are rewritten.
  for (const [threadId, thread] of threads) {
    stats.cursor = maxTimestamp(stats.cursor, thread.changedAt);
    if (since !== null && thread.changedAt > since) wholeThreads.add(threadId);
  }

  const changedClause =
    since === null ? "" : "AND (updated_at > ? OR thread_id IN (SELECT value FROM json_each(?)))";
  const changedParams = since === null ? [] : [since, JSON.stringify([...wholeThreads])];

  const context = (threadId: string, runId: string | null) => {
    const thread = threads.get(threadId);
    if (!thread) return null;
    const turn = (runId !== null ? runs.get(runId) : undefined) ?? thread;
    return {
      title: t3EventTitle(thread.projectTitle, thread.title),
      model: turn.model,
      tags: t3EventTags({
        projectTitle: thread.projectTitle,
        model: turn.model,
        provider: turn.provider,
        branch: thread.branch,
      }),
      raw: {
        ...thread.raw,
        run_id: runId,
        provider: turn.provider,
        provider_instance_id: turn.providerInstanceId,
        model: turn.model,
        model_options: turn.modelOptions,
      },
    };
  };

  const messages = t3Db.prepare(`
    SELECT message_id, thread_id, run_id, role, created_at, updated_at, payload_json
    FROM orchestration_v2_projection_messages
    WHERE streaming = 0 ${changedClause}
  `);
  for (const row of messages.iterate(...changedParams) as IterableIterator<MessageRow>) {
    stats.cursor = maxTimestamp(stats.cursor, row.updated_at);
    if (pendingThreads.has(row.thread_id)) {
      skip("pending_transcript");
      continue;
    }
    if (row.role !== "user" && row.role !== "assistant") {
      skip(`message_role_${row.role}`);
      continue;
    }
    const ctx = context(row.thread_id, row.run_id);
    if (!ctx) {
      skip("missing_thread");
      continue;
    }
    const payload = parsePayload(row.payload_json, `message ${row.message_id}`);
    const text = typeof payload.text === "string" ? payload.text : "";
    const attachments =
      Array.isArray(payload.attachments) && payload.attachments.length > 0
        ? payload.attachments
        : undefined;
    if (text.trim() === "" && !attachments) {
      skip("empty_message");
      continue;
    }

    yield {
      kind: "message",
      sourceId: `${row.thread_id}:${row.message_id}`,
      role: row.role,
      timestamp: row.created_at,
      title: ctx.title,
      content: text,
      model: ctx.model,
      tags: ctx.tags,
      raw: {
        ...ctx.raw,
        message_id: row.message_id,
        created_by: asString(payload.createdBy),
        creation_source: asString(payload.creationSource),
        sender_thread_id: asString(payload.senderThreadId),
        attachments,
        // Original payload, preserved for reprocessing.
        message: payload,
      },
      attachments: attachments && { messageId: row.message_id, items: attachments },
    };
  }

  const items = t3Db.prepare(`
    SELECT turn_item_id, thread_id, run_id, type, status, updated_at, payload_json
    FROM orchestration_v2_projection_turn_items
    WHERE type IN (${sqlList(IMPORTED_ITEM_TYPES)})
      AND status IN (${sqlList(TERMINAL_ITEM_STATUSES)})
      ${changedClause}
  `);
  for (const row of items.iterate(...changedParams) as IterableIterator<TurnItemRow>) {
    stats.cursor = maxTimestamp(stats.cursor, row.updated_at);
    if (pendingThreads.has(row.thread_id)) {
      skip("pending_transcript");
      continue;
    }
    const ctx = context(row.thread_id, row.run_id);
    if (!ctx) {
      skip("missing_thread");
      continue;
    }
    const payload = parsePayload(row.payload_json, `turn item ${row.turn_item_id}`);
    const timestamp =
      asString(payload.completedAt) ?? asString(payload.startedAt) ?? row.updated_at;
    const sourceId = `${row.thread_id}:${legacyCompletedActivityId(payload) ?? row.turn_item_id}`;
    const base = {
      sourceId,
      role: "assistant" as const,
      timestamp,
      title: ctx.title,
      model: ctx.model,
      tags: ctx.tags,
    };
    const itemRaw = { ...ctx.raw, turn_item_id: row.turn_item_id, item_type: row.type };

    if (row.type === "proposed_plan" || row.type === "reasoning") {
      const text = row.type === "proposed_plan" ? asString(payload.markdown) : asString(payload.text);
      if (payload.streaming === true || row.status !== "completed" || !text?.trim()) {
        skip(`${row.type}_incomplete`);
        continue;
      }
      if (row.type === "proposed_plan") {
        yield {
          ...base,
          kind: "plan",
          content: text,
          raw: { ...itemRaw, plan_id: asString(payload.planId), item: payload },
        };
      } else {
        // Thinking stays out of `content` (and FTS), like the other AI parsers.
        yield {
          ...base,
          kind: "reasoning",
          content: "",
          raw: { ...itemRaw, content: [{ type: "thinking", thinking: text }], item: payload },
        };
      }
      continue;
    }

    const blocks = turnItemToBlocks(payload);
    if (blocks.length === 0) {
      skip(`${row.type}_without_blocks`);
      continue;
    }
    // Tool calls are assistant actions; content stays empty so tool noise
    // never reaches FTS (matching the other AI parsers).
    yield {
      ...base,
      kind: "tool_call",
      content: "",
      raw: {
        ...itemRaw,
        child_thread_id: row.type === "subagent" ? asString(payload.childThreadId) : undefined,
        content: blocks,
        // Original payload, preserved for reprocessing (blocks are derived).
        item: payload,
      },
    };
  }
}
