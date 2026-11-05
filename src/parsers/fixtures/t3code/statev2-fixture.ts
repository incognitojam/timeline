/**
 * Synthetic T3 Code orchestration v2 store for tests: applies the schema
 * generated from styal's own migrations (statev2-schema.sql) and seeds rows
 * shaped like the v2 contracts (packages/contracts/src/orchestrationV2.ts).
 * All content is invented.
 *
 * Seeded scenarios:
 * - MAIN: a thread that switches provider mid-way (a run on a custom
 *   "claude-work" instance of the claudeAgent driver, then a codex run), with an image attachment, tool calls of each kind, a failed
 *   command, reasoning, a proposed plan, a subagent, and rows that must not
 *   import (streaming/empty messages, a running command, a handoff, and a
 *   message item that duplicates the messages table)
 * - SUB: a provider-spawned subagent child thread of MAIN
 * - ARCHIVED / DELETED threads
 * - LEGACY: a thread migrated from the v1 store, keeping v1 message and
 *   activity ids
 * - PENDING: a migrated thread whose transcript has not landed yet
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";

export const T3_V2_SCHEMA_SQL = readFileSync(join(import.meta.dir, "statev2-schema.sql"), "utf8");

export const FIXTURE = {
  projectId: "project-demo",
  projectTitle: "demo-app",
  workspaceRoot: "/home/alice/code/demo-app",
  threads: {
    main: "thread-main",
    sub: "thread-sub",
    archived: "thread-archived",
    deleted: "thread-deleted",
    legacy: "thread-legacy",
    pending: "thread-pending",
  },
  runs: { claude: "run-main-1", codex: "run-main-2" },
  /** Custom provider instance of the claudeAgent driver. */
  claudeInstance: "claude-work",
  models: { claude: "claude-opus-5-5", codex: "gpt-6.1-sol" },
  /** Provider-native session ids MAIN drove, by driver. */
  nativeSessions: {
    claudeAgent: "c1a0de00-0000-4000-8000-000000000001",
    codex: "019a0000-0000-7000-8000-000000000002",
    antigravity: "ag-session-0003",
  },
  image: {
    id: "thread-main-00000000-0000-4000-8000-0000000000aa",
    name: "mockup.png",
    mimeType: "image/png",
    bytes: Buffer.from("fixture v2 image bytes"),
  },
  legacy: {
    messageId: "legacy-message-1",
    startedActivityId: "legacy-activity-started",
    completedActivityId: "legacy-activity-completed",
  },
} as const;

type Json = Record<string, unknown>;

export function insertProject(db: Database, project: { id: string; title: string; workspaceRoot: string }): void {
  db.prepare(`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (?, ?, ?, '[]', '2026-05-01T09:00:00.000Z', '2026-05-01T09:00:00.000Z')
  `).run(project.id, project.title, project.workspaceRoot);
}

export function insertThread(db: Database, thread: {
  id: string;
  title: string;
  provider: string;
  model: string;
  createdAt: string;
  projectId?: string;
  branch?: string | null;
  worktreePath?: string | null;
  createdBy?: "user" | "agent" | "system";
  creationSource?: "web" | "mcp" | "provider" | "server";
  lineage?: { parentThreadId: string | null; relationshipToParent: "fork" | "subagent" | null; rootThreadId: string };
  historyOrigin?: "native" | "v1_import";
  archivedAt?: string | null;
  deletedAt?: string | null;
}): void {
  const projectId = thread.projectId ?? FIXTURE.projectId;
  const payload: Json = {
    createdBy: thread.createdBy ?? "user",
    creationSource: thread.creationSource ?? "web",
    id: thread.id,
    projectId,
    title: thread.title,
    providerInstanceId: thread.provider,
    modelSelection: { instanceId: thread.provider, model: thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: thread.branch ?? null,
    worktreePath: thread.worktreePath ?? null,
    activeProviderThreadId: null,
    ...(thread.historyOrigin ? { historyOrigin: thread.historyOrigin } : {}),
    lineage: thread.lineage ?? { parentThreadId: null, relationshipToParent: null, rootThreadId: thread.id },
    forkedFrom: null,
    createdAt: thread.createdAt,
    updatedAt: thread.createdAt,
    archivedAt: thread.archivedAt ?? null,
    deletedAt: thread.deletedAt ?? null,
  };
  db.prepare(`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, archived_at, deleted_at, payload_json, provider_instance_id
    ) VALUES (?, ?, ?, ?, 'full-access', 'default', ?, ?, ?, ?, ?, ?)
  `).run(
    thread.id, projectId, thread.title, thread.provider, thread.createdAt, thread.createdAt,
    thread.archivedAt ?? null, thread.deletedAt ?? null, JSON.stringify(payload), thread.provider,
  );
}

export function insertRun(db: Database, run: {
  id: string;
  threadId: string;
  ordinal: number;
  /** Provider instance id (styal stores no driver on runs). */
  provider: string;
  model: string;
  requestedAt: string;
}): void {
  const payload: Json = {
    id: run.id,
    threadId: run.threadId,
    ordinal: run.ordinal,
    providerInstanceId: run.provider,
    modelSelection: { instanceId: run.provider, model: run.model },
    providerThreadId: null,
    userMessageId: `${run.id}-user`,
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: run.requestedAt,
    startedAt: run.requestedAt,
    completedAt: run.requestedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
  db.prepare(`
    INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, status, requested_at, payload_json, provider_instance_id
    ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)
  `).run(run.id, run.threadId, run.ordinal, run.provider, run.requestedAt, JSON.stringify(payload), run.provider);
}

export function insertMessage(db: Database, message: {
  id: string;
  threadId: string;
  runId: string | null;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
  updatedAt?: string;
  streaming?: boolean;
  attachments?: Json[];
  createdBy?: "user" | "agent" | "system";
}): void {
  const updatedAt = message.updatedAt ?? message.createdAt;
  const payload: Json = {
    createdBy: message.createdBy ?? (message.role === "user" ? "user" : "agent"),
    creationSource: "web",
    id: message.id,
    threadId: message.threadId,
    runId: message.runId,
    nodeId: null,
    role: message.role,
    text: message.text,
    attachments: message.attachments ?? [],
    streaming: message.streaming ?? false,
    createdAt: message.createdAt,
    updatedAt,
  };
  db.prepare(`
    INSERT INTO orchestration_v2_projection_messages (
      message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(
    message.id, message.threadId, message.runId, message.role, message.streaming ? 1 : 0,
    message.createdAt, updatedAt, JSON.stringify(payload),
  );
}

let nextOrdinal = 1;

/** Insert a turn item; `fields` holds the type-specific contract fields. */
export function insertTurnItem(db: Database, item: {
  id: string;
  threadId: string;
  runId: string | null;
  type: string;
  status: string;
  at: string;
  updatedAt?: string;
  nativeId?: string;
  driver?: string;
  fields?: Json;
}): void {
  const updatedAt = item.updatedAt ?? item.at;
  const payload: Json = {
    id: item.id,
    threadId: item.threadId,
    runId: item.runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: item.nativeId
      ? { driver: item.driver ?? "claudeAgent", nativeId: item.nativeId, strength: "strong" }
      : null,
    parentItemId: null,
    ordinal: nextOrdinal,
    status: item.status,
    title: null,
    startedAt: item.at,
    completedAt: item.status === "running" ? null : item.at,
    updatedAt,
    type: item.type,
    ...item.fields,
  };
  db.prepare(`
    INSERT INTO orchestration_v2_projection_turn_items (
      turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(item.id, item.threadId, item.runId, nextOrdinal++, item.type, item.status, updatedAt, JSON.stringify(payload));
}

export function insertProviderThread(db: Database, providerThread: {
  id: string;
  threadId: string;
  driver: string;
  /** Defaults to the driver name, like T3's built-in instances. */
  instanceId?: string;
  nativeId: string;
}): void {
  const instanceId = providerThread.instanceId ?? providerThread.driver;
  const payload: Json = {
    id: providerThread.id,
    driver: providerThread.driver,
    providerInstanceId: instanceId,
    providerSessionId: null,
    appThreadId: providerThread.threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: providerThread.driver, nativeId: providerThread.nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-01T10:00:00.000Z",
  };
  db.prepare(`
    INSERT INTO orchestration_v2_projection_provider_threads (
      provider_thread_id, thread_id, provider, status, updated_at, payload_json, driver, provider_instance_id
    ) VALUES (?, ?, ?, 'idle', '2026-05-01T10:00:00.000Z', ?, ?, ?)
  `).run(
    providerThread.id, providerThread.threadId, instanceId, JSON.stringify(payload),
    providerThread.driver, instanceId,
  );
}

export function insertLegacyImport(db: Database, threadId: string, transcriptImportedAt: string | null): void {
  db.prepare(`
    INSERT INTO orchestration_v2_legacy_imports (
      thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count
    ) VALUES (?, '2026-04-01T00:00:00.000Z', '2026-05-01T08:00:00.000Z', ?, 1)
  `).run(threadId, transcriptImportedAt);
}

/** Create the seeded store at `path` and return it open for further rows. */
export function createT3CodeV2Fixture(path: string): Database {
  nextOrdinal = 1;
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  // One transaction: per-row commits each fsync, which makes setup slow.
  db.transaction(() => seed(db))();
  return db;
}

function seed(db: Database): void {
  db.exec(T3_V2_SCHEMA_SQL);
  const { threads, runs, models, nativeSessions } = FIXTURE;

  insertProject(db, { id: FIXTURE.projectId, title: FIXTURE.projectTitle, workspaceRoot: FIXTURE.workspaceRoot });

  // MAIN: starts on claudeAgent, switches to codex for its second run.
  insertThread(db, {
    id: threads.main,
    title: "Add login form",
    provider: "codex",
    model: models.codex,
    createdAt: "2026-05-01T10:00:00.000Z",
    branch: "feature/login",
    worktreePath: "/home/alice/.t3/worktrees/demo-app/demo-1a2b",
  });
  insertRun(db, { id: runs.claude, threadId: threads.main, ordinal: 1, provider: FIXTURE.claudeInstance, model: models.claude, requestedAt: "2026-05-01T10:00:00.000Z" });
  insertRun(db, { id: runs.codex, threadId: threads.main, ordinal: 2, provider: "codex", model: models.codex, requestedAt: "2026-05-01T10:10:00.000Z" });
  insertProviderThread(db, { id: "provider-thread-claude", threadId: threads.main, driver: "claudeAgent", instanceId: FIXTURE.claudeInstance, nativeId: nativeSessions.claudeAgent });
  insertProviderThread(db, { id: "provider-thread-codex", threadId: threads.main, driver: "codex", nativeId: nativeSessions.codex });
  insertProviderThread(db, { id: "provider-thread-antigravity", threadId: threads.main, driver: "antigravity", nativeId: nativeSessions.antigravity });

  insertMessage(db, {
    id: "main-user-1",
    threadId: threads.main,
    runId: runs.claude,
    role: "user",
    text: "Please add a login form like this mockup",
    createdAt: "2026-05-01T10:00:00.000Z",
    attachments: [{
      type: "image",
      id: FIXTURE.image.id,
      name: FIXTURE.image.name,
      mimeType: FIXTURE.image.mimeType,
      sizeBytes: FIXTURE.image.bytes.length,
    }],
  });
  insertMessage(db, { id: "main-assistant-1", threadId: threads.main, runId: runs.claude, role: "assistant", text: "I'll add the form.", createdAt: "2026-05-01T10:01:00.000Z" });
  insertMessage(db, { id: "main-user-2", threadId: threads.main, runId: runs.codex, role: "user", text: "Now add tests for it", createdAt: "2026-05-01T10:10:00.000Z" });
  insertMessage(db, { id: "main-assistant-2", threadId: threads.main, runId: runs.codex, role: "assistant", text: "Tests added.", createdAt: "2026-05-01T10:15:00.000Z" });
  insertMessage(db, { id: "main-streaming", threadId: threads.main, runId: runs.codex, role: "assistant", text: "Still typ", createdAt: "2026-05-01T10:16:00.000Z", streaming: true });
  insertMessage(db, { id: "main-empty", threadId: threads.main, runId: runs.codex, role: "assistant", text: "  ", createdAt: "2026-05-01T10:16:30.000Z" });

  insertTurnItem(db, {
    id: "item-read", threadId: threads.main, runId: runs.claude, type: "dynamic_tool", status: "completed",
    at: "2026-05-01T10:00:30.000Z", nativeId: "toolu_fixture_read",
    fields: { toolName: "Read", input: { file_path: "/home/alice/code/demo-app/src/App.tsx" }, output: "export function App() {}" },
  });
  insertTurnItem(db, {
    id: "item-plan", threadId: threads.main, runId: runs.claude, type: "proposed_plan", status: "completed",
    at: "2026-05-01T10:00:45.000Z", fields: { planId: "plan-1", markdown: "# Plan\n- Add a LoginForm component", streaming: false },
  });
  insertTurnItem(db, {
    id: "item-subagent", threadId: threads.main, runId: runs.claude, type: "subagent", status: "completed",
    at: "2026-05-01T10:00:50.000Z", nativeId: "toolu_fixture_task",
    fields: {
      subagentId: "subagent-1", origin: "provider_native", driver: "claudeAgent", providerInstanceId: "claudeAgent",
      childThreadId: threads.sub, prompt: "Find existing form components", result: "Found two form components.",
      title: "Find form components",
    },
  });
  insertTurnItem(db, {
    id: "item-bash-ok", threadId: threads.main, runId: runs.codex, type: "command_execution", status: "completed",
    at: "2026-05-01T10:12:00.000Z", nativeId: "call_fixture_ok", driver: "codex",
    fields: { input: "bun test", output: "3 pass", exitCode: 0 },
  });
  insertTurnItem(db, {
    id: "item-bash-fail", threadId: threads.main, runId: runs.codex, type: "command_execution", status: "failed",
    at: "2026-05-01T10:12:30.000Z", nativeId: "call_fixture_fail", driver: "codex",
    fields: { input: "bun run lint", output: "1 problem", exitCode: 1 },
  });
  insertTurnItem(db, {
    id: "item-edit", threadId: threads.main, runId: runs.codex, type: "file_change", status: "completed",
    at: "2026-05-01T10:13:00.000Z", driver: "codex",
    fields: { fileName: "/home/alice/code/demo-app/src/LoginForm.test.tsx", diffStr: "+it('renders')\n" },
  });
  insertTurnItem(db, {
    id: "item-search", threadId: threads.main, runId: runs.codex, type: "web_search", status: "completed",
    at: "2026-05-01T10:13:30.000Z", driver: "codex",
    fields: { patterns: ["solid form validation"], results: [{ title: "Forms", url: "https://example.com/forms" }] },
  });
  insertTurnItem(db, {
    id: "item-reasoning", threadId: threads.main, runId: runs.codex, type: "reasoning", status: "completed",
    at: "2026-05-01T10:14:00.000Z", fields: { text: "Considering where the tests should live.", streaming: false },
  });
  // Not imported: still running, an unhandled item type, and a message item
  // that duplicates the messages table.
  insertTurnItem(db, {
    id: "item-running", threadId: threads.main, runId: runs.codex, type: "command_execution", status: "running",
    at: "2026-05-01T10:15:30.000Z", fields: { input: "bun run dev" },
  });
  insertTurnItem(db, {
    id: "item-handoff", threadId: threads.main, runId: runs.codex, type: "handoff", status: "completed",
    at: "2026-05-01T10:10:00.000Z",
    fields: { contextHandoffId: "handoff-1", fromProviderThreadIds: [], toProviderThreadId: "provider-thread-codex", fromProviderInstanceIds: ["claudeAgent"], toProviderInstanceId: "codex", strategy: "full_thread_summary" },
  });
  insertTurnItem(db, {
    id: "item-assistant-message", threadId: threads.main, runId: runs.codex, type: "assistant_message", status: "completed",
    at: "2026-05-01T10:15:00.000Z", fields: { messageId: "main-assistant-2", text: "Tests added.", streaming: false },
  });

  // SUB: the provider-spawned subagent's own conversation.
  insertThread(db, {
    id: threads.sub,
    title: "Find form components",
    provider: "claudeAgent",
    model: models.claude,
    createdAt: "2026-05-01T10:00:50.000Z",
    createdBy: "agent",
    creationSource: "provider",
    lineage: { parentThreadId: threads.main, relationshipToParent: "subagent", rootThreadId: threads.main },
  });
  insertMessage(db, { id: "sub-assistant-1", threadId: threads.sub, runId: null, role: "assistant", text: "Found two form components.", createdAt: "2026-05-01T10:00:55.000Z" });

  insertThread(db, {
    id: threads.archived, title: "Old spike", provider: "codex", model: models.codex,
    createdAt: "2026-05-02T09:00:00.000Z", archivedAt: "2026-05-03T09:00:00.000Z",
  });
  insertMessage(db, { id: "archived-user-1", threadId: threads.archived, runId: null, role: "user", text: "Try a spike", createdAt: "2026-05-02T09:00:00.000Z" });
  insertThread(db, {
    id: threads.deleted, title: "Scratch", provider: "codex", model: models.codex,
    createdAt: "2026-05-02T10:00:00.000Z", deletedAt: "2026-05-03T10:00:00.000Z",
  });
  insertMessage(db, { id: "deleted-user-1", threadId: threads.deleted, runId: null, role: "user", text: "Throwaway question", createdAt: "2026-05-02T10:00:00.000Z" });

  // LEGACY: migrated from v1 with its transcript; keeps the v1 ids.
  insertThread(db, {
    id: threads.legacy, title: "Legacy thread", provider: "codex", model: "gpt-5.4",
    createdAt: "2026-04-01T09:00:00.000Z", createdBy: "system", creationSource: "server", historyOrigin: "v1_import",
  });
  insertLegacyImport(db, threads.legacy, "2026-05-01T08:00:00.000Z");
  insertMessage(db, { id: FIXTURE.legacy.messageId, threadId: threads.legacy, runId: null, role: "user", text: "Legacy question", createdAt: "2026-04-01T09:00:00.000Z" });
  insertTurnItem(db, {
    id: `import:v1:activity:${threads.legacy}:exec-1`, threadId: threads.legacy, runId: null, type: "command_execution",
    status: "completed", at: "2026-04-01T09:01:00.000Z",
    fields: {
      legacyTurnId: "legacy-turn-1",
      legacyActivities: [
        { id: FIXTURE.legacy.startedActivityId, tone: "tool", kind: "tool.started", summary: "Ran command", turnId: "legacy-turn-1", createdAt: "2026-04-01T09:00:30.000Z" },
        { id: FIXTURE.legacy.completedActivityId, tone: "tool", kind: "tool.completed", summary: "Ran command", turnId: "legacy-turn-1", createdAt: "2026-04-01T09:01:00.000Z" },
      ],
      input: "git status",
      output: "clean",
      exitCode: 0,
    },
  });

  // PENDING: migrated shell whose transcript has not been copied in yet.
  insertThread(db, {
    id: threads.pending, title: "Pending thread", provider: "codex", model: "gpt-5.4",
    createdAt: "2026-04-02T09:00:00.000Z", createdBy: "system", creationSource: "server", historyOrigin: "v1_import",
  });
  insertLegacyImport(db, threads.pending, null);
  insertMessage(db, { id: "pending-user-1", threadId: threads.pending, runId: null, role: "user", text: "Pending question", createdAt: "2026-04-02T09:00:00.000Z" });
}
