#!/usr/bin/env bun
/**
 * Codex CLI Session Parser
 *
 * Imports sessions from OpenAI Codex CLI rollout files at
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl.
 *
 * Each rollout starts with a `session_meta` line (session id, cwd, originator,
 * git info), followed by `turn_context` lines (model per turn) and the
 * conversation. User/assistant text is read from `event_msg` lines
 * (user_message / agent_message), which carry the clean conversation without
 * the injected AGENTS.md / environment_context wrappers that appear in
 * `response_item` message lines.
 *
 * Tool calls (`function_call` + `function_call_output`, `custom_tool_call`
 * apply_patch envelopes and code-mode `exec` scripts, `web_search_call`) and
 * readable reasoning summaries
 * import as assistant events whose raw_data.content carries
 * tool_use/tool_result/thinking blocks, normalized to the shared tool
 * vocabulary (Bash / Write / Edit / Delete / WebSearch) like the t3code
 * parser. Most reasoning is encrypted by Codex and cannot be imported.
 *
 * Sessions originated by T3 Code (originator `t3code_desktop`) are skipped —
 * those conversations are imported by the t3code parser.
 *
 * Subagent rollouts (review mode, thread spawns) are folded into the parent
 * thread's conversation rather than imported as top-level conversations,
 * matching how the claude-code parser links sidechains to their session.
 * Their files replay a contiguous prefix of the parent rollout (verbatim
 * payloads with rewritten envelope timestamps) before the child's own items
 * — including the parent's token_count events — so leading lines whose
 * payload appears in the parent file are skipped to avoid duplicate events
 * and double-counted usage. If a parent rollout has been deleted while its
 * children remain, the replay imports as-is (duplicates within the folded
 * conversation); rollouts are user-managed and never pruned by codex, so no
 * reconciliation pass exists for that state.
 *
 * Usage:
 *   bun run src/parsers/codex.ts [sessions-dir] [account] [--dry-run] [--refresh-raw-data]
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { readdir } from "fs/promises";
import { basename, join } from "path";
import { getDb, initDb } from "../db/schema";
import { projectNameFromWorkspacePath } from "../db/coding-projects";
import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";
import { insertStoredAttachment } from "../media/attachments";
import { formatModelName } from "./shared/model-names";
import type { ContentBlock } from "./shared/format-content";
import { createEventWriter, type WriteOutcome } from "./shared/ai-import";
import {
  decodeBase64ImageData,
  errorMessage,
  storeDecodedImage,
  type StoredImageAttachment,
} from "./shared/image-blocks";

export const DEFAULT_CODEX_SESSIONS_DIR = `${process.env.HOME}/.codex/sessions`;

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface SessionMeta {
  sessionId: string;
  cwd?: string;
  originator?: string;
  cliVersion?: string;
  /** "cli" | "exec" | "vscode" | "subagent" */
  sessionSource?: string;
  parentThreadId?: string;
  /** Root thread id (`session_id`): own id for top-level sessions, the
   * parent/root thread for subagents. Missing on older rollouts. */
  rootThreadId?: string;
  gitBranch?: string;
}

export interface ImportStats {
  sessions: number;
  messages: number;
  toolCalls: number;
  reasoning: number;
  refreshed: number;
  skipped: number;
  replayLinesSkipped: number;
  skippedT3Sessions: number;
  identitiesUpserted: number;
}

export interface ImportCodexOptions {
  dryRun?: boolean;
  refreshRawData?: boolean;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseSessionMeta(line: RolloutLine): SessionMeta | null {
  if (line.type !== "session_meta" || !line.payload) return null;
  const p = line.payload;
  const sessionId = str(p.id);
  if (!sessionId) return null;

  // `source` is a string for interactive sessions and an object for
  // subagents: {"subagent": "review"} for review mode, or
  // {"subagent": {"thread_spawn": {"parent_thread_id": ...}}} for spawns.
  // All subagent metas also carry a top-level `parent_thread_id`; the nested
  // thread_spawn field is kept as a fallback.
  let sessionSource = str(p.source);
  let parentThreadId = str(p.parent_thread_id);
  if (!sessionSource && p.source && typeof p.source === "object") {
    sessionSource = "subagent";
    const subagent = (p.source as Record<string, unknown>).subagent;
    if (!parentThreadId && subagent && typeof subagent === "object") {
      const spawn = (subagent as Record<string, unknown>).thread_spawn;
      if (spawn && typeof spawn === "object") {
        parentThreadId = str((spawn as Record<string, unknown>).parent_thread_id);
      }
    }
  }

  const git = p.git;
  const gitBranch =
    git && typeof git === "object"
      ? str((git as Record<string, unknown>).branch)
      : undefined;

  return {
    sessionId,
    cwd: str(p.cwd),
    originator: str(p.originator),
    cliVersion: str(p.cli_version),
    sessionSource,
    parentThreadId,
    rootThreadId: str(p.session_id),
    gitBranch,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface PendingCall {
  line: number;
  timestamp: string;
  model: string | undefined;
  name: string;
  arguments: string | undefined;
}

// Summed last_token_usage counts stored at raw_data.usage on assistant
// events. Field semantics follow the OpenAI usage convention:
// cached_input_tokens ⊆ input_tokens, reasoning_output_tokens ⊆ output_tokens.
interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface CodexImageDataUrl {
  blockIndex: number;
  dataUrl: string;
  mediaType: string | undefined;
}

interface DecodedCodexImage {
  content: Buffer;
  mediaType: string;
}

type EmittedEvent = {
  eventId: number | null;
  sourceId: string;
  outcome: WriteOutcome;
};

/**
 * Map a function_call (+ optional output text) to tool_use/tool_result
 * blocks. `exec_command` / `shell_command` normalize to Bash so the web
 * app's per-tool summaries apply; other tools pass through under their
 * codex name with parsed arguments as input.
 */
export function functionCallToBlocks(
  call: { name: string; arguments?: string; callId: string },
  output: string | undefined
): ContentBlock[] {
  const args = asRecord(safeParse(call.arguments));

  let name = call.name;
  let input: Record<string, unknown> | undefined = args ?? undefined;
  if (name === "exec_command" || name === "shell_command") {
    const command = str(args?.cmd) ?? str(args?.command);
    if (command) {
      name = "Bash";
      input = { command };
      const cwd = str(args?.workdir);
      if (cwd) input.cwd = cwd;
    }
  }

  const blocks: ContentBlock[] = [
    { type: "tool_use", name, id: call.callId, input },
  ];
  if (output !== undefined) {
    // Exec output embeds its exit status as text ("Process exited with
    // code N"); surface nonzero exits as errors.
    const exitMatch = name === "Bash" ? output.match(/Process exited with code (\d+)/) : null;
    if (exitMatch && exitMatch[1] !== "0") {
      blocks.push({ type: "tool_result", tool_use_id: call.callId, error: output });
    } else {
      blocks.push({ type: "tool_result", tool_use_id: call.callId, content: output });
    }
  }
  return blocks;
}

/**
 * Split an apply_patch envelope into per-file Write/Edit/Delete blocks with
 * each file's hunk as the tool_result, matching how t3code renders file
 * changes. Falls back to a single generic block when no file markers parse.
 */
export function applyPatchToBlocks(patch: string, callId: string): ContentBlock[] {
  const marker = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  const files: { kind: string; path: string; start: number }[] = [];
  for (let m = marker.exec(patch); m !== null; m = marker.exec(patch)) {
    files.push({ kind: m[1], path: m[2].trim(), start: m.index });
  }

  if (files.length === 0) {
    return [
      { type: "tool_use", name: "apply_patch", id: callId, input: { patch } },
    ];
  }

  const blocks: ContentBlock[] = [];
  files.forEach((file, index) => {
    const name =
      file.kind === "Add" ? "Write" : file.kind === "Delete" ? "Delete" : "Edit";
    const id = files.length > 1 ? `${callId}:${index}` : callId;
    blocks.push({ type: "tool_use", name, id, input: { file_path: file.path } });
    const end = index + 1 < files.length ? files[index + 1].start : patch.length;
    const hunk = patch
      .slice(file.start, end)
      .replace(/\n\*\*\* End Patch\s*$/, "")
      .trim();
    if (name !== "Delete" && hunk) {
      blocks.push({ type: "tool_result", tool_use_id: id, content: hunk });
    }
  });
  return blocks;
}

/**
 * Parse a `{key: value}` object literal starting at `start`, accepting the
 * JS shapes code-mode emits (bare or quoted keys; string/number/boolean/null
 * values). Returns the parsed record and the index just past the closing
 * brace, or null on anything it doesn't recognize — including a nested
 * structure — so callers fall back to the raw script.
 */
function parseObjectLiteralAt(
  source: string,
  start: number
): { value: Record<string, unknown>; end: number } | null {
  let i = start;
  const skipWs = () => {
    while (i < source.length && /\s/.test(source[i])) i++;
  };
  // Scan a double-quoted string respecting escapes, then let JSON.parse
  // decode it; JS-only escapes fail the parse and abort the whole literal.
  const parseString = (): string | null => {
    const from = i;
    i++;
    while (i < source.length) {
      if (source[i] === "\\") i += 2;
      else if (source[i] === '"') {
        i++;
        const decoded = safeParse(source.slice(from, i));
        return typeof decoded === "string" ? decoded : null;
      } else i++;
    }
    return null;
  };

  skipWs();
  if (source[i] !== "{") return null;
  i++;
  const value: Record<string, unknown> = {};
  skipWs();
  if (source[i] === "}") return { value, end: i + 1 };

  for (;;) {
    skipWs();
    let key: string | null;
    if (source[i] === '"') {
      key = parseString();
    } else {
      const m = source.slice(i).match(/^[A-Za-z_$][\w$]*/);
      key = m ? m[0] : null;
      if (m) i += m[0].length;
    }
    if (key === null) return null;
    skipWs();
    if (source[i] !== ":") return null;
    i++;
    skipWs();
    if (source[i] === '"') {
      const v = parseString();
      if (v === null) return null;
      value[key] = v;
    } else {
      const m = source.slice(i).match(/^(?:-?\d+(?:\.\d+)?|true|false|null)/);
      if (!m) return null;
      value[key] = JSON.parse(m[0]);
      i += m[0].length;
    }
    skipWs();
    if (source[i] === ",") {
      i++;
      continue;
    }
    if (source[i] === "}") return { value, end: i + 1 };
    return null;
  }
}

/**
 * Map a code-mode `exec` custom_tool_call (CLI 0.144.0+) to tool blocks.
 * The call input is a JS script run by the code-mode host; the dominant
 * shape is a single `tools.exec_command({...})` wrapper, which normalizes
 * to Bash like the legacy function_call path. Any other script passes
 * through as an `exec` tool_use with the script as input, so no logic is
 * hidden behind an extracted command.
 */
export function execCallToBlocks(
  code: string,
  callId: string,
  output: string | undefined
): ContentBlock[] {
  let use: ContentBlock = {
    type: "tool_use",
    name: "exec",
    id: callId,
    input: { code },
  };

  const prefix = code.match(
    /^\s*(?:const|let|var)\s+(\w+)\s*=\s*await\s+tools\.exec_command\(/
  );
  const parsed = prefix ? parseObjectLiteralAt(code, prefix[0].length) : null;
  if (prefix && parsed) {
    const rest = code.slice(parsed.end);
    const isPureWrapper = new RegExp(
      `^\\)\\s*;?\\s*text\\(${prefix[1]}(?:\\.output)?\\)\\s*;?\\s*$`
    ).test(rest);
    const command = str(parsed.value.cmd);
    if (isPureWrapper && command) {
      const input: Record<string, unknown> = { command };
      const cwd = str(parsed.value.workdir);
      if (cwd) input.cwd = cwd;
      use = { type: "tool_use", name: "Bash", id: callId, input };
    }
  }

  const blocks: ContentBlock[] = [use];
  if (output !== undefined) {
    // Script failures still report "Script completed" (exit status is part
    // of the output text); the only structural failure is the host-level
    // "failed to spawn code-mode host ..." string.
    if (output.startsWith("failed to spawn")) {
      blocks.push({ type: "tool_result", tool_use_id: callId, error: output });
    } else {
      blocks.push({ type: "tool_result", tool_use_id: callId, content: output });
    }
  }
  return blocks;
}

/**
 * custom_tool_call_output payloads carry either a plain string or an array
 * of `{type: "input_text", text}` blocks (code-mode exec results).
 */
export function customToolCallOutputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return undefined;
  return output.map((block) => str(asRecord(block)?.text) ?? "").join("");
}

/** Readable reasoning summaries -> a thinking block; encrypted-only -> []. */
export function reasoningToBlocks(payload: Record<string, unknown>): ContentBlock[] {
  const summary = Array.isArray(payload.summary) ? payload.summary : [];
  const texts = summary
    .map((item) => str(asRecord(item)?.text))
    .filter((t): t is string => Boolean(t));
  if (texts.length === 0) return [];
  return [{ type: "thinking", thinking: texts.join("\n\n") }];
}

function safeParse(json: string | undefined): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function decodeBase64DataUrl(
  dataUrl: string,
  mediaType: string | undefined,
  blockIndex: string
): DecodedCodexImage {
  if (!mediaType) throw new Error("missing MIME type");
  if (!mediaType.toLowerCase().startsWith("image/")) {
    throw new Error(`non-image MIME type: ${mediaType}`);
  }

  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match) throw new Error("malformed base64 data URL");
  return {
    content: decodeBase64ImageData(match[2], blockIndex, "Codex"),
    mediaType,
  };
}

async function storeCodexImageAttachment(options: {
  image: CodexImageDataUrl;
  sourceAccount: string;
  sessionId: string;
  eventSourceId: string;
}): Promise<StoredImageAttachment | null> {
  const { image, sourceAccount, sessionId, eventSourceId } = options;
  const imageIndex = String(image.blockIndex);

  try {
    const decoded = decodeBase64DataUrl(image.dataUrl, image.mediaType, imageIndex);
    return await storeDecodedImage({
      source: "codex",
      sourceLabel: "Codex",
      loggerPrefix: "codex",
      sourceAccount,
      sessionId,
      messageId: eventSourceId,
      messageIdLabel: "eventSourceId",
      content: decoded.content,
      sourceId: imageIndex,
      filenameId: imageIndex,
      mediaType: decoded.mediaType,
    });
  } catch (error) {
    console.warn(
      `codex: leaving inline image for ${eventSourceId} at image index ${imageIndex}: ${errorMessage(error)}`
    );
    return null;
  }
}

async function storeCodexImageAttachments(options: {
  images: CodexImageDataUrl[];
  sourceAccount: string;
  sessionId: string;
  eventSourceId: string;
}): Promise<StoredImageAttachment[]> {
  const attachments: StoredImageAttachment[] = [];
  for (const image of options.images) {
    const attachment = await storeCodexImageAttachment({
      image,
      sourceAccount: options.sourceAccount,
      sessionId: options.sessionId,
      eventSourceId: options.eventSourceId,
    });
    if (attachment) attachments.push(attachment);
  }
  return attachments;
}

/** Recursively find rollout-*.jsonl files under the sessions dir. */
async function findRolloutFiles(sessionsDir: string): Promise<string[]> {
  const entries = await readdir(sessionsDir, { recursive: true });
  return entries
    .filter((e) => basename(e).startsWith("rollout-") && e.endsWith(".jsonl"))
    .map((e) => join(sessionsDir, e))
    .sort();
}

export async function importCodex(
  db: Database,
  sessionsDir: string,
  sourceAccount: string,
  options: ImportCodexOptions = {}
): Promise<ImportStats> {
  const importBatch = `codex-${sourceAccount}-${Date.now()}`;
  const dryRun = options.dryRun ?? false;
  const refreshRawData = options.refreshRawData ?? false;

  const stats: ImportStats = {
    sessions: 0,
    messages: 0,
    toolCalls: 0,
    reasoning: 0,
    refreshed: 0,
    skipped: 0,
    replayLinesSkipped: 0,
    skippedT3Sessions: 0,
    identitiesUpserted: 0,
  };

  const identities = new Map<string, UpsertIdentityOptions>();
  const userIdentifier = formatIdentifier("codex", sourceAccount);
  identities.set(userIdentifier, {
    platform: "codex",
    platformId: sourceAccount,
    displayName: sourceAccount,
    username: sourceAccount,
  });

  const files = await findRolloutFiles(sessionsDir);
  console.log(`Found ${files.length.toLocaleString()} rollout files`);

  // Rollout filenames embed the session id, so a subagent's parent rollout
  // can be resolved without reading any file contents.
  const fileBySessionId = new Map<string, string>();
  for (const file of files) {
    const match = basename(file).match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/);
    if (match) fileBySessionId.set(match[1], file);
  }

  // Payload-string sets of parent rollouts, built lazily and shared by
  // sibling subagents. `null` = parent file not found (import the child
  // as-is rather than dropping it).
  const parentPayloadCache = new Map<string, Set<string> | null>();
  const getParentPayloads = async (parentId: string): Promise<Set<string> | null> => {
    const cached = parentPayloadCache.get(parentId);
    if (cached !== undefined) return cached;
    const parentFile = fileBySessionId.get(parentId);
    let payloads: Set<string> | null = null;
    if (parentFile) {
      payloads = new Set();
      for (const rawLine of (await Bun.file(parentFile).text()).split("\n")) {
        if (!rawLine.trim()) continue;
        try {
          const parsed = JSON.parse(rawLine) as RolloutLine;
          if (parsed.payload) payloads.add(JSON.stringify(parsed.payload));
        } catch {
          // Skip unparseable lines; they can't match a replayed payload.
        }
      }
    }
    parentPayloadCache.set(parentId, payloads);
    return payloads;
  };

  const eventWriter = dryRun
    ? null
    : createEventWriter(db, {
        source: "codex",
        sourceAccount,
        importBatch,
        refreshRawData,
      });

  if (!dryRun) db.run("BEGIN TRANSACTION");

  try {
    for (const filePath of files) {
      const text = await Bun.file(filePath).text();
      const lines = text.split("\n");

      let meta: SessionMeta | null = null;
      try {
        meta = parseSessionMeta(JSON.parse(lines[0]) as RolloutLine);
      } catch {
        // fall through to the null check
      }
      if (!meta) continue;

      // T3 Code drives codex as a provider; its rollouts duplicate threads
      // already imported by the t3code parser.
      if (meta.originator === "t3code_desktop") {
        stats.skippedT3Sessions++;
        continue;
      }

      // Same convention as amp/opencode: launch cwd basename, with sessions
      // under ~/conductor/workspaces/<repo>/<workspace> rolling up to <repo>.
      const project = projectNameFromWorkspacePath(meta.cwd ?? null);
      const title = project || "Codex Chat";
      const sessionMeta = meta;
      let sessionHasMessages = false;
      let currentModel: string | undefined;

      // Subagent sessions group under the root/parent thread so review and
      // spawned-agent activity lands in the conversation that started it.
      const conversationId =
        sessionMeta.rootThreadId ?? sessionMeta.parentThreadId ?? sessionMeta.sessionId;
      const parentPayloads =
        sessionMeta.sessionSource === "subagent" && sessionMeta.parentThreadId
          ? await getParentPayloads(sessionMeta.parentThreadId)
          : null;

      // token_count events fire once per API request (many per turn, more in
      // tool-heavy turns) and carry no call/turn id to pair against a specific
      // agent_message. Accumulate each event's last_token_usage (this
      // request's tokens; total_token_usage is session-cumulative) and attach
      // the running sum to the next agent_message, giving turn-level
      // attribution that sums to the session total. Trailing counts with no
      // following agent_message (aborted turns) are dropped.
      let pendingUsage: CodexUsage | null = null;
      const addTokenCount = (info: Record<string, unknown> | null) => {
        const last = asRecord(info?.last_token_usage);
        if (!last) return;
        const acc = pendingUsage ?? {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        };
        acc.input_tokens += toCount(last.input_tokens);
        acc.cached_input_tokens += toCount(last.cached_input_tokens);
        acc.output_tokens += toCount(last.output_tokens);
        acc.reasoning_output_tokens += toCount(last.reasoning_output_tokens);
        pendingUsage = acc;
      };

      const assistantIdentity = (model: string | undefined): string => {
        const assistantPlatformId = model || "assistant";
        const assistantIdentifier = formatIdentifier("codex", assistantPlatformId);
        if (!identities.has(assistantIdentifier)) {
          identities.set(assistantIdentifier, {
            platform: "codex",
            platformId: assistantPlatformId,
            displayName: formatModelName(model ?? null),
            username: assistantPlatformId,
          });
        }
        return assistantIdentifier;
      };

      // Insert one event and bump the given stats counter; on duplicate,
      // optionally refresh content+raw_data.
      const emitEvent = (
        lineIndex: number,
        timestamp: string,
        isUser: boolean,
        model: string | undefined,
        content: string,
        extraRaw: Record<string, unknown>,
        counter: "messages" | "toolCalls" | "reasoning"
      ): EmittedEvent => {
        const tags = [
          "editor:codex",
          project && `project:${project}`,
          model && `model:${model}`,
          sessionMeta.gitBranch && `branch:${sessionMeta.gitBranch}`,
        ].filter((t): t is string => Boolean(t));

        const people = isUser
          ? [userIdentifier]
          : [assistantIdentity(model), userIdentifier];

        const rawData = JSON.stringify({
          session_id: sessionMeta.sessionId,
          line: lineIndex,
          model,
          cwd: sessionMeta.cwd,
          project,
          originator: sessionMeta.originator,
          session_source: sessionMeta.sessionSource,
          parent_thread_id: sessionMeta.parentThreadId,
          cli_version: sessionMeta.cliVersion,
          git_branch: sessionMeta.gitBranch,
          ...extraRaw,
        });

        sessionHasMessages = true;
        const sourceId = `${sessionMeta.sessionId}:${lineIndex}`;
        if (dryRun) {
          stats[counter]++;
          return { eventId: null, sourceId, outcome: "inserted" };
        }

        if (!eventWriter) throw new Error("event writer not prepared");
        const { outcome, eventId } = eventWriter.write({
          sourceId,
          eventType: isUser ? "codex:message:user" : "codex:message:assistant",
          timestamp,
          title,
          content,
          people,
          tags,
          rawData,
          conversationId,
        });
        if (outcome === "inserted") {
          stats[counter]++;
        } else if (outcome === "refreshed") {
          stats.refreshed++;
        } else {
          stats.skipped++;
        }
        return { eventId, sourceId, outcome };
      };

      // function_calls awaiting their function_call_output (paired by call_id)
      const pendingCalls = new Map<string, PendingCall>();
      const emitToolCall = (pending: PendingCall, callId: string, output: string | undefined) => {
        const blocks = functionCallToBlocks(
          { name: pending.name, arguments: pending.arguments, callId },
          output
        );
        emitEvent(
          pending.line,
          pending.timestamp,
          false,
          pending.model,
          // Tool calls are assistant actions; content stays empty so tool
          // noise never reaches FTS (matching the other AI parsers).
          "",
          { call_id: callId, tool: pending.name, content: blocks },
          "toolCalls"
        );
      };

      // code-mode exec custom_tool_calls awaiting their
      // custom_tool_call_output (paired by call_id); arguments holds the
      // JS script from the call's input.
      const pendingExecCalls = new Map<string, PendingCall>();
      const emitExecCall = (pending: PendingCall, callId: string, output: string | undefined) => {
        emitEvent(
          pending.line,
          pending.timestamp,
          false,
          pending.model,
          "",
          {
            call_id: callId,
            tool: "exec",
            content: execCallToBlocks(pending.arguments ?? "", callId, output),
          },
          "toolCalls"
        );
      };

      // The previous parsed payload, for dropping codex's duplicated review
      // prompt (written as two identical adjacent user_message lines).
      let prevPayload: Record<string, unknown> | undefined;
      // Review mode brackets the duplicated prompt; the dedup below only
      // applies inside it so legitimate repeated user submissions elsewhere
      // are never collapsed.
      let inReviewMode = false;
      // The replay is a contiguous prefix starting at line 1 (line 0 is the
      // child's own session_meta); it ends permanently at the first line not
      // found in the parent rollout, so a child's own message that happens
      // to match a parent payload is never dropped. user_message lines are
      // the one exception checked beyond the prefix: subagents have no
      // interactive user, so one matching a parent payload is an echo of the
      // spawning prompt (review children repeat it after their own
      // task_started).
      let inReplayPrefix = parentPayloads !== null;

      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let line: RolloutLine;
        try {
          line = JSON.parse(lines[i]) as RolloutLine;
        } catch {
          continue;
        }
        const payload = line.payload;

        if (payload && parentPayloads && i > 0) {
          const isUserEcho = line.type === "event_msg" && payload.type === "user_message";
          if (
            (inReplayPrefix || isUserEcho) &&
            parentPayloads.has(JSON.stringify(payload))
          ) {
            stats.replayLinesSkipped++;
            continue;
          }
          inReplayPrefix = false;
        }
        const lastPayload = prevPayload;
        prevPayload = payload ?? prevPayload;

        if (line.type === "turn_context") {
          currentModel = str(payload?.model) ?? currentModel;
          continue;
        }
        if (!payload || !line.timestamp) continue;

        if (line.type === "response_item") {
          const payloadType = payload.type;
          if (payloadType === "function_call") {
            const callId = str(payload.call_id);
            const name = str(payload.name);
            if (callId && name) {
              pendingCalls.set(callId, {
                line: i,
                timestamp: line.timestamp,
                model: currentModel,
                name,
                arguments: str(payload.arguments),
              });
            }
          } else if (payloadType === "function_call_output") {
            const callId = str(payload.call_id);
            const pending = callId ? pendingCalls.get(callId) : undefined;
            if (callId && pending) {
              pendingCalls.delete(callId);
              emitToolCall(pending, callId, str(payload.output) ?? "");
            }
          } else if (payloadType === "custom_tool_call") {
            // apply_patch envelopes split into per-file blocks; their paired
            // custom_tool_call_output only restates the file list, so it
            // isn't tracked. Code-mode exec scripts (CLI 0.144.0+) wait for
            // their output instead.
            const callId = str(payload.call_id) ?? `ctc-${i}`;
            const input = str(payload.input);
            if (payload.name === "apply_patch" && input) {
              emitEvent(i, line.timestamp, false, currentModel, "", {
                call_id: callId,
                tool: "apply_patch",
                content: applyPatchToBlocks(input, callId),
              }, "toolCalls");
            } else if (payload.name === "exec" && input) {
              pendingExecCalls.set(callId, {
                line: i,
                timestamp: line.timestamp,
                model: currentModel,
                name: "exec",
                arguments: input,
              });
            }
          } else if (payloadType === "custom_tool_call_output") {
            const callId = str(payload.call_id);
            const pending = callId ? pendingExecCalls.get(callId) : undefined;
            if (callId && pending) {
              pendingExecCalls.delete(callId);
              emitExecCall(pending, callId, customToolCallOutputText(payload.output) ?? "");
            }
          } else if (payloadType === "web_search_call") {
            const action = asRecord(payload.action);
            const query = str(action?.query);
            const blocks: ContentBlock[] = [
              {
                type: "tool_use",
                name: "WebSearch",
                id: str(payload.id) ?? `ws-${i}`,
                input: query ? { query } : undefined,
              },
            ];
            emitEvent(i, line.timestamp, false, currentModel, "", {
              tool: "web_search",
              content: blocks,
            }, "toolCalls");
          } else if (payloadType === "reasoning") {
            const blocks = reasoningToBlocks(payload);
            if (blocks.length > 0) {
              emitEvent(i, line.timestamp, false, currentModel, "", {
                content: blocks,
              }, "reasoning");
            }
          }
          continue;
        }

        if (line.type !== "event_msg") continue;
        const payloadType = payload.type;
        if (payloadType === "token_count") {
          addTokenCount(asRecord(payload.info));
          continue;
        }
        if (payloadType === "entered_review_mode") {
          inReviewMode = true;
          continue;
        }
        if (payloadType === "exited_review_mode") {
          inReviewMode = false;
          continue;
        }
        if (payloadType !== "user_message" && payloadType !== "agent_message") {
          continue;
        }

        // Entering review mode writes the review prompt twice on adjacent
        // lines; keep only the first copy.
        if (
          inReviewMode &&
          payloadType === "user_message" &&
          lastPayload?.type === "user_message" &&
          JSON.stringify(lastPayload) === JSON.stringify(payload)
        ) {
          stats.skipped++;
          continue;
        }

        const message = str(payload.message);
        const images = Array.isArray(payload.images) ? payload.images : [];
        if (!message && images.length === 0) {
          stats.skipped++;
          continue;
        }

        // Attached images arrive as base64 data URLs. Keep raw_data content
        // blocks metadata-only; stored attachments carry the bytes.
        let blocks: ContentBlock[] | undefined;
        const imageDataUrls: CodexImageDataUrl[] = [];
        if (images.length > 0) {
          blocks = message ? [{ type: "text", text: message }] : [];
          for (const image of images) {
            const mime = typeof image === "string" ? image.match(/^data:([^;,]+)/) : null;
            const blockIndex = blocks.length;
            const mediaType = mime?.[1] ?? undefined;
            blocks.push({ type: "image", media_type: mediaType });
            if (typeof image === "string") {
              imageDataUrls.push({ blockIndex, dataUrl: image, mediaType });
            }
          }
        }

        const isUser = payloadType === "user_message";
        const usage = isUser ? undefined : pendingUsage ?? undefined;
        const written = emitEvent(i, line.timestamp, isUser, currentModel, message ?? "", {
          phase: isUser ? undefined : str(payload.phase),
          images: images.length > 0 ? images.length : undefined,
          usage,
          content: blocks,
        }, "messages");
        if (usage) pendingUsage = null;
        if (
          written.eventId !== null &&
          written.outcome !== "skipped" &&
          imageDataUrls.length > 0
        ) {
          const attachments = await storeCodexImageAttachments({
            images: imageDataUrls,
            sourceAccount,
            sessionId: sessionMeta.sessionId,
            eventSourceId: written.sourceId,
          });
          for (const attachment of attachments) {
            insertStoredAttachment(db, {
              eventId: written.eventId,
              source: "codex",
              sourceId: attachment.sourceId,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              width: attachment.width,
              height: attachment.height,
            }, attachment.stored);
          }
        }
      }

      // Calls that never got an output (session interrupted): keep the
      // tool_use so the conversation still shows what was attempted.
      for (const [callId, pending] of pendingCalls) {
        emitToolCall(pending, callId, undefined);
      }
      for (const [callId, pending] of pendingExecCalls) {
        emitExecCall(pending, callId, undefined);
      }

      if (sessionHasMessages) {
        stats.sessions++;
        if (stats.sessions % 100 === 0) {
          console.log(
            `  Processed ${stats.sessions} sessions, ${stats.messages.toLocaleString()} messages...`
          );
        }
      }
    }

    if (!dryRun) db.run("COMMIT");
  } catch (error) {
    if (!dryRun) db.run("ROLLBACK");
    throw error;
  }

  if (!dryRun && identities.size > 0) {
    upsertIdentities(db, [...identities.values()]);
    stats.identitiesUpserted = identities.size;
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log("Import complete:");
  console.log(`  Sessions: ${stats.sessions}`);
  console.log(`  Messages: ${stats.messages.toLocaleString()}`);
  console.log(`  Tool calls: ${stats.toolCalls.toLocaleString()}`);
  console.log(`  Reasoning: ${stats.reasoning.toLocaleString()}`);
  if (refreshRawData) {
    console.log(`  Refreshed: ${stats.refreshed.toLocaleString()}`);
  }
  console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Skipped: ${stats.skipped.toLocaleString()}`);
  console.log(`  Skipped replayed subagent lines: ${stats.replayLinesSkipped.toLocaleString()}`);
  console.log(`  Skipped T3 Code sessions: ${stats.skippedT3Sessions}`);
  console.log(`  Batch ID: ${importBatch}`);

  if (!dryRun) onImportComplete(db);

  return stats;
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const refreshRawData = args.includes("--refresh-raw-data");
  const positional = args.filter((a) => !a.startsWith("--"));

  const sessionsDir = positional[0]
    ? positional[0].startsWith("~")
      ? positional[0].replace("~", process.env.HOME || "")
      : positional[0]
    : DEFAULT_CODEX_SESSIONS_DIR;
  const accountName = positional[1] || "default";

  if (!existsSync(sessionsDir)) {
    console.error(`Codex sessions directory not found at: ${sessionsDir}`);
    process.exit(1);
  }

  console.log(`Importing Codex sessions from ${sessionsDir}`);
  console.log(`Account: ${accountName}`);
  if (dryRun) {
    console.log("DRY RUN - No changes will be made");
  }
  if (refreshRawData) {
    console.log("Refresh mode: existing rows will have content + raw_data rewritten");
  }
  console.log();

  let db: ReturnType<typeof getDb> | null = null;
  if (!dryRun) {
    db = getDb();
    initDb(db);
  }

  const stats = await importCodex(
    db as ReturnType<typeof getDb>,
    sessionsDir,
    accountName,
    { dryRun, refreshRawData }
  );

  if (db) {
    db.close();
  }

  process.exit(stats.messages + stats.toolCalls + stats.reasoning > 0 || dryRun ? 0 : 1);
}
