import { describe, expect, test } from "bun:test";
import type { McpSessionRow, McpSessionStats, McpSessionSummary, McpToolCallRow } from "./recording";
import { renderMcpCallSearchMarkdown, renderMcpSessionListMarkdown, renderMcpSessionMarkdown } from "./render";

function session(overrides: Partial<McpSessionRow> = {}): McpSessionRow {
  return {
    id: "session-1",
    transport: "http",
    client_name: "Test Client",
    client_version: "1.0.0",
    token_hash: "abc123def4567890",
    created_at: "2026-07-03 10:00:00",
    last_activity_at: "2026-07-03 10:01:00",
    ...overrides,
  };
}

function stats(overrides: Partial<McpSessionStats> = {}): McpSessionStats {
  return {
    call_count: 1,
    error_count: 0,
    avg_duration_ms: 12,
    ...overrides,
  };
}

function call(overrides: Partial<McpToolCallRow> = {}): McpToolCallRow {
  return {
    id: 1,
    session_id: "session-1",
    tool_name: "query_events",
    args_json: "{\"query\":\"coffee\"}",
    args_chars: 18,
    result_text: "No events found.",
    result_chars: 16,
    is_error: 0,
    truncated: 0,
    duration_ms: 12,
    created_at: "2026-07-03 10:01:00",
    ...overrides,
  };
}

describe("MCP markdown renderer", () => {
  test("renders session header fields and pretty-printed arguments", () => {
    const markdown = renderMcpSessionMarkdown(session(), [call()], stats());

    expect(markdown).toContain("# MCP session `session-1`");
    expect(markdown).toContain("- Transport: http");
    expect(markdown).toContain("- Client: Test Client 1.0.0");
    expect(markdown).toContain("- Token hash: abc123def4567890");
    expect(markdown).toContain("- Calls: 1");
    expect(markdown).toContain("- Average duration: 12ms");
    expect(markdown).toContain("### 1. `query_events`");
    expect(markdown).toContain("- Flags: none");
    expect(markdown).toContain("{\n  \"query\": \"coffee\"\n}");
  });

  test("renders per-call error and truncation flags with excerpt notes", () => {
    const markdown = renderMcpSessionMarkdown(
      session(),
      [call({
        result_text: "abcdefghijklmnopqrstuvwxyz",
        result_chars: 26,
        is_error: 1,
        truncated: 1,
      })],
      stats({ error_count: 1 }),
      { resultExcerptChars: 10 },
    );

    expect(markdown).toContain("- Status: error");
    expect(markdown).toContain("- Flags: error, truncated");
    expect(markdown).toContain("abcdefghij");
    expect(markdown).toContain("... showing 10 of 26 rendered chars; recorded source size: 26 chars");
  });

  test("reports pretty-printed argument truncation against rendered chars and source size", () => {
    const args = {
      items: Array.from({ length: 18 }, (_, index) => ({
        i: index,
        a: "x",
        b: "y",
        c: "z",
      })),
    };
    const raw = JSON.stringify(args);
    const pretty = JSON.stringify(args, null, 2);
    expect(raw.length).toBeLessThan(800);
    expect(pretty.length).toBeGreaterThan(800);

    const markdown = renderMcpSessionMarkdown(
      session(),
      [call({ args_json: raw, args_chars: raw.length })],
      stats(),
      { argsExcerptChars: 800 },
    );

    expect(markdown).toContain(
      `... showing 800 of ${pretty.length} rendered chars; recorded source size: ${raw.length} chars`,
    );
    expect(markdown).not.toContain(`... showing 800 of ${raw.length} chars`);
  });

  test("handles null results and unparseable argument JSON", () => {
    const markdown = renderMcpSessionMarkdown(
      session(),
      [call({
        args_json: "{not-json",
        args_chars: 9,
        result_text: null,
        result_chars: 0,
      })],
      stats(),
    );

    expect(markdown).toContain("```text\n{not-json\n```");
    expect(markdown).toContain("#### Result\n\n(no result text)");
  });

  test("uses longer fences when a body contains markdown fences", () => {
    const markdown = renderMcpSessionMarkdown(
      session(),
      [call({ result_text: "before ``` inside", result_chars: 17 })],
      stats(),
    );

    expect(markdown).toContain("````text\nbefore ``` inside\n````");
  });

  test("renders session lists and cross-session search results", () => {
    const summary: McpSessionSummary = {
      ...session({ id: "session-2", transport: "stdio", client_version: null, token_hash: null }),
      call_count: 3,
      error_count: 1,
      last_call_at: "2026-07-03 10:02:00",
    };

    const listMarkdown = renderMcpSessionListMarkdown([summary]);
    expect(listMarkdown).toContain("`session-2` | [stdio] | client: Test Client");
    expect(listMarkdown).toContain("calls: 3");
    expect(listMarkdown).toContain("errors: 1");

    const searchMarkdown = renderMcpCallSearchMarkdown(
      [call({ session_id: "session-2" })],
      {
        sessionId: "session-2",
        toolName: "query_events",
        errorsOnly: true,
        since: "2026-07-03T10:00:00Z",
        limit: 10,
        offset: 5,
      },
    );
    expect(searchMarkdown).toContain("# MCP tool call search");
    expect(searchMarkdown).toContain("- Session: session-2");
    expect(searchMarkdown).toContain("- Errors only: yes");
    expect(searchMarkdown).toContain("- Session: `session-2`");
  });
});
