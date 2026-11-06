import { Database } from "bun:sqlite";
import { join } from "node:path";
import { importT3Code } from "./parser";
import type { SeedSource } from "../../seed/context";
import { HOME_DIR } from "../../seed/persona";
import type { Rng } from "../../seed/rng";
import { anthropicToolUse, CODING_ACCOUNT, codingScreenshot, iso, planCodingSessions, type ToolCall } from "../../seed/sources/coding-data";

const PROVIDERS = [
  { instanceId: "claudeAgent", model: "claude-opus-4-5", options: [{ id: "effort", value: "high" }] },
  { instanceId: "claudeAgent", model: "claude-sonnet-4-5", options: [] },
  { instanceId: "codex", model: "gpt-5.1-codex", options: [{ id: "reasoningEffort", value: "medium" }] },
] as const;

/** Shell command Codex would run to do what a Read/Grep tool does. */
function codexCommand(call: ToolCall): string {
  switch (call.kind) {
    case "read":
      return `sed -n '1,200p' ${call.path}`;
    case "grep":
      return `rg -n "${call.pattern.replaceAll('"', '\\"')}" ${call.path}`;
    case "bash":
      return call.command;
    default:
      return "";
  }
}

function claudePayload(call: ToolCall, rng: Rng): Record<string, unknown> {
  const id = `toolu_01${rng.hex(22)}`;
  const block = anthropicToolUse(call, id);
  const isError = call.kind === "bash" && call.error;
  return {
    itemType: call.kind === "bash" ? "command_execution" : "dynamic_tool_call",
    detail: `${String(block.name)}: ${JSON.stringify(block.input)}`,
    data: {
      toolName: block.name,
      input: block.input,
      result: { tool_use_id: id, type: "tool_result", content: call.output, is_error: isError },
    },
  };
}

function codexPayload(call: ToolCall, cwd: string, rng: Rng): Record<string, unknown> {
  const id = `call_${rng.hex(24)}`;
  if (call.kind === "edit" || call.kind === "write") {
    const diff =
      call.kind === "edit"
        ? `@@\n${call.oldText.split("\n").map((l) => `-${l}`).join("\n")}\n${call.newText.split("\n").map((l) => `+${l}`).join("\n")}\n`
        : `${call.content.split("\n").map((l) => `+${l}`).join("\n")}\n`;
    return {
      itemType: "file_change",
      data: { item: { id, type: "fileChange", status: "completed", changes: [{ path: call.path, kind: { type: call.kind === "write" ? "add" : "update" }, diff }] } },
    };
  }
  const command = codexCommand(call);
  const failed = call.kind === "bash" && call.error;
  return {
    itemType: "command_execution",
    data: {
      completedAtMs: call.doneAt,
      item: {
        id,
        type: "commandExecution",
        status: "completed",
        command: `/bin/zsh -lc '${command.replaceAll("'", "'\\''")}'`,
        commandActions: [{ command, type: call.kind === "read" ? "read" : call.kind === "grep" ? "search" : "unknown" }],
        cwd,
        aggregatedOutput: `${call.output}\n`,
        exitCode: failed ? 1 : 0,
        durationMs: call.doneAt - call.at,
      },
    },
  };
}

export const t3codeSeed: SeedSource = {
  name: "t3code",
  produces: { t3code: ["t3code:message:user", "t3code:message:assistant"] },
  async seed(ctx) {
    const rng = ctx.rng("t3code");
    const sessions = planCodingSessions(ctx, ctx.rng("t3code:plan"), {
      fromDaysAgo: 180,
      toDaysAgo: 0,
      sessions: 34,
      exchanges: [2, 5],
      images: 7,
    });

    const root = ctx.stage("t3code");
    const dbPath = join(root, "state.sqlite");
    const db = new Database(dbPath, { create: true });
    // One transaction: autocommitting each row costs an fsync apiece.
    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, created_at TEXT);
      CREATE TABLE projection_threads (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT, worktree_path TEXT,
        model_selection_json TEXT, created_at TEXT, archived_at TEXT, deleted_at TEXT
      );
      CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, provider_name TEXT, status TEXT);
      CREATE TABLE projection_thread_messages (
        message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL,
        is_streaming INTEGER NOT NULL, created_at TEXT NOT NULL, attachments_json TEXT
      );
      CREATE TABLE projection_thread_activities (
        activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, tone TEXT NOT NULL, kind TEXT NOT NULL,
        summary TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, sequence INTEGER
      );
    `);
    const insertProject = db.prepare("INSERT INTO projection_projects VALUES (?, ?, ?, ?)");
    const insertThread = db.prepare("INSERT INTO projection_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)");
    const insertSession = db.prepare("INSERT INTO projection_thread_sessions VALUES (?, ?, 'idle')");
    const insertMessage = db.prepare("INSERT INTO projection_thread_messages VALUES (?, ?, ?, ?, ?, 0, ?, ?)");
    const insertActivity = db.prepare("INSERT INTO projection_thread_activities VALUES (?, ?, ?, 'tool', ?, ?, ?, ?, ?)");

    const projectIds = new Map<string, string>();
    for (const session of sessions) {
      let projectId = projectIds.get(session.project.name);
      if (!projectId) {
        projectId = rng.uuid();
        projectIds.set(session.project.name, projectId);
        insertProject.run(projectId, session.project.name, session.project.dir, iso(session.start));
      }
      const provider = rng.pick(PROVIDERS);
      const threadId = rng.uuid();
      const useWorktree = rng.chance(0.5);
      const worktree = useWorktree ? `${HOME_DIR}/.t3/worktrees/${session.project.name}/${session.branch.split("/").at(-1)}` : null;
      const cwd = worktree ?? session.project.dir;
      const archived = session.day.daysAgo > 45 && rng.chance(0.4) ? iso(session.end + 86_400_000) : null;
      insertThread.run(
        threadId,
        projectId,
        session.task.title,
        session.branch,
        worktree,
        JSON.stringify({ instanceId: provider.instanceId, model: provider.model, options: provider.options }),
        iso(session.start),
        archived,
      );
      insertSession.run(threadId, provider.instanceId);

      let sequence = 0;
      for (const exchange of session.exchanges) {
        const turnId = rng.uuid();
        let attachments: string | null = null;
        if (exchange.image) {
          const attachmentId = `${threadId}-${rng.hex(8)}`;
          const bytes = await codingScreenshot(ctx, rng);
          ctx.writeStaged("t3code", `attachments/${attachmentId}.png`, bytes);
          attachments = JSON.stringify([{ type: "image", id: attachmentId, name: `Screenshot ${iso(exchange.promptAt).slice(0, 10)} at ${rng.int(1, 12)}.${rng.int(10, 59)}.png`, mimeType: "image/png", sizeBytes: bytes.length }]);
        }
        insertMessage.run(rng.uuid(), threadId, turnId, "user", exchange.prompt, iso(exchange.promptAt), attachments);
        for (const step of exchange.steps) {
          if (step.text) insertMessage.run(rng.uuid(), threadId, turnId, "assistant", step.text, iso(step.at), null);
          for (const call of step.tools) {
            const payload = provider.instanceId === "codex" ? codexPayload(call, cwd, rng) : claudePayload(call, rng);
            const summary = call.kind === "bash" || provider.instanceId === "codex" ? "Command run" : "Tool call";
            const started = rng.uuid();
            insertActivity.run(started, threadId, turnId, "tool.started", summary, JSON.stringify({ itemType: payload.itemType }), iso(call.at), sequence++);
            insertActivity.run(rng.uuid(), threadId, turnId, "tool.completed", summary, JSON.stringify(payload).replaceAll(session.project.dir, cwd), iso(call.doneAt), sequence++);
          }
        }
        insertMessage.run(rng.uuid(), threadId, turnId, "assistant", exchange.reply, iso(exchange.replyAt), null);
      }
    }
    db.exec("COMMIT");
    db.close();

    await importT3Code(ctx.db, dbPath, CODING_ACCOUNT);
    ctx.identify("alex", `t3code:${CODING_ACCOUNT}`);
  },
};
