import { fireEvent, render } from "@solidjs/testing-library";
import type { ParentProps } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpSessionDetail } from "../lib/api";
import { useMcpSession } from "../lib/queries";
import McpSessionDetailView from "./McpSessionDetailView";

vi.mock("@solidjs/router", () => ({
  useParams: () => ({ id: "session-1" }),
  A: (props: ParentProps<{ href: string; class?: string; title?: string }>) => (
    <a href={props.href} class={props.class} title={props.title}>
      {props.children}
    </a>
  ),
}));

vi.mock("../lib/queries", () => ({
  useMcpSession: vi.fn(),
}));

const mockUseMcpSession = vi.mocked(useMcpSession);

function detailResponse(): McpSessionDetail {
  return {
    session: {
      id: "session-1",
      transport: "http",
      client_name: "Test Client",
      client_version: "1.0.0",
      token_hash: "abc123def4567890",
      created_at: "2026-07-03 10:00:00",
      last_activity_at: "2026-07-03 10:01:00",
    },
    calls: [
      {
        id: 1,
        session_id: "session-1",
        tool_name: "query_events",
        args_json: "{\"query\":\"coffee\"}",
        args_chars: 18,
        result_text: "No events found.",
        result_chars: 48,
        is_error: 0,
        truncated: 0,
        duration_ms: 123,
        created_at: "2026-07-03 10:01:00",
      },
      {
        id: 2,
        session_id: "session-1",
        tool_name: "run_sql",
        args_json: "{\"sql\":\"SELECT * FROM missing\"}",
        args_chars: 31,
        result_text: "Error: no such table: missing",
        result_chars: 28,
        is_error: 1,
        truncated: 0,
        duration_ms: 40,
        created_at: "2026-07-03 10:00:30",
      },
    ],
    count: 5,
    stats: {
      call_count: 5,
      error_count: 1,
      avg_duration_ms: 80,
    },
  };
}

describe("McpSessionDetailView", () => {
  beforeEach(() => {
    mockUseMcpSession.mockReturnValue({
      data: detailResponse(),
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useMcpSession>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders call summaries and expands args and result text", () => {
    const { getByText, queryByText } = render(() => <McpSessionDetailView />);

    expect(getByText("query_events")).toBeInTheDocument();
    expect(getByText("123ms")).toBeInTheDocument();
    expect(getByText(/48 chars/)).toBeInTheDocument();
    expect(getByText(/~12 tokens/)).toBeInTheDocument();
    expect(getByText("Error")).toBeInTheDocument();
    expect(getByText("Showing latest 2 of 5 calls.")).toBeInTheDocument();
    expect(getByText("Open .md")).toHaveAttribute("href", "/api/mcp/sessions/session-1.md");
    expect(queryByText(/coffee/)).toBeNull();

    fireEvent.click(getByText("query_events"));

    expect(getByText(/"query": "coffee"/)).toBeInTheDocument();
    expect(getByText("No events found.")).toBeInTheDocument();
  });
});
