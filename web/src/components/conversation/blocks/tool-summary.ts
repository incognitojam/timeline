// Compact one-line summaries for common AI coding tools. Returns null for
// unknown tools; callers fall back to pretty-printed JSON.

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Compact representation of a file path: keep the last two segments at most,
// so long absolute paths don't dominate a single-line summary row.
function shortPath(path: string): string {
  if (!path) return path;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join("/");
}

// MCP tool ids look like `mcp__<server>__<tool>`. The middle server slug is
// noise in a summary row — collapse to just `<tool>` and stash the server
// in the subtitle so it's still visible on expand.
function shortMcpName(toolName: string): { tool: string; server: string | null } {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(toolName);
  if (!m) return { tool: toolName, server: null };
  return { tool: m[2], server: m[1] };
}

export interface ToolSummary {
  header: string;
  subtitle?: string;
}

export function summarizeToolUse(
  toolName: string,
  input: Record<string, unknown> | undefined
): ToolSummary | null {
  if (toolName.startsWith("mcp__")) {
    const { tool, server } = shortMcpName(toolName);
    const primary = primaryInputText(input);
    const header = primary ? `${tool} ${primary}` : tool;
    return { header, subtitle: server ?? undefined };
  }
  if (!input) return null;
  switch (toolName) {
    case "Read": {
      const path = str(input.file_path);
      if (!path) return null;
      const offset = num(input.offset);
      const limit = num(input.limit);
      const range =
        offset !== null || limit !== null
          ? ` (${offset ?? 0}–${limit ? (offset ?? 0) + limit : "end"})`
          : "";
      return { header: `Read ${shortPath(path)}${range}`, subtitle: path };
    }
    case "Bash": {
      const cmd = str(input.command);
      if (!cmd) return null;
      const description = str(input.description);
      return { header: `$ ${cmd}`, subtitle: description ?? undefined };
    }
    case "Edit": {
      const path = str(input.file_path);
      if (!path) return null;
      return { header: `Edit ${shortPath(path)}`, subtitle: path };
    }
    case "Write": {
      const path = str(input.file_path);
      if (!path) return null;
      const content = str(input.content);
      const lines = content ? content.split("\n").length : 0;
      return {
        header: `Write ${shortPath(path)}${lines ? ` (${lines} lines)` : ""}`,
        subtitle: path,
      };
    }
    case "Grep": {
      const pattern = str(input.pattern);
      if (!pattern) return null;
      const path = str(input.path) ?? str(input.glob) ?? "";
      return {
        header: `Grep "${pattern}"${path ? ` in ${shortPath(path)}` : ""}`,
      };
    }
    case "Glob": {
      const pattern = str(input.pattern);
      if (!pattern) return null;
      return { header: `Glob ${pattern}` };
    }
    case "WebFetch": {
      const url = str(input.url);
      return url ? { header: `WebFetch ${url}` } : null;
    }
    case "WebSearch": {
      const query = str(input.query);
      return query ? { header: `WebSearch "${query}"` } : null;
    }
    case "TodoWrite": {
      return { header: "TodoWrite" };
    }
    case "Task":
    case "Agent": {
      const subagent = str(input.subagent_type);
      const description = str(input.description);
      const head = subagent ? `${toolName} → ${subagent}` : toolName;
      return { header: head, subtitle: description ?? undefined };
    }
    default:
      return null;
  }
}

// Short per-tool display string when no registered summarizer matches — used
// to label a tool call in a chain without showing the full JSON input. Pulls
// the most "primary" input field (query, url, command, path) when present.
export function primaryInputText(
  input: Record<string, unknown> | undefined
): string | null {
  if (!input) return null;
  const keys = ["query", "url", "command", "file_path", "path", "pattern"];
  for (const key of keys) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

