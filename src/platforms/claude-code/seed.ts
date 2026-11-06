import { join } from "node:path";
import { importClaudeCode } from "./parser";
import type { SeedSource } from "../../seed/context";
import { CODING_ACCOUNT, anthropicToolUse, codingScreenshot, iso, planCodingSessions } from "../../seed/sources/coding-data";

const MODELS = [
  { model: "claude-sonnet-4-5-20250929", untilDaysAgo: 200, version: "2.0.14" },
  { model: "claude-opus-4-5-20251101", untilDaysAgo: 0, version: "2.1.3" },
] as const;

type Line = Record<string, unknown>;

export const claudeCodeSeed: SeedSource = {
  name: "claude-code",
  produces: { "claude-code": ["claude-code:message:user", "claude-code:message:assistant"] },
  async seed(ctx) {
    const rng = ctx.rng("claude-code");
    const sessions = planCodingSessions(ctx, ctx.rng("claude-code:plan"), {
      fromDaysAgo: 365,
      toDaysAgo: 0,
      sessions: 84,
      exchanges: [2, 6],
      images: 7,
    });
    const projectsDir = join(ctx.stage("claude-code"), "projects");

    for (const [index, session] of sessions.entries()) {
      const sessionId = rng.uuid();
      const modelDef = MODELS.find((m) => session.day.daysAgo >= m.untilDaysAgo) ?? MODELS[MODELS.length - 1];
      if (!modelDef) throw new Error("no Claude Code model");
      const lines: Line[] = [];
      const sidechain: Line[] = [];
      let parentUuid: string | null = null;
      const base = (at: number): Line => ({
        parentUuid,
        isSidechain: false,
        userType: "external",
        cwd: session.project.dir,
        sessionId,
        version: modelDef.version,
        gitBranch: session.branch,
        slug: session.slug,
        timestamp: iso(at),
      });
      const push = (line: Line) => {
        const uuid = rng.uuid();
        lines.push({ ...line, uuid });
        parentUuid = uuid;
      };
      const assistant = (at: number, content: Line[], outputTokens: number) =>
        push({
          ...base(at),
          type: "assistant",
          requestId: `req_011C${rng.hex(18)}`,
          message: {
            id: `msg_01${rng.hex(22)}`,
            type: "message",
            role: "assistant",
            model: modelDef.model,
            content,
            stop_reason: null,
            usage: {
              input_tokens: rng.int(3, 12),
              cache_creation_input_tokens: rng.int(0, 4000),
              cache_read_input_tokens: rng.int(12000, 90000),
              output_tokens: outputTokens,
            },
          },
        });

      // One in eight sessions starts by delegating exploration to a sub-agent.
      const withAgent = index % 8 === 3;

      for (const [exchangeIndex, exchange] of session.exchanges.entries()) {
        const content: unknown = exchange.image
          ? [
              { type: "text", text: exchange.prompt },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: (await codingScreenshot(ctx, rng)).toString("base64") },
              },
            ]
          : exchange.prompt;
        push({ ...base(exchange.promptAt), type: "user", message: { role: "user", content } });

        if (withAgent && exchangeIndex === 0) {
          const agentId = rng.hex(8);
          const toolId = `toolu_01${rng.hex(22)}`;
          const prompt = `Find where "${session.task.grep}" is defined in ${session.project.dir} and summarize how it is used. Report file paths and line numbers.`;
          const at = exchange.promptAt + 4000;
          assistant(at, [{ type: "tool_use", id: toolId, name: "Task", input: { description: "Explore relevant code", prompt, subagent_type: "Explore" } }], rng.int(80, 200));
          const summary = `\`${session.task.grep}\` is defined in \`${session.task.files[0] ?? "src"}\` and called from ${session.task.files.length} places. No other callers.`;
          push({
            ...base(at + 25_000),
            type: "user",
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: [{ type: "text", text: summary }] }] },
            toolUseResult: { agentId, agentType: "Explore", status: "completed" },
          });
          // Sidechain transcript for the sub-agent.
          let sideParent: string | null = null;
          const side = (line: Line) => {
            const uuid = rng.uuid();
            sidechain.push({ parentUuid: sideParent, isSidechain: true, agentId, cwd: session.project.dir, sessionId, version: modelDef.version, gitBranch: session.branch, uuid, ...line });
            sideParent = uuid;
          };
          const grepId = `toolu_01${rng.hex(22)}`;
          side({ type: "user", timestamp: iso(at + 1000), message: { role: "user", content: prompt } });
          side({
            type: "assistant",
            timestamp: iso(at + 6000),
            message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", id: grepId, name: "Grep", input: { pattern: session.task.grep, path: session.project.dir } }] },
          });
          side({
            type: "user",
            timestamp: iso(at + 8000),
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: grepId, content: session.task.files.map((f) => `${session.project.dir}/${f}`).join("\n") }] },
          });
          side({ type: "assistant", timestamp: iso(at + 20_000), message: { role: "assistant", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: summary }] } });
          ctx.writeStaged("claude-code", join("projects", encodeDir(session.project.dir), sessionId, "subagents", `agent-${agentId}.jsonl`), toJsonl(sidechain));
        }

        for (const step of exchange.steps) {
          if (step.thinking) assistant(step.at - 1500, [{ type: "thinking", thinking: step.thinking, signature: `sig_${rng.hex(32)}` }], rng.int(30, 120));
          if (step.text) assistant(step.at, [{ type: "text", text: step.text }], rng.int(10, 60));
          for (const call of step.tools) {
            const id = `toolu_01${rng.hex(22)}`;
            assistant(call.at, [anthropicToolUse(call, id)], rng.int(40, 600));
            const isError = call.kind === "bash" && call.error;
            push({
              ...base(call.doneAt),
              type: "user",
              message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: id, content: call.output, ...(isError ? { is_error: true } : {}) }],
              },
              toolUseResult: call.kind === "bash" ? { stdout: call.output, stderr: "", interrupted: false } : { type: call.kind },
            });
          }
        }
        assistant(exchange.replyAt, [{ type: "text", text: exchange.reply }], rng.int(120, 900));
      }

      ctx.writeStaged("claude-code", join("projects", encodeDir(session.project.dir), `${sessionId}.jsonl`), toJsonl(lines));
    }

    await importClaudeCode(ctx.db, projectsDir, CODING_ACCOUNT);
    ctx.identify("alex", `claude-code:${CODING_ACCOUNT}`);
  },
};

function encodeDir(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

function toJsonl(lines: readonly unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}
