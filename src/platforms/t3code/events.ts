/**
 * Event shape shared by the T3 Code store readers: the v1 projection tables
 * (`state.sqlite`) and orchestration v2 (`statev2.sqlite`, used by current
 * T3 Code and its styal fork). Readers plan events; `importT3Code` writes
 * them, so dedup, identities, and attachment storage stay in one place.
 */

export type PlannedT3EventKind = "message" | "tool_call" | "plan" | "reasoning";

export interface PlannedT3Event {
  kind: PlannedT3EventKind;
  sourceId: string;
  role: "user" | "assistant";
  timestamp: string;
  title: string;
  content: string;
  /** Model that produced the event; keys the assistant identity. */
  model: string | null;
  tags: string[];
  /** Persisted as raw_data; `thread_id` is the conversation id. */
  raw: Record<string, unknown> & { thread_id: string };
  /** Image attachments to store, keyed by the T3 message that carries them. */
  attachments?: { messageId: string; items: unknown[] };
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function t3EventTitle(projectTitle: string | null, threadTitle: string | null): string {
  return [projectTitle, threadTitle].filter(Boolean).join(": ") || "T3 Code Chat";
}

export function t3EventTags(context: {
  projectTitle: string | null;
  model: string | null;
  provider: string | null;
  branch: string | null;
}): string[] {
  return [
    "editor:t3code",
    context.projectTitle && `project:${context.projectTitle}`,
    context.model && `model:${context.model}`,
    context.provider && `provider:${context.provider}`,
    context.branch && `branch:${context.branch}`,
  ].filter((t): t is string => Boolean(t));
}
