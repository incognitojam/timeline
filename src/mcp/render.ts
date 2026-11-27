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
  /** For an agent: leave out what a call returned and what a note save wrote. */
  forAgent?: boolean;
  ordinal?: number;
}

/**
 * The arguments of each tool that saves memory which carry what it saved. Like a
 * result, that may belong to a note or contact the tools now keep from agents
 * (hidden since, or deleted), so an agent sees the save without it.
 * remember_contact_fact is gone, but its calls stay recorded for a while.
 */
const SAVED_CONTENT_ARGS: Record<string, string[]> = {
  save_memory_note: ["title", "summary", "details"],
  remember_contact_fact: ["fact"],
};

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

/** A session's heading and facts: transport, client, token, times and call stats. */
export function renderMcpSessionHeader(session: McpSessionRow, stats: McpSessionStats): string[] {
  return [
    `# MCP session \`${session.id}\``,
    "",
    `- Transport: ${session.transport}`,
    `- Client: ${formatClient(session.client_name, session.client_version)}`,
    // Never the hash: an MCP_TOKENS value may be weak, and a read-only client reads this.
    `- Token: ${session.token_label ?? (session.token_hash ? "MCP_TOKENS" : "none")}`,
    `- Created: ${session.created_at}`,
    `- Last activity: ${session.last_activity_at}`,
    `- Calls: ${stats.call_count}`,
    `- Errors: ${stats.error_count}`,
    `- Average duration: ${formatAverageDuration(stats.avg_duration_ms)}`,
  ];
}

export function renderMcpSessionMarkdown(
  session: McpSessionRow,
  calls: McpToolCallRow[],
  stats: McpSessionStats,
  opts: RenderMcpExcerptOptions = {},
): string {
  const lines = [...renderMcpSessionHeader(session, stats), "", "## Tool calls", ""];

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
  opts: Pick<RenderMcpExcerptOptions, "argsExcerptChars"> = {},
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
    lines.push(renderCall(call, { ...opts, forAgent: true, ordinal: index + 1 }));
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
  if (opts.forAgent) {
    lines.push(`- Session: \`${call.session_id}\``);
  }
  const savedContent = opts.forAgent ? SAVED_CONTENT_ARGS[call.tool_name] : undefined;
  const args = savedContent ? withoutArgs(call.args_json, savedContent) : call.args_json;
  lines.push(
    `- Call ID: ${call.id}`,
    `- Created: ${call.created_at}`,
    `- Duration: ${call.duration_ms}ms`,
    `- Status: ${call.is_error ? "error" : "ok"}`,
    `- Flags: ${flags.length > 0 ? flags.join(", ") : "none"}`,
    `- Argument chars: ${call.args_chars}`,
    // A result's size could tell an agent that a contact hidden since was there.
    ...(opts.forAgent ? [] : [`- Result chars: ${call.result_chars}`]),
    "",
    renderBodySection(
      "Arguments",
      args,
      args === call.args_json ? call.args_chars : (args?.length ?? 0),
      opts.argsExcerptChars ?? DEFAULT_MCP_ARGS_EXCERPT_CHARS,
      prepareArgsBody,
    ),
  );
  // What a call returned may show what the tools now leave out, such as a contact hidden since.
  if (!opts.forAgent) {
    lines.push(
      "",
      renderBodySection(
        "Result",
        call.result_text,
        call.result_chars,
        opts.resultExcerptChars ?? DEFAULT_MCP_RESULT_EXCERPT_CHARS,
        (text) => ({ text, language: "text" }),
      ),
    );
  }

  return lines.join("\n");
}

function withoutArgs(raw: string | null, keys: string[]): string | null {
  if (raw === null) return null;
  try {
    const args: unknown = JSON.parse(raw);
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    return JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => !keys.includes(key))));
  } catch {
    return null;
  }
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
