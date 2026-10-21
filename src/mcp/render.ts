import type { McpSessionRow, McpSessionStats, McpSessionSummary, McpToolCallRow } from "./recording";

export const DEFAULT_MCP_ARGS_EXCERPT_CHARS = 800;
export const DEFAULT_MCP_RESULT_EXCERPT_CHARS = 2000;

export interface RenderMcpExcerptOptions {
  argsExcerptChars?: number;
  resultExcerptChars?: number;
}

export interface McpCallSearchFilter {
  sessionId?: string;
  toolName?: string;
  errorsOnly?: boolean;
  since?: string;
  limit: number;
  offset: number;
}

interface RenderCallOptions extends RenderMcpExcerptOptions {
  includeSessionId?: boolean;
  ordinal?: number;
}

interface PreparedBody {
  text: string;
  language: string;
}

export function renderMcpSessionListMarkdown(sessions: McpSessionSummary[]): string {
  const lines = ["# MCP sessions", ""];
  if (sessions.length === 0) {
    lines.push("No MCP sessions found.");
    return lines.join("\n");
  }

  for (const session of sessions) {
    lines.push(
      [
        `- \`${session.id}\``,
        `[${session.transport}]`,
        `client: ${formatClient(session.client_name, session.client_version)}`,
        `calls: ${session.call_count}`,
        `errors: ${session.error_count}`,
        `last activity: ${session.last_activity_at}`,
        `last call: ${session.last_call_at ?? "none"}`,
      ].join(" | "),
    );
  }

  return lines.join("\n");
}

export function renderMcpSessionMarkdown(
  session: McpSessionRow,
  calls: McpToolCallRow[],
  stats: McpSessionStats,
  opts: RenderMcpExcerptOptions = {},
): string {
  const lines = [
    `# MCP session \`${session.id}\``,
    "",
    `- Transport: ${session.transport}`,
    `- Client: ${formatClient(session.client_name, session.client_version)}`,
    `- Token hash: ${session.token_hash ?? "none"}`,
    `- Created: ${session.created_at}`,
    `- Last activity: ${session.last_activity_at}`,
    `- Calls: ${stats.call_count}`,
    `- Errors: ${stats.error_count}`,
    `- Average duration: ${formatAverageDuration(stats.avg_duration_ms)}`,
    "",
    "## Tool calls",
    "",
  ];

  if (calls.length === 0) {
    lines.push("No tool calls recorded for this session.");
    return lines.join("\n");
  }

  calls.forEach((call, index) => {
    lines.push(renderCall(call, { ...opts, ordinal: index + 1 }));
  });

  return lines.join("\n\n");
}

export function renderMcpCallSearchMarkdown(
  calls: McpToolCallRow[],
  filter: McpCallSearchFilter,
  opts: RenderMcpExcerptOptions = {},
): string {
  const lines = [
    "# MCP tool call search",
    "",
    `- Session: ${filter.sessionId ?? "any"}`,
    `- Tool: ${filter.toolName ?? "any"}`,
    `- Errors only: ${filter.errorsOnly === true ? "yes" : "no"}`,
    `- Since: ${filter.since ?? "any"}`,
    `- Limit: ${filter.limit}`,
    `- Offset: ${filter.offset}`,
    `- Calls returned: ${calls.length}`,
    "",
    "## Tool calls",
    "",
  ];

  if (calls.length === 0) {
    lines.push("No matching tool calls found.");
    return lines.join("\n");
  }

  calls.forEach((call, index) => {
    lines.push(renderCall(call, { ...opts, includeSessionId: true, ordinal: index + 1 }));
  });

  return lines.join("\n\n");
}

function renderCall(call: McpToolCallRow, opts: RenderCallOptions): string {
  const flags = [
    call.is_error ? "error" : null,
    call.truncated ? "truncated" : null,
  ].filter((flag): flag is string => flag !== null);

  const lines = [
    `### ${opts.ordinal ?? call.id}. \`${call.tool_name}\``,
    "",
  ];
  if (opts.includeSessionId) {
    lines.push(`- Session: \`${call.session_id}\``);
  }
  lines.push(
    `- Call ID: ${call.id}`,
    `- Created: ${call.created_at}`,
    `- Duration: ${call.duration_ms}ms`,
    `- Status: ${call.is_error ? "error" : "ok"}`,
    `- Flags: ${flags.length > 0 ? flags.join(", ") : "none"}`,
    `- Argument chars: ${call.args_chars}`,
    `- Result chars: ${call.result_chars}`,
    "",
    renderBodySection(
      "Arguments",
      call.args_json,
      call.args_chars,
      opts.argsExcerptChars ?? DEFAULT_MCP_ARGS_EXCERPT_CHARS,
      prepareArgsBody,
    ),
    "",
    renderBodySection(
      "Result",
      call.result_text,
      call.result_chars,
      opts.resultExcerptChars ?? DEFAULT_MCP_RESULT_EXCERPT_CHARS,
      (text) => ({ text, language: "text" }),
    ),
  );

  return lines.join("\n");
}

function renderBodySection(
  title: string,
  raw: string | null,
  trueChars: number,
  cap: number,
  prepare: (text: string) => PreparedBody,
): string {
  if (raw === null) {
    return `#### ${title}\n\n(no ${title.toLowerCase()} text)`;
  }

  const prepared = prepare(raw);
  const excerpt = excerptBody(prepared.text, raw, trueChars, cap);
  const lines = [
    `#### ${title}`,
    "",
    fencedBlock(excerpt.text, prepared.language),
  ];
  if (excerpt.note) {
    lines.push("", excerpt.note);
  }
  return lines.join("\n");
}

function prepareArgsBody(raw: string): PreparedBody {
  try {
    const formatted = JSON.stringify(JSON.parse(raw), null, 2);
    return { text: formatted ?? raw, language: "json" };
  } catch {
    return { text: raw, language: "text" };
  }
}

function excerptBody(
  text: string,
  raw: string,
  trueChars: number,
  cap: number,
): { text: string; note: string | null } {
  const limit = Math.max(1, Math.floor(cap));
  const visible = text.length > limit ? text.slice(0, limit) : text;
  const storedChars = Math.max(0, trueChars);
  const renderedChars = text.length;
  const visibleRenderedChars = Math.min(renderedChars, limit);
  const needsNote = renderedChars > limit || raw.length < storedChars;
  const storageNote = raw.length < storedChars
    ? `; stored text contains ${raw.length} chars`
    : "";
  return {
    text: visible,
    note: needsNote
      ? `... showing ${visibleRenderedChars} of ${renderedChars} rendered chars; recorded source size: ${storedChars} chars${storageNote}`
      : null,
  };
}

function fencedBlock(body: string, language: string): string {
  const fence = "`".repeat(Math.max(3, maxBacktickRun(body) + 1));
  return `${fence}${language}\n${body}\n${fence}`;
}

function maxBacktickRun(value: string): number {
  let max = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function formatClient(name: string | null, version: string | null): string {
  if (!name && !version) return "Unknown client";
  if (!name) return version ?? "Unknown client";
  return version ? `${name} ${version}` : name;
}

function formatAverageDuration(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)}ms`;
}
