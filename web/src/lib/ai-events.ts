import type { ContentBlock } from "./content-blocks";
import { isContentBlock } from "./content-blocks";
import type { TimelineEvent } from "./types";

export const AI_SOURCES = [
  "claude",
  "claude-code",
  "amp",
  "opencode",
  "conductor",
  "t3code",
  "codex",
  "chatgpt",
] as const;

export type AISource = (typeof AI_SOURCES)[number];

export function isAIEventSource(source: string): source is AISource {
  return (AI_SOURCES as readonly string[]).includes(source);
}

function parseRawData(event: TimelineEvent): Record<string, unknown> | null {
  if (!event.raw_data) return null;
  try {
    const parsed = JSON.parse(event.raw_data);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Pull the structured content blocks out of raw_data. Falls back to a single
// synthesized text block when blocks aren't preserved (older rows that
// predate the `raw_data.content` refresh).
//
// Unrecognized entries become `{type: "unknown"}` blocks rather than being
// dropped, so the returned array's indices match the raw content array —
// attachment source_id paths address blocks by raw index (see inline-images).
export function parseAIContent(event: TimelineEvent): ContentBlock[] {
  const raw = parseRawData(event);
  const blocks = raw?.content;
  if (Array.isArray(blocks)) {
    return blocks.map((block) =>
      isContentBlock(block) ? block : { type: "unknown", raw: block }
    );
  }
  if (event.content) {
    return [{ type: "text", text: event.content }];
  }
  return [];
}

// Returns true when rendering `event` under AIMessageContent would produce
// at least one visible block. Skips events that are pure protocol artifacts:
// - a user message whose only content is a tool_result already paired with
//   its tool_use in a prior message
// - an assistant message whose only content is a "redacted thinking" block
//   (empty `thinking` with just a `signature`) or an empty text block
export function hasRenderableAIContent(
  event: TimelineEvent,
  resolveToolResult?: (toolUseId: string) => ContentBlock | undefined
): boolean {
  if (!isAIEventSource(event.source)) return true;
  const blocks = parseAIContent(event);
  for (const block of blocks) {
    if (isRenderableBlock(block, resolveToolResult)) return true;
  }
  return false;
}

function isRenderableBlock(
  block: ContentBlock,
  resolveToolResult?: (toolUseId: string) => ContentBlock | undefined
): boolean {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" && block.text.length > 0;
    case "thinking":
      // Redacted thinking (empty `thinking`, just a `signature`) still renders
      // a small indicator so the user can see that reasoning happened.
      return true;
    case "tool_use":
      return true;
    case "tool_result": {
      const id = block.tool_use_id;
      if (id && resolveToolResult && resolveToolResult(id) !== undefined) {
        return false;
      }
      return true;
    }
    case "flag":
      return true;
    case "summary":
      // Compaction summaries render their text, or a placeholder naming the
      // referenced thread for thread-level summaries.
      return (
        (typeof block.text === "string" && block.text.length > 0) ||
        (typeof block.thread_id === "string" && block.thread_id.length > 0)
      );
    case "image":
      // Image blocks keep the row visible; stored attachment previews may
      // render the actual media in place of the metadata placeholder.
      return true;
    default:
      return false;
  }
}

export interface AIEventMeta {
  source: AISource;
  sessionId: string | null;
  model: string | null;
  cwd: string | null;
  workspace: string | null;
  gitBranch: string | null;
  agent: string | null;
  mode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
  credits: number | null;
  finishReason: string | null;
  toolUsage: Record<string, number> | null;
  conversationSummary: string | null;
  attachmentCount: number;
  // The Task tool_use id that spawned this message, if it's a sub-agent
  // message. Null on top-level messages.
  parentToolUseId: string | null;
  // Claude Code only: true for messages from a sidechain transcript.
  isSidechain: boolean;
  // Claude Code only: agent id of the sidechain transcript file.
  agentId: string | null;
}

function n(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function s(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

// Extract the normalized per-message metadata. Only fields the source
// actually provides are populated; everything else is null.
export function extractAIMeta(event: TimelineEvent): AIEventMeta | null {
  if (!isAIEventSource(event.source)) return null;
  const raw = parseRawData(event);

  const meta: AIEventMeta = {
    source: event.source,
    sessionId: null,
    model: null,
    cwd: null,
    workspace: null,
    gitBranch: null,
    agent: null,
    mode: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    cost: null,
    credits: null,
    finishReason: null,
    toolUsage: null,
    conversationSummary: null,
    attachmentCount: 0,
    parentToolUseId: null,
    isSidechain: false,
    agentId: null,
  };

  if (!raw) return meta;

  switch (event.source) {
    case "claude-code": {
      meta.sessionId = s(raw.session_id);
      meta.model = s(raw.model);
      meta.cwd = s(raw.cwd);
      meta.gitBranch = s(raw.git_branch);
      meta.workspace = meta.cwd ? basename(meta.cwd) : null;
      meta.parentToolUseId = s(raw.parent_tool_use_id);
      meta.isSidechain = raw.is_sidechain === true;
      meta.agentId = s(raw.agent_id);
      const usage = raw.usage as Record<string, unknown> | undefined;
      if (usage) {
        meta.inputTokens = n(usage.input_tokens);
        meta.outputTokens = n(usage.output_tokens);
        meta.cacheReadTokens = n(usage.cache_read_input_tokens);
        meta.cacheWriteTokens = n(usage.cache_creation_input_tokens);
      }
      break;
    }
    case "amp": {
      meta.sessionId = s(raw.thread_id);
      meta.model = s(raw.model);
      meta.mode = s(raw.agent_mode);
      const roots = raw.workspace_roots;
      if (Array.isArray(roots) && roots.length > 0 && typeof roots[0] === "string") {
        meta.cwd = roots[0];
        meta.workspace = basename(roots[0]);
      }
      const usage = raw.usage as Record<string, unknown> | undefined;
      if (usage) {
        meta.inputTokens = n(usage.input_tokens);
        meta.outputTokens = n(usage.output_tokens);
        meta.cacheReadTokens = n(usage.cache_read_input_tokens);
        meta.cacheWriteTokens = n(usage.cache_creation_input_tokens);
        meta.credits = n(usage.credits);
      }
      break;
    }
    case "opencode": {
      meta.sessionId = s(raw.session_id);
      meta.model = s(raw.model);
      meta.agent = s(raw.agent);
      meta.mode = s(raw.mode);
      meta.finishReason = s(raw.finish_reason);
      meta.cost = n(raw.cost);
      meta.cwd = s(raw.cwd) ?? s(raw.project_path);
      meta.workspace = meta.cwd ? basename(meta.cwd) : null;
      const tokens = raw.tokens as Record<string, unknown> | undefined;
      if (tokens) {
        meta.inputTokens = n(tokens.input);
        meta.outputTokens = n(tokens.output);
        meta.reasoningTokens = n(tokens.reasoning);
        const cache = tokens.cache as Record<string, unknown> | undefined;
        if (cache) {
          meta.cacheReadTokens = n(cache.read);
          meta.cacheWriteTokens = n(cache.write);
        }
      }
      const toolUsage = raw.tool_usage;
      if (toolUsage && typeof toolUsage === "object" && !Array.isArray(toolUsage)) {
        const entries: [string, number][] = [];
        for (const [k, v] of Object.entries(toolUsage as Record<string, unknown>)) {
          const count = n(v);
          if (count !== null) entries.push([k, count]);
        }
        if (entries.length > 0) meta.toolUsage = Object.fromEntries(entries);
      }
      break;
    }
    case "conductor": {
      meta.sessionId = s(raw.session_id);
      meta.model = s(raw.model);
      meta.agent = s(raw.agent_type);
      meta.finishReason = s(raw.stop_reason);
      meta.workspace = s(raw.repo_name) ?? s(raw.workspace_name);
      meta.cwd = s(raw.repo_path);
      meta.gitBranch = s(raw.workspace_branch);
      meta.parentToolUseId = s(raw.parent_tool_use_id);
      const usage = raw.usage as Record<string, unknown> | undefined;
      if (usage) {
        meta.inputTokens = n(usage.input_tokens);
        meta.outputTokens = n(usage.output_tokens);
        meta.cacheReadTokens = n(usage.cache_read_input_tokens);
        meta.cacheWriteTokens = n(usage.cache_creation_input_tokens);
      }
      break;
    }
    case "codex": {
      meta.sessionId = s(raw.session_id);
      meta.model = s(raw.model);
      meta.agent = s(raw.originator);
      meta.mode = s(raw.session_source);
      meta.cwd = s(raw.cwd);
      meta.workspace = s(raw.project) ?? (meta.cwd ? basename(meta.cwd) : null);
      meta.gitBranch = s(raw.git_branch);
      meta.attachmentCount = n(raw.images) ?? 0;
      break;
    }
    case "t3code": {
      meta.sessionId = s(raw.thread_id);
      meta.model = s(raw.model);
      meta.agent = s(raw.provider);
      meta.workspace = s(raw.project_title);
      meta.cwd = s(raw.workspace_root);
      meta.gitBranch = s(raw.branch);
      const attachments = raw.attachments;
      meta.attachmentCount = Array.isArray(attachments) ? attachments.length : 0;
      break;
    }
    case "claude": {
      meta.sessionId = s(raw.conversation_uuid);
      meta.conversationSummary = s(raw.conversation_summary);
      const a = Array.isArray(raw.attachments) ? raw.attachments.length : 0;
      const f = Array.isArray(raw.files) ? raw.files.length : 0;
      meta.attachmentCount = a + f;
      break;
    }
    case "chatgpt": {
      meta.sessionId = s(raw.conversation_id);
      meta.model = s(raw.model_slug);
      break;
    }
  }

  return meta;
}

export interface AggregatedAIMeta {
  source: AISource;
  messageCount: number;
  sessionIds: string[];
  models: { model: string; count: number }[];
  cwd: string | null;
  workspace: string | null;
  gitBranch: string | null;
  agent: string | null;
  mode: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  totalCost: number;
  totalCredits: number;
  toolUsage: Record<string, number>;
  finishReasons: { reason: string; count: number }[];
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  conversationSummary: string | null;
  totalAttachments: number;
  messagesWithAttachments: number;
}

function tallyString(map: Map<string, number>, value: string | null) {
  if (!value) return;
  map.set(value, (map.get(value) ?? 0) + 1);
}

// Aggregate per-message meta across a full thread. Scalar fields (cwd,
// workspace, branch, agent, mode) take the first non-null value; callers
// can sanity-check by comparing per-event meta if needed.
export function aggregateAIMeta(
  source: AISource,
  events: TimelineEvent[]
): AggregatedAIMeta {
  const agg: AggregatedAIMeta = {
    source,
    messageCount: events.length,
    sessionIds: [],
    models: [],
    cwd: null,
    workspace: null,
    gitBranch: null,
    agent: null,
    mode: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalReasoningTokens: 0,
    totalCost: 0,
    totalCredits: 0,
    toolUsage: {},
    finishReasons: [],
    firstTimestamp: null,
    lastTimestamp: null,
    conversationSummary: null,
    totalAttachments: 0,
    messagesWithAttachments: 0,
  };

  const sessionIds = new Set<string>();
  const models = new Map<string, number>();
  const finishReasons = new Map<string, number>();

  for (const event of events) {
    if (event.timestamp) {
      const ts = event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp);
      if (!agg.firstTimestamp || ts < agg.firstTimestamp) agg.firstTimestamp = ts;
      if (!agg.lastTimestamp || ts > agg.lastTimestamp) agg.lastTimestamp = ts;
    }

    const meta = extractAIMeta(event);
    if (!meta) continue;

    if (meta.sessionId) sessionIds.add(meta.sessionId);
    tallyString(models, meta.model);
    tallyString(finishReasons, meta.finishReason);

    agg.cwd ??= meta.cwd;
    agg.workspace ??= meta.workspace;
    agg.gitBranch ??= meta.gitBranch;
    agg.agent ??= meta.agent;
    agg.mode ??= meta.mode;

    agg.totalInputTokens += meta.inputTokens ?? 0;
    agg.totalOutputTokens += meta.outputTokens ?? 0;
    agg.totalCacheReadTokens += meta.cacheReadTokens ?? 0;
    agg.totalCacheWriteTokens += meta.cacheWriteTokens ?? 0;
    agg.totalReasoningTokens += meta.reasoningTokens ?? 0;
    agg.totalCost += meta.cost ?? 0;
    agg.totalCredits += meta.credits ?? 0;

    if (meta.toolUsage) {
      for (const [tool, count] of Object.entries(meta.toolUsage)) {
        agg.toolUsage[tool] = (agg.toolUsage[tool] ?? 0) + count;
      }
    }

    agg.conversationSummary ??= meta.conversationSummary;
    agg.totalAttachments += meta.attachmentCount;
    if (meta.attachmentCount > 0) agg.messagesWithAttachments += 1;
  }

  agg.sessionIds = [...sessionIds];
  agg.models = [...models.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model, count]) => ({ model, count }));
  agg.finishReasons = [...finishReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));

  return agg;
}

// Returns the Task tool_use id that spawned this message, or null if the
// event is not a sub-agent message (or not an AI event at all).
export function getParentToolUseId(event: TimelineEvent): string | null {
  if (!isAIEventSource(event.source)) return null;
  return extractAIMeta(event)?.parentToolUseId ?? null;
}

export interface AIResumeAction {
  label: string;
  command: string;
  kind: "cli" | "url";
}

// Derive the coding-project name an AI conversation belongs to. Mirrors the
// per-source matching in src/db/coding-projects.ts so links surface only when
// the conversation page would land on a project the dashboard knows about.
//
// - conductor: `raw_data.repo_name` (stable per session)
// - t3code: `raw_data.project_title` (stable per thread)
// - claude-code: title prefix — `title` is `"<project> (<slug>)"` or just
//   `<project>`. We avoid `raw_data.cwd` because it shifts when the user cd's
//   mid-session.
// - amp: `raw_data.workspace_roots[0]` — Conductor-aware so a workspace under
//   `~/conductor/workspaces/<repo>/<workspace-vN>` rolls up to `<repo>`.
// - opencode: same shape as amp, using `raw_data.project_path`.
// - codex: same shape as amp, using `raw_data.cwd` (session launch dir).
// - claude / chatgpt: no project context.
function basenameFromPath(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || null;
}

function projectFromWorkspacePath(path: string | undefined): string | null {
  if (!path) return null;
  const conductor = path.match(/\/conductor\/workspaces\/([^/]+)\//);
  if (conductor) return conductor[1];
  return basenameFromPath(path);
}

export function getCodingProjectName(event: TimelineEvent): string | null {
  if (!isAIEventSource(event.source)) return null;
  const raw = parseRawData(event);
  switch (event.source as AISource) {
    case "conductor": {
      const repoName = raw?.repo_name;
      return typeof repoName === "string" && repoName ? repoName : null;
    }
    case "t3code": {
      const projectTitle = raw?.project_title;
      return typeof projectTitle === "string" && projectTitle ? projectTitle : null;
    }
    case "claude-code": {
      if (!event.title) return null;
      const parenIdx = event.title.indexOf(" (");
      return parenIdx > 0 ? event.title.slice(0, parenIdx) : event.title;
    }
    case "amp": {
      const roots = raw?.workspace_roots;
      const first = Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : undefined;
      return projectFromWorkspacePath(first);
    }
    case "opencode": {
      const projectPath = raw?.project_path;
      return projectFromWorkspacePath(typeof projectPath === "string" ? projectPath : undefined);
    }
    case "codex": {
      const cwd = raw?.cwd;
      return projectFromWorkspacePath(typeof cwd === "string" ? cwd : undefined);
    }
    default:
      return null;
  }
}

// Returns a copy-to-clipboard action to resume the session, or null if the
// source either has no resume story (Conductor) or uses a CLI flag we haven't
// verified (OpenCode).
export function buildCliResumeCommand(meta: AggregatedAIMeta): AIResumeAction | null {
  const sessionId = meta.sessionIds[0];
  if (!sessionId) return null;

  switch (meta.source) {
    case "claude-code":
      return { label: "Resume in CLI", command: `claude --resume ${sessionId}`, kind: "cli" };
    case "codex":
      return { label: "Resume in CLI", command: `codex resume ${sessionId}`, kind: "cli" };
    case "amp":
      return { label: "Continue in CLI", command: `amp threads continue ${sessionId}`, kind: "cli" };
    case "claude":
      return { label: "Open in browser", command: `https://claude.ai/chat/${sessionId}`, kind: "url" };
    case "chatgpt":
      return { label: "Open in browser", command: `https://chatgpt.com/c/${sessionId}`, kind: "url" };
    case "opencode":
    case "conductor":
    case "t3code":
      return null;
  }
}
