import { importCodex } from "../../parsers/codex";
import type { SeedSource } from "../context";
import type { Rng } from "../rng";
import { CODING_ACCOUNT, type CodingSession, codingScreenshot, iso, planCodingSessions, type ToolCall } from "./coding-data";

const MODELS = [
  { model: "gpt-5-codex", fromDaysAgo: 420, cli: "0.46.0" },
  { model: "gpt-5.1-codex", fromDaysAgo: 330, cli: "0.63.0" },
] as const;

type Line = { timestamp: string; type: string; payload: Record<string, unknown> };

function shellOutput(call: Extract<ToolCall, { kind: "bash" | "read" | "grep" }>, rng: Rng): string {
  const code = call.kind === "bash" && call.error ? 1 : 0;
  return `Chunk ID: ${rng.hex(6)}\nWall time: ${((call.doneAt - call.at) / 1000).toFixed(4)} seconds\nProcess exited with code ${code}\nOriginal token count: ${Math.ceil(call.output.length / 4)}\nOutput:\n${call.output}`;
}

function shellCommand(call: Extract<ToolCall, { kind: "bash" | "read" | "grep" }>): string {
  if (call.kind === "read") return `sed -n '1,220p' ${call.path}`;
  if (call.kind === "grep") return `rg -n "${call.pattern.replaceAll('"', '\\"')}" ${call.path}`;
  return call.command;
}

function patch(call: Extract<ToolCall, { kind: "edit" | "write" }>): string {
  if (call.kind === "write") {
    return `*** Begin Patch\n*** Add File: ${call.path}\n${call.content.trimEnd().split("\n").map((l) => `+${l}`).join("\n")}\n*** End Patch`;
  }
  const minus = call.oldText.split("\n").map((l) => `-${l}`).join("\n");
  const plus = call.newText.split("\n").map((l) => `+${l}`).join("\n");
  return `*** Begin Patch\n*** Update File: ${call.path}\n@@\n${minus}\n${plus}\n*** End Patch`;
}

async function rollout(session: CodingSession, sessionId: string, ctx: Parameters<SeedSource["seed"]>[0], rng: Rng): Promise<Line[]> {
  const modelDef = [...MODELS].reverse().find((m) => session.day.daysAgo <= m.fromDaysAgo) ?? MODELS[0];
  const lines: Line[] = [];
  const add = (at: number, type: string, payload: Record<string, unknown>) => lines.push({ timestamp: iso(at), type, payload });
  const cwd = session.project.dir;

  add(session.start, "session_meta", {
    id: sessionId,
    timestamp: iso(session.start),
    cwd,
    originator: "codex_cli_rs",
    cli_version: modelDef.cli,
    instructions: null,
    source: "cli",
    model_provider: "openai",
    git: { commit_hash: rng.hex(40), branch: session.branch, repository_url: `https://github.com/${session.project.repo}.git` },
  });

  const usage = () => {
    const last = { input_tokens: rng.int(6000, 40000), cached_input_tokens: rng.int(2000, 30000), output_tokens: rng.int(80, 1500), reasoning_output_tokens: rng.int(0, 600) };
    return { type: "token_count", info: { last_token_usage: { ...last, total_tokens: last.input_tokens + last.output_tokens } }, rate_limits: null };
  };

  for (const exchange of session.exchanges) {
    add(exchange.promptAt, "turn_context", {
      cwd,
      approval_policy: "on-request",
      sandbox_policy: { mode: "workspace-write", network_access: false },
      model: modelDef.model,
      effort: "medium",
      summary: "auto",
    });
    add(exchange.promptAt, "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>zsh</shell>\n</environment_context>` }, { type: "input_text", text: exchange.prompt }],
    });
    const images = exchange.image ? [`data:image/png;base64,${(await codingScreenshot(ctx, rng)).toString("base64")}`] : [];
    add(exchange.promptAt, "event_msg", { type: "user_message", message: exchange.prompt, images, kind: "plain" });

    for (const step of exchange.steps) {
      if (step.thinking) {
        add(step.at - 1200, "response_item", {
          type: "reasoning",
          summary: [{ type: "summary_text", text: `**Planning the change**\n\n${step.thinking}` }],
          content: null,
          encrypted_content: `gAAAAB${rng.hex(48)}`,
        });
      }
      if (step.text) {
        add(step.at, "event_msg", { type: "agent_message", message: step.text });
        add(step.at, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: step.text }] });
      }
      for (const call of step.tools) {
        const callId = `call_${rng.hex(24)}`;
        if (call.kind === "edit" || call.kind === "write") {
          add(call.at, "response_item", { type: "custom_tool_call", status: "completed", call_id: callId, name: "apply_patch", input: patch(call) });
          add(call.doneAt, "response_item", {
            type: "custom_tool_call_output",
            call_id: callId,
            output: JSON.stringify({ output: `Success. Updated the following files:\n${call.kind === "write" ? "A" : "M"} ${call.path}\n`, metadata: { exit_code: 0, duration_seconds: 0.1 } }),
          });
        } else {
          add(call.at, "response_item", { type: "function_call", name: "shell_command", arguments: JSON.stringify({ command: shellCommand(call), workdir: cwd, timeout_ms: 120000 }), call_id: callId });
          add(call.doneAt, "response_item", { type: "function_call_output", call_id: callId, output: shellOutput(call, rng) });
        }
        add(call.doneAt, "event_msg", usage());
      }
    }
    add(exchange.replyAt, "event_msg", usage());
    add(exchange.replyAt, "event_msg", { type: "agent_message", message: exchange.reply });
    add(exchange.replyAt, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: exchange.reply }] });
  }
  return lines;
}

export const codexSeed: SeedSource = {
  name: "codex",
  produces: { codex: ["codex:message:user", "codex:message:assistant"] },
  async seed(ctx) {
    const rng = ctx.rng("codex");
    const sessions = planCodingSessions(ctx, ctx.rng("codex:plan"), {
      fromDaysAgo: 420,
      toDaysAgo: 0,
      sessions: 42,
      exchanges: [2, 5],
      images: 4,
    });
    for (const session of sessions) {
      const sessionId = rng.uuid();
      const lines = await rollout(session, sessionId, ctx, rng);
      // Codex names rollouts by local start time.
      const local = new Date(session.start + offsetMs(ctx.localOffset(new Date(session.start))));
      const stamp = local.toISOString().slice(0, 19).replaceAll(":", "-");
      const [y, m, d] = stamp.slice(0, 10).split("-");
      ctx.writeStaged("codex", `sessions/${y}/${m}/${d}/rollout-${stamp}-${sessionId}.jsonl`, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    }
    await importCodex(ctx.db, `${ctx.stage("codex")}/sessions`, CODING_ACCOUNT);
    ctx.identify("alex", `codex:${CODING_ACCOUNT}`);
  },
};

function offsetMs(offset: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match) throw new Error(`Bad offset ${offset}`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return (match[1] === "-" ? -1 : 1) * minutes * 60_000;
}
