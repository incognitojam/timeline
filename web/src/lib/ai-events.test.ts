import { describe, expect, it } from "vitest";
import {
  aggregateAIMeta,
  buildCliResumeCommand,
  extractAIMeta,
  getParentToolUseId,
  hasRenderableAIContent,
  isAIEventSource,
  parseAIContent,
} from "./ai-events";
import type { TimelineEvent } from "./types";

function makeEvent(overrides: Partial<TimelineEvent> & { raw: unknown }): TimelineEvent {
  const { raw, ...rest } = overrides;
  return {
    id: 1,
    source: "claude-code",
    source_id: "s:m",
    source_account: "default",
    type: "claude-code:message:assistant",
    timestamp: "2026-04-17T10:00:00Z",
    end_timestamp: null,
    duration_ms: null,
    title: "thing",
    content: null,
    latitude: null,
    longitude: null,
    location_name: null,
    people: null,
    tags: null,
    raw_data: JSON.stringify(raw),
    imported_at: "2026-04-17T10:00:00Z",
    import_batch: null,
    conversation_id: null,
    ...rest,
  };
}

describe("isAIEventSource", () => {
  it("recognizes known AI sources", () => {
    expect(isAIEventSource("claude-code")).toBe(true);
    expect(isAIEventSource("amp")).toBe(true);
    expect(isAIEventSource("opencode")).toBe(true);
    expect(isAIEventSource("conductor")).toBe(true);
    expect(isAIEventSource("claude")).toBe(true);
    expect(isAIEventSource("chatgpt")).toBe(true);
  });

  it("rejects other sources", () => {
    expect(isAIEventSource("discord")).toBe(false);
    expect(isAIEventSource("facebook")).toBe(false);
    expect(isAIEventSource("")).toBe(false);
  });
});

describe("parseAIContent", () => {
  it("returns structured blocks from raw_data.content", () => {
    const event = makeEvent({
      raw: {
        content: [
          { type: "text", text: "Hello" },
          { type: "thinking", thinking: "hmm" },
          { type: "tool_use", name: "Bash", id: "t1", input: { command: "ls" } },
        ],
      },
    });
    const blocks = parseAIContent(event);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("text");
    expect(blocks[2].name).toBe("Bash");
  });

  it("preserves non-ContentBlock values as unknown blocks at their position", () => {
    // Positions must not shift: attachment source_id paths index into the raw
    // content array, so unrecognized entries stay in place as type "unknown".
    const event = makeEvent({
      raw: { content: [{ type: "garbage" }, { type: "text", text: "ok" }, "string"] },
    });
    const blocks = parseAIContent(event);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("unknown");
    expect(blocks[1]).toEqual({ type: "text", text: "ok" });
    expect(blocks[2].type).toBe("unknown");
  });

  it("retains amp image and summary blocks", () => {
    const event = makeEvent({
      source: "amp",
      type: "amp:message:assistant",
      raw: {
        content: [
          { type: "image", media_type: "image/png" },
          { type: "summary", summary_type: "message", text: "Recap of the chat." },
          { type: "summary", summary_type: "thread", thread_id: "T-123" },
        ],
      },
    });
    const blocks = parseAIContent(event);
    expect(blocks.map((b) => b.type)).toEqual(["image", "summary", "summary"]);
    expect(blocks[0].media_type).toBe("image/png");
    expect(blocks[1].text).toBe("Recap of the chat.");
    expect(blocks[2].thread_id).toBe("T-123");
  });

  it("falls back to synthesized text block when content is missing", () => {
    const event = makeEvent({ raw: {}, content: "plain text" });
    const blocks = parseAIContent(event);
    expect(blocks).toEqual([{ type: "text", text: "plain text" }]);
  });

  it("returns empty array when no content and no raw_data", () => {
    const event = makeEvent({ raw: {} });
    expect(parseAIContent(event)).toEqual([]);
  });

  it("handles invalid JSON gracefully", () => {
    const event = makeEvent({ raw: {}, raw_data: "not json", content: "fallback" });
    expect(parseAIContent(event)).toEqual([{ type: "text", text: "fallback" }]);
  });
});

describe("extractAIMeta", () => {
  it("extracts claude-code metadata", () => {
    const meta = extractAIMeta(
      makeEvent({
        source: "claude-code",
        raw: {
          session_id: "s1",
          cwd: "/Users/alice/work/project-x",
          git_branch: "main",
          model: "claude-opus-4-5",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
          },
        },
      })
    );
    expect(meta).toMatchObject({
      source: "claude-code",
      sessionId: "s1",
      cwd: "/Users/alice/work/project-x",
      workspace: "project-x",
      gitBranch: "main",
      model: "claude-opus-4-5",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
    });
  });

  it("extracts amp metadata with credits", () => {
    const meta = extractAIMeta(
      makeEvent({
        source: "amp",
        type: "amp:message:assistant",
        raw: {
          thread_id: "t1",
          model: "claude-opus-4-5",
          agent_mode: "normal",
          workspace_roots: ["/Users/alice/repos/widget"],
          usage: { input_tokens: 1, output_tokens: 2, credits: 0.42 },
        },
      })
    );
    expect(meta).toMatchObject({
      source: "amp",
      sessionId: "t1",
      workspace: "widget",
      mode: "normal",
      credits: 0.42,
    });
  });

  it("extracts opencode metadata with cost and tool_usage", () => {
    const meta = extractAIMeta(
      makeEvent({
        source: "opencode",
        type: "opencode:message:assistant",
        raw: {
          session_id: "os1",
          model: "sonnet",
          agent: "build",
          mode: "default",
          finish_reason: "stop",
          cost: 0.01,
          cwd: "/w/app",
          tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } },
          tool_usage: { Read: 3, Bash: 1 },
        },
      })
    );
    expect(meta).toMatchObject({
      sessionId: "os1",
      cost: 0.01,
      finishReason: "stop",
      reasoningTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      toolUsage: { Read: 3, Bash: 1 },
      workspace: "app",
    });
  });

  it("extracts conductor metadata (prefers repo_name for workspace)", () => {
    const meta = extractAIMeta(
      makeEvent({
        source: "conductor",
        type: "conductor:message:assistant",
        raw: {
          session_id: "c1",
          model: "opus",
          agent_type: "claude",
          stop_reason: "end_turn",
          repo_name: "timeline",
          repo_path: "/w/timeline/branch-a",
          workspace_branch: "feat/x",
          workspace_name: "branch-a",
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      })
    );
    expect(meta).toMatchObject({
      workspace: "timeline",
      cwd: "/w/timeline/branch-a",
      gitBranch: "feat/x",
      finishReason: "end_turn",
    });
  });

  it("extracts parent_tool_use_id for conductor sub-agent messages", () => {
    const meta = extractAIMeta(
      makeEvent({
        source: "conductor",
        type: "conductor:message:assistant",
        raw: { session_id: "c2", parent_tool_use_id: "toolu_abc" },
      })
    );
    expect(meta?.parentToolUseId).toBe("toolu_abc");
    expect(meta?.isSidechain).toBe(false);
  });

  it("extracts sidechain fields for claude-code sub-agent messages", () => {
    const meta = extractAIMeta(
      makeEvent({
        source: "claude-code",
        raw: {
          session_id: "s2",
          is_sidechain: true,
          agent_id: "agent-deadbeef",
          parent_tool_use_id: "toolu_xyz",
        },
      })
    );
    expect(meta?.parentToolUseId).toBe("toolu_xyz");
    expect(meta?.isSidechain).toBe(true);
    expect(meta?.agentId).toBe("agent-deadbeef");
  });

  it("leaves sub-agent fields null on non-sub-agent messages", () => {
    const meta = extractAIMeta(
      makeEvent({ source: "claude-code", raw: { session_id: "s3" } })
    );
    expect(meta?.parentToolUseId).toBeNull();
    expect(meta?.isSidechain).toBe(false);
    expect(meta?.agentId).toBeNull();
  });
});

describe("getParentToolUseId", () => {
  it("returns parent_tool_use_id for sub-agent messages", () => {
    expect(
      getParentToolUseId(
        makeEvent({
          source: "conductor",
          raw: { parent_tool_use_id: "toolu_111" },
        })
      )
    ).toBe("toolu_111");
  });

  it("returns null for top-level messages", () => {
    expect(
      getParentToolUseId(makeEvent({ source: "claude-code", raw: { session_id: "s" } }))
    ).toBeNull();
  });

  it("returns null for non-AI sources", () => {
    expect(
      getParentToolUseId(
        makeEvent({ source: "discord", raw: { parent_tool_use_id: "toolu_x" } })
      )
    ).toBeNull();
  });
});

describe("extractAIMeta — claude / fallback cases", () => {
  it("extracts claude conversation_summary and attachment counts", () => {
    const meta = extractAIMeta(
      makeEvent({
        source: "claude",
        type: "claude:message:user",
        raw: {
          conversation_uuid: "uuid-1",
          conversation_summary: "Overview of the chat.",
          attachments: [{ file_name: "a.png" }],
          files: [{ file_name: "b.pdf" }, { file_name: "c.txt" }],
        },
      })
    );
    expect(meta).toMatchObject({
      source: "claude",
      sessionId: "uuid-1",
      conversationSummary: "Overview of the chat.",
      attachmentCount: 3,
    });
  });

  it("returns null for non-AI sources", () => {
    expect(extractAIMeta(makeEvent({ source: "discord", raw: {} }))).toBeNull();
  });

  it("returns skeleton meta for malformed raw_data", () => {
    const event = makeEvent({ raw: {}, raw_data: "broken" });
    expect(extractAIMeta(event)?.source).toBe("claude-code");
    expect(extractAIMeta(event)?.sessionId).toBeNull();
  });
});

describe("aggregateAIMeta", () => {
  it("sums token usage and cost across messages", () => {
    const events = [
      makeEvent({
        id: 1,
        source: "opencode",
        type: "opencode:message:assistant",
        timestamp: "2026-04-17T10:00:00Z",
        raw: { session_id: "a", model: "sonnet", cost: 0.01, tokens: { input: 10, output: 5 } },
      }),
      makeEvent({
        id: 2,
        source: "opencode",
        type: "opencode:message:assistant",
        timestamp: "2026-04-17T10:05:00Z",
        raw: { session_id: "a", model: "sonnet", cost: 0.02, tokens: { input: 20, output: 8 }, tool_usage: { Bash: 2 } },
      }),
    ];
    const agg = aggregateAIMeta("opencode", events);
    expect(agg.messageCount).toBe(2);
    expect(agg.totalInputTokens).toBe(30);
    expect(agg.totalOutputTokens).toBe(13);
    expect(agg.totalCost).toBeCloseTo(0.03);
    expect(agg.sessionIds).toEqual(["a"]);
    expect(agg.models).toEqual([{ model: "sonnet", count: 2 }]);
    expect(agg.toolUsage).toEqual({ Bash: 2 });
    expect(agg.firstTimestamp).toBe("2026-04-17T10:00:00Z");
    expect(agg.lastTimestamp).toBe("2026-04-17T10:05:00Z");
  });

  it("picks the first non-null scalar field across messages", () => {
    const events = [
      makeEvent({ id: 1, source: "claude-code", raw: {} }),
      makeEvent({
        id: 2,
        source: "claude-code",
        raw: { cwd: "/path/proj", git_branch: "main" },
      }),
    ];
    const agg = aggregateAIMeta("claude-code", events);
    expect(agg.workspace).toBe("proj");
    expect(agg.gitBranch).toBe("main");
  });

  it("aggregates claude conversation_summary and attachment totals", () => {
    const events = [
      makeEvent({
        id: 1,
        source: "claude",
        type: "claude:message:user",
        raw: {
          conversation_uuid: "u",
          conversation_summary: "Summary text.",
          attachments: [{ file_name: "a.png" }],
          files: [],
        },
      }),
      makeEvent({
        id: 2,
        source: "claude",
        type: "claude:message:assistant",
        raw: { conversation_uuid: "u", conversation_summary: "Summary text." },
      }),
      makeEvent({
        id: 3,
        source: "claude",
        type: "claude:message:user",
        raw: {
          conversation_uuid: "u",
          files: [{ file_name: "b.pdf" }, { file_name: "c.md" }],
        },
      }),
    ];
    const agg = aggregateAIMeta("claude", events);
    expect(agg.conversationSummary).toBe("Summary text.");
    expect(agg.totalAttachments).toBe(3);
    expect(agg.messagesWithAttachments).toBe(2);
  });
});

describe("hasRenderableAIContent", () => {
  it("hides a user message whose only content is a tool_result that has a match", () => {
    const event = makeEvent({
      source: "claude-code",
      type: "claude-code:message:user",
      raw: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    });
    const resolve = (id: string) =>
      id === "t1" ? { type: "tool_result" as const, tool_use_id: "t1" } : undefined;
    expect(hasRenderableAIContent(event, resolve)).toBe(false);
  });

  it("keeps an orphan tool_result", () => {
    const event = makeEvent({
      source: "claude-code",
      type: "claude-code:message:user",
      raw: { content: [{ type: "tool_result", tool_use_id: "missing", content: "ok" }] },
    });
    expect(hasRenderableAIContent(event, () => undefined)).toBe(true);
  });

  it("keeps messages with text/thinking/tool_use regardless of resolver", () => {
    const event = makeEvent({
      source: "claude-code",
      raw: { content: [{ type: "text", text: "hi" }] },
    });
    expect(hasRenderableAIContent(event)).toBe(true);
  });

  it("hides messages with no blocks at all", () => {
    expect(hasRenderableAIContent(makeEvent({ source: "claude-code", raw: {} }))).toBe(false);
  });

  it("keeps a redacted thinking block (empty thinking renders as an indicator)", () => {
    const event = makeEvent({
      source: "claude-code",
      raw: { content: [{ type: "thinking", thinking: "", signature: "abc" }] },
    });
    expect(hasRenderableAIContent(event)).toBe(true);
  });

  it("hides a message whose only block is empty text", () => {
    const event = makeEvent({
      source: "claude-code",
      raw: { content: [{ type: "text", text: "" }] },
    });
    expect(hasRenderableAIContent(event)).toBe(false);
  });

  it("keeps an amp summary-only message with text", () => {
    const event = makeEvent({
      source: "amp",
      type: "amp:message:assistant",
      raw: { content: [{ type: "summary", summary_type: "message", text: "Recap." }] },
    });
    expect(hasRenderableAIContent(event)).toBe(true);
  });

  it("keeps an amp thread-summary message with only a thread id", () => {
    const event = makeEvent({
      source: "amp",
      type: "amp:message:assistant",
      raw: { content: [{ type: "summary", summary_type: "thread", thread_id: "T-123" }] },
    });
    expect(hasRenderableAIContent(event)).toBe(true);
  });

  it("hides an amp summary with neither text nor thread id", () => {
    const event = makeEvent({
      source: "amp",
      type: "amp:message:assistant",
      raw: { content: [{ type: "summary", summary_type: "message" }] },
    });
    expect(hasRenderableAIContent(event)).toBe(false);
  });

  it("keeps an amp image-only message", () => {
    const event = makeEvent({
      source: "amp",
      type: "amp:message:user",
      raw: { content: [{ type: "image", media_type: "image/png" }] },
    });
    expect(hasRenderableAIContent(event)).toBe(true);
  });

  it("returns true for non-AI sources unconditionally", () => {
    expect(hasRenderableAIContent(makeEvent({ source: "discord", raw: {} }))).toBe(true);
  });
});

describe("buildCliResumeCommand", () => {
  it("returns CLI command for claude-code", () => {
    const agg = aggregateAIMeta("claude-code", [
      makeEvent({ source: "claude-code", raw: { session_id: "abc123" } }),
    ]);
    expect(buildCliResumeCommand(agg)).toEqual({
      label: "Resume in CLI",
      command: "claude --resume abc123",
      kind: "cli",
    });
  });

  it("returns CLI command for amp", () => {
    const agg = aggregateAIMeta("amp", [
      makeEvent({ source: "amp", type: "amp:message:user", raw: { thread_id: "t42" } }),
    ]);
    expect(buildCliResumeCommand(agg)?.command).toBe("amp threads continue t42");
  });

  it("returns web URL for claude", () => {
    const agg = aggregateAIMeta("claude", [
      makeEvent({ source: "claude", type: "claude:message:user", raw: { conversation_uuid: "uuid-1" } }),
    ]);
    expect(buildCliResumeCommand(agg)).toMatchObject({
      kind: "url",
      command: "https://claude.ai/chat/uuid-1",
    });
  });

  it("returns null for opencode and conductor", () => {
    const op = aggregateAIMeta("opencode", [
      makeEvent({ source: "opencode", type: "opencode:message:assistant", raw: { session_id: "x" } }),
    ]);
    expect(buildCliResumeCommand(op)).toBeNull();

    const co = aggregateAIMeta("conductor", [
      makeEvent({ source: "conductor", type: "conductor:message:assistant", raw: { session_id: "y" } }),
    ]);
    expect(buildCliResumeCommand(co)).toBeNull();
  });

  it("returns null when no session id is available", () => {
    const agg = aggregateAIMeta("claude-code", [makeEvent({ raw: {} })]);
    expect(buildCliResumeCommand(agg)).toBeNull();
  });
});
