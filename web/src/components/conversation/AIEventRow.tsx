import { createMemo, For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { extractAIMeta, parseAIContent } from "../../lib/ai-events";
import type { Attachment } from "../../lib/api";
import type { ContentBlock } from "../../lib/content-blocks";
import { getRangeSelectionHighlightClass, type RangeVisualPosition } from "../../lib/conversation-range-selection";
import { formatTime, getFileIcon } from "../../lib/format";
import { getSenderFromEvent, getSenderIdentifier } from "../../lib/identities";
import { splitInlineImages } from "../../lib/inline-images";
import type { TimelineEvent } from "../../lib/types";
import AttachmentPreview from "../AttachmentPreview";
import { AIMessageContent } from "./AIMessageContent";
import { EventLink } from "./EventLink";

interface ClaudeAttachment {
  file_name: string;
}

function getClaudeAttachments(event: TimelineEvent): ClaudeAttachment[] | null {
  if (event.source !== "claude" || !event.raw_data) return null;
  try {
    const raw = JSON.parse(event.raw_data);
    const collected: ClaudeAttachment[] = [];
    for (const key of ["attachments", "files"] as const) {
      const arr = raw[key];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        const name =
          entry && typeof entry === "object" && typeof entry.file_name === "string"
            ? entry.file_name
            : null;
        if (name) collected.push({ file_name: name });
      }
    }
    return collected.length > 0 ? collected : null;
  } catch {
    return null;
  }
}

function formatTimestamp(ts: string | Date | null): string {
  if (!ts) return "";
  const date = ts instanceof Date ? ts : new Date(ts);
  return date.toLocaleString();
}

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString();
}

export interface AIEventRowProps {
  event: TimelineEvent;
  // True for the first event in a contiguous run of same-sender messages.
  // Shows a compact sender label with a hover tooltip surfacing agent/model
  // metadata. Subsequent events in the run skip the label so a single
  // assistant turn reads as one continuous flow.
  showSenderHeader: boolean;
  isTargetEvent: boolean;
  rangeVisualPosition?: RangeVisualPosition;
  conversationSource: string;
  conversationTitle: string;
  attachments?: Attachment[];
  resolveToolResult: (id: string) => ContentBlock | undefined;
  onPersonClick: (identifier: string, e: MouseEvent) => void;
}

export function AIEventRow(props: AIEventRowProps): JSX.Element {
  const sender = () => getSenderFromEvent(props.event);
  const senderIdent = () => getSenderIdentifier(props.event);
  const isUser = () => props.event.type.endsWith(":user");
  const meta = () => extractAIMeta(props.event);
  const blocks = createMemo(() => parseAIContent(props.event));
  // Top-level image blocks with a stored image attachment render inline; the
  // rest (nested tool_result images, non-image files) stay in the trailing group.
  const attachmentSplit = createMemo(() =>
    splitInlineImages(blocks(), props.attachments ?? [])
  );
  const claudeAttachments = () => getClaudeAttachments(props.event);
  const rangeClass = () => getRangeClass(props.rangeVisualPosition);

  return (
    <div
      id={`event-${props.event.id}`}
      class={`relative pl-3 transition-colors ${
        props.showSenderHeader ? "pt-3" : ""
      } ${
        props.isTargetEvent
          ? "my-1 bg-accent/60 ring-1 ring-inset ring-ring rounded-sm"
          : rangeClass()
            ? rangeClass()
          : isUser()
            ? "my-1 border-l-2 border-primary/60"
            : "my-1 border-l-2 border-border/40"
      }`}
    >
      <Show when={props.showSenderHeader}>
        <div class="flex items-baseline gap-2 flex-wrap mb-1">
          <Show when={sender() && senderIdent()}>
            {(ident) => (
              <button
                type="button"
                class={`text-sm cursor-pointer hover:text-foreground ${
                  isUser() ? "font-semibold text-foreground" : "font-medium text-muted-foreground"
                }`}
                onClick={(e) => props.onPersonClick(ident(), e)}
                title={tooltipFor(props.event, sender())}
              >
                {sender()}
              </button>
            )}
          </Show>
          <Show
            when={props.event.conversation_id}
            fallback={<span class="text-xs text-muted-foreground/70">{formatTime(props.event.timestamp)}</span>}
          >
            {(conversationId) => (
              <EventLink
                eventId={props.event.id}
                source={props.conversationSource}
                conversationId={conversationId()}
                class="text-xs text-muted-foreground/70"
              >
                {formatTime(props.event.timestamp)}
              </EventLink>
            )}
          </Show>
          <Show when={!isUser() && meta()?.model}>
            {(model) => (
              <span class="text-xs text-muted-foreground/60 font-mono">
                {model()}
              </span>
            )}
          </Show>
        </div>
      </Show>
      <AIMessageContent
        blocks={blocks()}
        resolveToolResult={props.resolveToolResult}
        isUserMessage={isUser()}
        inlineImages={attachmentSplit().inline}
      />
      <AttachmentPreview attachments={attachmentSplit().trailing} />
      <Show when={claudeAttachments()}>
        {(attachs) => (
          <div class="flex flex-wrap gap-2 mt-1">
            <For each={attachs()}>
              {(attachment) => (
                <div class="flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted/50 border border-border/50 text-sm">
                  <Dynamic
                    component={getFileIcon(attachment.file_name)}
                    class="h-4 w-4 shrink-0"
                    aria-hidden
                  />
                  <span
                    class="truncate max-w-48 font-medium"
                    title={attachment.file_name}
                  >
                    {attachment.file_name}
                  </span>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}

function getRangeClass(position: RangeVisualPosition | undefined): string {
  return getRangeSelectionHighlightClass(position);
}

function tooltipFor(event: TimelineEvent, sender: string | null): string {
  const m = extractAIMeta(event);
  const parts: string[] = [];
  if (sender) parts.push(sender);
  if (event.timestamp) parts.push(formatTimestamp(event.timestamp));
  if (m?.model) parts.push(`model: ${m.model}`);
  if (m?.agent) parts.push(`agent: ${m.agent}`);
  if (m?.mode) parts.push(`mode: ${m.mode}`);
  if (m?.gitBranch) parts.push(`branch: ${m.gitBranch}`);
  if (m?.inputTokens !== null && m?.inputTokens !== undefined) {
    parts.push(
      `tokens: ${formatNumber(m.inputTokens)} in / ${formatNumber(m.outputTokens)} out`
    );
  }
  if (m?.cost !== null && m?.cost !== undefined) {
    parts.push(`cost: $${m.cost.toFixed(4)}`);
  }
  return parts.join("\n");
}
