import { Database } from "bun:sqlite";
import { join } from "node:path";
import { importOpenCode } from "../../parsers/opencode";
import { LATEST_V2_MIGRATION, V1_SESSION_DDL, V2_DDL } from "../../parsers/opencode.fixture";
import type { SeedContext, SeedSource } from "../context";
import type { Rng } from "../rng";
import { CODING_ACCOUNT, type CodingSession, planCodingSessions, type ToolCall } from "./coding-data";

const NAME = "opencode";

const MODELS = [
  { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
  { providerID: "openai", modelID: "gpt-5" },
  { providerID: "opencode", modelID: "grok-code" },
] as const;
type Model = (typeof MODELS)[number];

/**
 * Where each session lives, as on a long-running install: sessions from before
 * OpenCode 1.2 in the storage/ JSON tree, OpenCode 1.x in opencode.db's v1
 * tables, and OpenCode 2 in its v2 tables. The newest v1 sessions are also
 * projected into v2, as OpenCode 2's V1Migration leaves them, so the importer
 * sees the same messages in two stores.
 */
const STORAGE_BEFORE_DAYS_AGO = 300;
const V2_FROM_DAYS_AGO = 120;
const MIGRATED_V1_SESSIONS = 3;

interface ToolState {
  status: "completed" | "error";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { start: number; end: number };
}

/** Legacy part (storage JSON and v1 rows) minus the ids the stores hold separately. */
type LegacyPart =
  | { type: "text"; text: string; time: { start: number; end: number } }
  | { type: "step-start"; snapshot: string }
  | { type: "step-finish"; reason: string; snapshot: string }
  | { type: "tool"; callID: string; tool: string; state: ToolState };

interface PlannedMessage {
  id: string;
  role: "user" | "assistant";
  created: number;
  completed?: number;
  /** Legacy message object minus id/sessionID. */
  data: Record<string, unknown>;
  parts: { id: string; part: LegacyPart }[];
}

interface PlannedSession {
  id: string;
  projectID: string;
  plan: CodingSession;
  messages: PlannedMessage[];
}

function toolPart(call: ToolCall): { tool: string; input: Record<string, unknown>; title: string } {
  switch (call.kind) {
    case "read":
      return { tool: "read", input: { filePath: call.path }, title: call.path };
    case "grep":
      return { tool: "grep", input: { pattern: call.pattern, path: call.path }, title: call.pattern };
    case "edit":
      return { tool: "edit", input: { filePath: call.path, oldString: call.oldText, newString: call.newText }, title: call.path };
    case "write":
      return { tool: "write", input: { filePath: call.path, content: call.content }, title: call.path };
    case "bash":
      return { tool: "bash", input: { command: call.command, description: call.description }, title: call.command };
  }
}

function planSession(rng: Rng, nextId: (prefix: string) => string, session: CodingSession, projectID: string): PlannedSession {
  const model = rng.pick(MODELS);
  const dir = session.project.dir;
  const messages: PlannedMessage[] = [];

  const message = (role: "user" | "assistant", created: number, completed: number | undefined, parts: LegacyPart[]) => {
    const tokens = { input: rng.int(200, 4000), output: rng.int(40, 900), reasoning: 0, cache: { read: rng.int(4000, 40000), write: rng.int(0, 2000) } };
    const data: Record<string, unknown> =
      role === "user"
        ? { role, time: { created }, agent: "build", model: { providerID: model.providerID, modelID: model.modelID } }
        : {
            role,
            time: { created, completed },
            modelID: model.modelID,
            providerID: model.providerID,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: model.providerID === "opencode" ? 0 : Number(rng.float(0.002, 0.06).toFixed(6)),
            tokens,
            finish: parts.some((p) => p.type === "tool") ? "tool-calls" : "stop",
          };
    messages.push({ id: nextId("msg"), role, created, completed, data, parts: parts.map((part) => ({ id: nextId("prt"), part })) });
  };

  for (const exchange of session.exchanges) {
    message("user", exchange.promptAt, undefined, [{ type: "text", text: exchange.prompt, time: { start: exchange.promptAt, end: exchange.promptAt } }]);
    for (const step of exchange.steps) {
      const parts: LegacyPart[] = [{ type: "step-start", snapshot: rng.hex(40) }];
      if (step.text) parts.push({ type: "text", text: step.text, time: { start: step.at, end: step.at + 800 } });
      for (const call of step.tools) {
        const part = toolPart(call);
        const failed = call.kind === "bash" && call.error;
        parts.push({
          type: "tool",
          callID: `call_${rng.hex(24)}`,
          tool: part.tool,
          state: {
            status: failed ? "error" : "completed",
            input: part.input,
            output: call.output,
            title: part.title,
            metadata: call.kind === "bash" ? { output: call.output, exit: failed ? 1 : 0, description: call.description } : {},
            time: { start: call.at, end: call.doneAt },
          },
        });
      }
      parts.push({ type: "step-finish", reason: "tool-calls", snapshot: rng.hex(40) });
      message("assistant", step.at, step.tools.at(-1)?.doneAt ?? step.at + 2000, parts);
    }
    message("assistant", exchange.replyAt - 1500, exchange.replyAt, [
      { type: "step-start", snapshot: rng.hex(40) },
      { type: "text", text: exchange.reply, time: { start: exchange.replyAt - 2000, end: exchange.replyAt } },
      { type: "step-finish", reason: "stop", snapshot: rng.hex(40) },
    ]);
  }
  return { id: nextId("ses"), projectID, plan: session, messages };
}

function sessionRecord(s: PlannedSession, version: string) {
  return {
    id: s.id,
    slug: s.plan.slug,
    version,
    projectID: s.projectID,
    directory: s.plan.project.dir,
    title: s.plan.task.title,
    time: { created: s.plan.start, updated: s.plan.end },
  };
}

/** The legacy `storage/` JSON tree, as OpenCode wrote it before 1.2. */
function writeStorage(ctx: SeedContext, sessions: readonly PlannedSession[], projects: ReadonlyMap<string, string>): void {
  for (const [dir, projectID] of projects) {
    ctx.writeStaged(NAME, `storage/project/${projectID}.json`, JSON.stringify({ id: projectID, worktree: dir, vcs: "git" }));
  }
  for (const s of sessions) {
    ctx.writeStaged(NAME, `storage/session/${s.projectID}/${s.id}.json`, JSON.stringify(sessionRecord(s, "1.0.85")));
    for (const m of s.messages) {
      ctx.writeStaged(NAME, `storage/message/${s.id}/${m.id}.json`, JSON.stringify({ id: m.id, sessionID: s.id, ...m.data }));
      for (const { id, part } of m.parts) {
        ctx.writeStaged(NAME, `storage/part/${m.id}/${id}.json`, JSON.stringify({ id, sessionID: s.id, messageID: m.id, ...part }));
      }
    }
  }
}

/** A legacy assistant message as OpenCode 2's V1Migration projects it into session_message. */
function v2Assistant(m: PlannedMessage): Record<string, unknown> {
  const content = m.parts.flatMap(({ part }): Record<string, unknown>[] => {
    if (part.type === "text") return [{ type: "text", text: part.text }];
    if (part.type !== "tool") return [];
    const { state } = part;
    return [
      {
        type: "tool",
        id: part.callID,
        name: part.tool,
        state:
          state.status === "completed"
            ? { status: "completed", input: state.input, content: [{ type: "text", text: state.output }] }
            : { status: "error", input: state.input, error: { type: "Tool.Error", message: state.output } },
        time: { created: state.time.start, completed: state.time.end },
      },
    ];
  });
  const { modelID, providerID, agent, finish, cost, tokens, time } = m.data;
  return { agent, model: { providerID, id: modelID, variant: "default" }, content, finish, cost, tokens, time };
}

/** opencode.db with both table generations, as an install upgraded from 1.x to 2 leaves it. */
function writeDatabase(
  ctx: SeedContext,
  v1: readonly PlannedSession[],
  v2: readonly PlannedSession[],
  projects: ReadonlyMap<string, string>,
): void {
  const db = new Database(join(ctx.stage(NAME), "opencode.db"), { create: true });
  try {
    db.run(V2_DDL);
    db.run(V1_SESSION_DDL);
    db.transaction(() => {
      const first = ctx.localDate(ctx.startDate, 9).getTime();
      db.prepare("INSERT INTO migration (id, time_completed) VALUES (?, ?)").run(LATEST_V2_MIGRATION, first);
      db.prepare("INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)").run(
        "migration.v1-v2",
        JSON.stringify({ phase: "completed" }),
        first,
        first,
      );
      const project = db.prepare("INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, 'git', ?, ?, '[]')");
      for (const [dir, projectID] of projects) project.run(projectID, dir, first, first);

      const v1Session = db.prepare(`
        INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
        VALUES (?, ?, NULL, ?, ?, ?, '1.2.27', ?, ?)
      `);
      const v1Message = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)");
      const v1Part = db.prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const s of v1) {
        v1Session.run(s.id, s.projectID, s.plan.slug, s.plan.project.dir, s.plan.task.title, s.plan.start, s.plan.end);
        for (const m of s.messages) {
          v1Message.run(m.id, s.id, m.created, m.completed ?? m.created, JSON.stringify(m.data));
          for (const { id, part } of m.parts) v1Part.run(id, m.id, s.id, m.created, m.created, JSON.stringify(part));
        }
      }

      const v2Session = db.prepare(`
        INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, model, time_created, time_updated)
        VALUES (?, ?, NULL, ?, ?, ?, '2.0.28', ?, ?, ?)
      `);
      const v2Message = db.prepare(`
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const s of v2) {
        const firstAssistant = s.messages.find((m) => m.role === "assistant")?.data;
        const model = { id: firstAssistant?.modelID, providerID: firstAssistant?.providerID };
        v2Session.run(s.id, s.projectID, s.plan.slug, s.plan.project.dir, s.plan.task.title, JSON.stringify(model), s.plan.start, s.plan.end);
        let seq = 0;
        for (const m of s.messages) {
          const data =
            m.role === "user"
              ? { text: m.parts.map(({ part }) => (part.type === "text" ? part.text : "")).join(""), time: { created: m.created } }
              : v2Assistant(m);
          v2Message.run(m.id, s.id, m.role, seq++, m.created, m.completed ?? m.created, JSON.stringify(data));
        }
      }
    })();
  } finally {
    db.close();
  }
}

export const opencodeSeed: SeedSource = {
  name: NAME,
  produces: { opencode: ["opencode:message:user", "opencode:message:assistant"] },
  async seed(ctx) {
    const rng = ctx.rng("opencode");
    const plans = planCodingSessions(ctx, ctx.rng("opencode:plan"), {
      fromDaysAgo: 480,
      toDaysAgo: 2,
      sessions: 56,
      exchanges: [2, 4],
    }).sort((a, b) => a.start - b.start);
    let counter = 0;
    const nextId = (prefix: string) => `${prefix}_${(counter++).toString(16).padStart(10, "0")}${rng.hex(14)}`;
    const projects = new Map<string, string>();
    const sessions = plans.map((plan) => {
      let projectID = projects.get(plan.project.dir);
      if (!projectID) {
        projectID = rng.hex(40);
        projects.set(plan.project.dir, projectID);
      }
      return planSession(rng, nextId, plan, projectID);
    });

    const storage = sessions.filter((s) => s.plan.day.daysAgo > STORAGE_BEFORE_DAYS_AGO);
    const v1 = sessions.filter((s) => s.plan.day.daysAgo <= STORAGE_BEFORE_DAYS_AGO && s.plan.day.daysAgo > V2_FROM_DAYS_AGO);
    const v2Native = sessions.filter((s) => s.plan.day.daysAgo <= V2_FROM_DAYS_AGO);
    if (storage.length === 0 || v1.length <= MIGRATED_V1_SESSIONS || v2Native.length === 0) {
      throw new Error("opencode seed: the session plan left a store empty; adjust the era boundaries");
    }

    writeStorage(ctx, storage, projects);
    writeDatabase(ctx, v1, [...v1.slice(-MIGRATED_V1_SESSIONS), ...v2Native], projects);

    const stats = await importOpenCode(ctx.db, ctx.stage(NAME), CODING_ACCOUNT);
    for (const [store, count] of Object.entries(stats.byStore)) {
      if (count === 0) throw new Error(`opencode seed: the importer read nothing from ${store}`);
    }
    if (stats.overlapping === 0) throw new Error("opencode seed: no messages overlapped between v1 and v2");
    ctx.identify("alex", `opencode:${CODING_ACCOUNT}`);
  },
};
