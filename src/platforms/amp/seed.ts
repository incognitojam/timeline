import { importAmp } from "./parser";
import type { SeedSource } from "../../seed/context";
import { CODING_ACCOUNT, planCodingSessions, type ToolCall } from "../../seed/sources/coding-data";

const MODEL = "claude-sonnet-4-5-20250929";

function toolUse(call: ToolCall, id: string): Record<string, unknown> {
  switch (call.kind) {
    case "read":
      return { type: "tool_use", id, name: "Read", input: { path: call.path } };
    case "grep":
      return { type: "tool_use", id, name: "Grep", input: { pattern: call.pattern, path: call.path } };
    case "edit":
      return { type: "tool_use", id, name: "edit_file", input: { path: call.path, old_str: call.oldText, new_str: call.newText } };
    case "write":
      return { type: "tool_use", id, name: "create_file", input: { path: call.path, content: call.content } };
    case "bash":
      return { type: "tool_use", id, name: "Bash", input: { cmd: call.command } };
  }
}

function toolResult(call: ToolCall, id: string): Record<string, unknown> {
  if (call.kind === "bash") {
    return call.error
      ? { type: "tool_result", toolUseID: id, run: { status: "error", error: { message: call.output } } }
      : { type: "tool_result", toolUseID: id, run: { status: "done", result: { output: call.output, exitCode: 0 } } };
  }
  if (call.kind === "edit") {
    return {
      type: "tool_result",
      toolUseID: id,
      run: { status: "done", result: { diff: `--- a\n+++ b\n-${call.oldText.split("\n")[0]}\n+${call.newText.split("\n")[0]}` } },
    };
  }
  return { type: "tool_result", toolUseID: id, run: { status: "done", result: call.output } };
}

export const ampSeed: SeedSource = {
  name: "amp",
  produces: { amp: ["amp:message:user", "amp:message:assistant"] },
  async seed(ctx) {
    const rng = ctx.rng("amp");
    const sessions = planCodingSessions(ctx, ctx.rng("amp:plan"), {
      fromDaysAgo: 600,
      toDaysAgo: 120,
      sessions: 25,
      exchanges: [2, 4],
    });

    for (const session of sessions) {
      const id = `T-${rng.uuid()}`;
      const messages: Record<string, unknown>[] = [];
      let messageId = 0;
      const assistant = (at: number, content: Record<string, unknown>[], stopReason: string) =>
        messages.push({
          role: "assistant",
          messageId: messageId++,
          content,
          state: { type: "complete", stopReason },
          usage: {
            model: MODEL,
            inputTokens: rng.int(4, 40),
            outputTokens: rng.int(60, 900),
            cacheReadInputTokens: rng.int(8000, 60000),
            totalInputTokens: rng.int(10000, 70000),
            timestamp: new Date(at).toISOString(),
          },
        });

      for (const exchange of session.exchanges) {
        messages.push({
          role: "user",
          messageId: messageId++,
          content: [{ type: "text", text: exchange.prompt }],
          meta: { sentAt: exchange.promptAt },
          agentMode: "smart",
          userState: { currentlyVisibleFiles: session.task.files.slice(0, 1).map((f) => `${session.project.dir}/${f}`) },
        });
        for (const step of exchange.steps) {
          const ids = step.tools.map(() => `toolu_vrtx_01${rng.hex(20)}`);
          const content: Record<string, unknown>[] = [];
          if (step.thinking) content.push({ type: "thinking", thinking: step.thinking });
          if (step.text) content.push({ type: "text", text: step.text });
          step.tools.forEach((call, i) => content.push(toolUse(call, ids[i] ?? "")));
          if (content.length === 0) continue;
          assistant(step.at, content, step.tools.length > 0 ? "tool_use" : "end_turn");
          if (step.tools.length > 0) {
            messages.push({
              role: "user",
              messageId: messageId++,
              content: step.tools.map((call, i) => toolResult(call, ids[i] ?? "")),
              meta: { sentAt: Math.max(...step.tools.map((t) => t.doneAt)) },
            });
          }
        }
        assistant(exchange.replyAt, [{ type: "text", text: exchange.reply }], "end_turn");
      }

      const root = `file://${session.project.dir}`;
      ctx.writeStaged(
        "amp",
        `threads/${id}.json`,
        JSON.stringify({
          v: messages.length + 3,
          id,
          created: session.start,
          title: session.task.title,
          messages,
          workspaceRoots: [root],
          env: { initial: { trees: [{ displayName: session.project.name, uri: root }] } },
          agentMode: "smart",
          nextMessageId: messageId,
        }),
      );
    }

    await importAmp(ctx.db, `${ctx.stage("amp")}/threads`, CODING_ACCOUNT);
    ctx.identify("alex", `amp:${CODING_ACCOUNT}`);
  },
};
