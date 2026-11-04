import { Database } from "bun:sqlite";
import { join } from "node:path";
import { detectAccountFromRepos, importConductor } from "../../parsers/conductor";
import type { SeedSource } from "../context";
import { HOME_DIR } from "../persona";
import { anthropicToolUse, CODING_ACCOUNT, codingScreenshot, iso, planCodingSessions } from "./coding-data";

/** Conductor names each workspace after a city. */
const CITIES = ["lisbon", "kyoto", "oslo", "lima", "hanoi", "quito", "tallinn", "porto", "dakar", "cusco", "bergen", "perth", "seoul", "nairobi", "riga"];
const MODELS = ["claude-sonnet-4-5", "claude-opus-4-5"] as const;

export const conductorSeed: SeedSource = {
  name: "conductor",
  produces: { conductor: ["conductor:message:user", "conductor:message:assistant"] },
  async seed(ctx) {
    const rng = ctx.rng("conductor");
    const sessions = planCodingSessions(ctx, ctx.rng("conductor:plan"), {
      fromDaysAgo: 330,
      toDaysAgo: 14,
      sessions: 15,
      exchanges: [2, 5],
      images: 3,
    });

    const dbPath = join(ctx.stage("conductor"), "conductor.db");
    const db = new Database(dbPath, { create: true });
    // One transaction: autocommitting each row costs an fsync apiece.
    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, default_branch TEXT, created_at TEXT);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, repository_id TEXT, directory_name TEXT, branch TEXT, state TEXT, created_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, status TEXT, agent_type TEXT, model TEXT, created_at TEXT);
      CREATE TABLE session_messages (
        id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, model TEXT,
        sent_at TEXT, created_at TEXT, turn_id TEXT, cancelled_at TEXT
      );
    `);
    const insertRepo = db.prepare("INSERT INTO repos VALUES (?, ?, ?, 'main', ?)");
    const insertWorkspace = db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?, 'ready', ?)");
    const insertSession = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, 'idle', 'claude', ?, ?)");
    const insertMessage = db.prepare("INSERT INTO session_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)");

    const repoIds = new Map<string, string>();
    for (const [index, session] of sessions.entries()) {
      let repoId = repoIds.get(session.project.name);
      if (!repoId) {
        repoId = rng.uuid();
        repoIds.set(session.project.name, repoId);
        insertRepo.run(repoId, session.project.name, session.project.dir, iso(session.start));
      }
      const city = CITIES[index % CITIES.length] ?? "lisbon";
      const workspaceId = rng.uuid();
      const workspaceDir = `${HOME_DIR}/conductor/workspaces/${session.project.name}/${city}`;
      insertWorkspace.run(workspaceId, repoId, city, session.branch, iso(session.start));
      const sessionId = rng.uuid();
      const model = rng.pick(MODELS);
      insertSession.run(sessionId, workspaceId, session.task.title, model, iso(session.start));

      // Conductor runs the agent inside the workspace checkout, not the main clone.
      const inWorkspace = (text: string) => text.replaceAll(session.project.dir, workspaceDir);
      const write = (role: "user" | "assistant", at: number, turnId: string, content: unknown[]) => {
        const sdk =
          role === "user"
            ? { type: "user", uuid: rng.uuid(), session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content } }
            : {
                type: "assistant",
                uuid: rng.uuid(),
                session_id: sessionId,
                parent_tool_use_id: null,
                message: {
                  id: `msg_01${rng.hex(22)}`,
                  type: "message",
                  role: "assistant",
                  model,
                  content,
                  stop_reason: null,
                  usage: { input_tokens: rng.int(3, 20), output_tokens: rng.int(40, 800), cache_read_input_tokens: rng.int(10000, 80000) },
                },
              };
        insertMessage.run(rng.uuid(), sessionId, role, inWorkspace(JSON.stringify(sdk)), role === "assistant" ? model : null, iso(at), iso(at), turnId);
      };

      for (const exchange of session.exchanges) {
        const turnId = rng.uuid();
        const prompt: unknown[] = [{ type: "text", text: exchange.prompt }];
        if (exchange.image) {
          prompt.push({ type: "image", source: { type: "base64", media_type: "image/png", data: (await codingScreenshot(ctx, rng)).toString("base64") } });
        }
        write("user", exchange.promptAt, turnId, prompt);
        for (const step of exchange.steps) {
          if (step.text) write("assistant", step.at, turnId, [{ type: "text", text: step.text }]);
          for (const call of step.tools) {
            const id = `toolu_01${rng.hex(22)}`;
            write("assistant", call.at, turnId, [anthropicToolUse(call, id)]);
            const isError = call.kind === "bash" && call.error;
            write("user", call.doneAt, turnId, [{ type: "tool_result", tool_use_id: id, content: call.output, ...(isError ? { is_error: true } : {}) }]);
          }
        }
        write("assistant", exchange.replyAt, turnId, [{ type: "text", text: exchange.reply }]);
      }
    }
    db.exec("COMMIT");
    db.close();

    // The CLI derives the account from branch prefixes; use the same detection.
    const account = detectAccountFromRepos(dbPath);
    if (account !== CODING_ACCOUNT) throw new Error(`Conductor account detection returned ${account}`);
    await importConductor(ctx.db, dbPath, account);
    ctx.identify("alex", `conductor:${account}`);
  },
};
