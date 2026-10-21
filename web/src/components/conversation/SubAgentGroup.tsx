import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { extractAIMeta, parseAIContent } from "../../lib/ai-events";
import type { Attachment } from "../../lib/api";
import type { ContentBlock } from "../../lib/content-blocks";
import type { KeyedRecord } from "../../lib/createKeyedRecords";
import { formatTime } from "../../lib/format";
import { getSenderFromEvent, getSenderIdentifier } from "../../lib/identities";
import { splitInlineImages } from "../../lib/inline-images";
import type { TimelineEvent } from "../../lib/types";
import { IconChevronRight } from "../../ui/icons";
import AttachmentPreview from "../AttachmentPreview";
import { AIMessageContent } from "./AIMessageContent";
import { EventLink } from "./EventLink";

const MAX_NEST_DEPTH = 5;

export interface SubagentGroup {
  parentToolUseId: string;
  events: TimelineEvent[];
  subagentType: string | null;
  parentEventId: number | null;
}

type SubagentGroupRecord = KeyedRecord<string, SubagentGroup>;

export interface SubAgentGroupProps {
  group: SubagentGroup;
  resolveToolResult: (id: string) => ContentBlock | undefined;
  // Computes the initial expanded state for a given group. Used both for
  // this group and recursively for any nested groups so a deep-linked URL
  // anchor expands every ancestor on the chain.
  defaultExpandedFor: (group: SubagentGroup) => boolean;
  // The event id currently targeted by the URL anchor (#event-X), or
  // undefined when there is no anchor. Forwarded to nested groups and used
  // by SubAgentMessageRow to apply the highlight ring on the matching row.
  highlightEventId: () => number | undefined;
  nestedGroupRecordsFor: (eventId: number) => SubagentGroupRecord[];
  conversationSource: string;
  conversationTitle: string;
  attachmentsForEvent: (eventId: number) => Attachment[];
  depth?: number;
}

function getSenderHeaderIds(events: readonly TimelineEvent[]): Set<number> {
  const ids = new Set<number>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const previous = index > 0 ? events[index - 1] : null;
    if (
      !previous ||
      getSenderIdentifier(event) !== getSenderIdentifier(previous)
    ) {
      ids.add(event.id);
    }
  }
  return ids;
}

export function SubAgentGroup(props: SubAgentGroupProps): JSX.Element {
  const [expanded, setExpanded] = createSignal(props.defaultExpandedFor(props.group));
  const depth = () => props.depth ?? 0;

  const headerLabel = () => {
    const count = props.group.events.length;
    const verb = expanded() ? "Hide" : "Show";
    const noun = count === 1 ? "message" : "messages";
    return `${verb} ${count} ${noun} from sub-agent`;
  };

  // Same role-transition logic as the main flow — within a sub-agent's
  // transcript, suppress repeated "Claude Opus 4.6" headers so a long
  // sub-agent run reads as one continuous flow. Memoized so the scan runs
  // once per group render rather than once per event in the For callback.
  const senderHeaderIds = createMemo(() =>
    getSenderHeaderIds(props.group.events)
  );

  return (
    <div class="relative pl-3 my-2 border-l-2 border-indigo-400/70">
      <button
        type="button"
        class="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setExpanded(!expanded())}
      >
        <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 font-medium">
          {props.group.subagentType ?? "subagent"}
        </span>
        <span>{headerLabel()}</span>
        <Chevron direction={expanded() ? "down" : "right"} />
      </button>

      <Show when={expanded()}>
        <div class="mt-2 space-y-1">
          <For each={props.group.events}>
            {(event) => (
              <SubAgentMessageRow
                event={event}
                showSenderHeader={senderHeaderIds().has(event.id)}
                resolveToolResult={props.resolveToolResult}
                defaultExpandedFor={props.defaultExpandedFor}
                highlightEventId={props.highlightEventId}
                nestedGroupRecordsFor={props.nestedGroupRecordsFor}
                conversationSource={props.conversationSource}
                conversationTitle={props.conversationTitle}
                attachments={props.attachmentsForEvent(event.id)}
                attachmentsForEvent={props.attachmentsForEvent}
                depth={depth()}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

interface SubAgentMessageRowProps {
  event: TimelineEvent;
  showSenderHeader: boolean;
  resolveToolResult: (id: string) => ContentBlock | undefined;
  defaultExpandedFor: (group: SubagentGroup) => boolean;
  highlightEventId: () => number | undefined;
  nestedGroupRecordsFor: (eventId: number) => SubagentGroupRecord[];
  conversationSource: string;
  conversationTitle: string;
  attachments: Attachment[];
  attachmentsForEvent: (eventId: number) => Attachment[];
  depth: number;
}

function SubAgentMessageRow(props: SubAgentMessageRowProps): JSX.Element {
  const sender = () => getSenderFromEvent(props.event);
  const senderIdent = () => getSenderIdentifier(props.event);
  const meta = () => extractAIMeta(props.event);
  const blocks = createMemo(() => parseAIContent(props.event));
  const attachmentSplit = createMemo(() =>
    splitInlineImages(blocks(), props.attachments)
  );
  const nestedGroupRecords = () => props.nestedGroupRecordsFor(props.event.id);
  const canNest = () => props.depth < MAX_NEST_DEPTH;
  const isTarget = () => props.highlightEventId() === props.event.id;
  const isUser = () => props.event.type.endsWith(":user");

  return (
    <>
      <div
        id={`event-${props.event.id}`}
        class={`relative pl-3 transition-colors ${
          props.showSenderHeader ? "pt-2" : ""
        } ${
          isTarget()
            ? "bg-accent/60 ring-1 ring-inset ring-ring rounded-sm"
            : isUser()
              ? "border-l-2 border-primary/60"
              : "border-l-2 border-border/30"
        }`}
      >
        <Show when={props.showSenderHeader}>
          <div class="flex items-baseline gap-2 flex-wrap mb-0.5">
            <Show when={sender() && senderIdent()}>
              <span
                class={`text-sm ${
                  isUser() ? "font-semibold text-foreground" : "font-medium text-muted-foreground"
                }`}
                title={subAgentTooltip(props.event, sender())}
              >
                {sender()}
              </span>
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
            <Show when={meta()?.model}>
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
      </div>

      <Show when={nestedGroupRecords().length > 0}>
        <Show
          when={canNest()}
          fallback={
            <DeepNestedFlat
              groupRecords={nestedGroupRecords()}
              resolveToolResult={props.resolveToolResult}
              highlightEventId={props.highlightEventId}
              nestedGroupRecordsFor={props.nestedGroupRecordsFor}
              conversationSource={props.conversationSource}
              conversationTitle={props.conversationTitle}
              attachmentsForEvent={props.attachmentsForEvent}
            />
          }
        >
          <For each={nestedGroupRecords()}>
            {(record) => (
              <SubAgentGroup
                group={record.value()}
                resolveToolResult={props.resolveToolResult}
                defaultExpandedFor={props.defaultExpandedFor}
                highlightEventId={props.highlightEventId}
                nestedGroupRecordsFor={props.nestedGroupRecordsFor}
                conversationSource={props.conversationSource}
                conversationTitle={props.conversationTitle}
                attachmentsForEvent={props.attachmentsForEvent}
                depth={props.depth + 1}
              />
            )}
          </For>
        </Show>
      </Show>
    </>
  );
}

// When the nesting cap is hit, gather every event from the dropped groups
// (and their transitive descendants) and render them as flat message rows.
// Without this, ConversationView's subagentEventIds excludes these events
// from the main flow and they become unreachable in the UI.
interface DeepNestedFlatProps {
  groupRecords: SubagentGroupRecord[];
  resolveToolResult: (id: string) => ContentBlock | undefined;
  highlightEventId: () => number | undefined;
  nestedGroupRecordsFor: (eventId: number) => SubagentGroupRecord[];
  conversationSource: string;
  conversationTitle: string;
  attachmentsForEvent: (eventId: number) => Attachment[];
}

function DeepNestedFlat(props: DeepNestedFlatProps): JSX.Element {
  const flatEvents = createMemo(() => {
    const seen = new Set<number>();
    const out: TimelineEvent[] = [];
    const walk = (group: SubagentGroup) => {
      for (const ev of group.events) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        out.push(ev);
        for (const inner of props.nestedGroupRecordsFor(ev.id)) walk(inner.value());
      }
    };
    for (const record of props.groupRecords) walk(record.value());
    return out;
  });
  const senderHeaderIds = createMemo(() => getSenderHeaderIds(flatEvents()));
  return (
    <div class="relative pl-3 my-2 border-l-2 border-amber-400/60">
      <div class="text-sm text-muted-foreground italic mb-2">
        Nesting depth exceeded — showing {flatEvents().length} deeper sub-agent
        {flatEvents().length === 1 ? " message" : " messages"} flat
      </div>
      <div class="space-y-1">
        <For each={flatEvents()}>
          {(event) => (
            <SubAgentMessageRow
              event={event}
              showSenderHeader={senderHeaderIds().has(event.id)}
              resolveToolResult={props.resolveToolResult}
              defaultExpandedFor={() => false}
              highlightEventId={props.highlightEventId}
              nestedGroupRecordsFor={() => []}
              conversationSource={props.conversationSource}
              conversationTitle={props.conversationTitle}
              attachments={props.attachmentsForEvent(event.id)}
              attachmentsForEvent={props.attachmentsForEvent}
              depth={MAX_NEST_DEPTH}
            />
          )}
        </For>
      </div>
    </div>
  );
}

function subAgentTooltip(event: TimelineEvent, sender: string | null): string {
  const m = extractAIMeta(event);
  const parts: string[] = [];
  if (sender) parts.push(sender);
  if (event.timestamp) {
    const d = event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp);
    parts.push(d.toLocaleString());
  }
  if (m?.model) parts.push(`model: ${m.model}`);
  if (m?.agent) parts.push(`agent: ${m.agent}`);
  return parts.join("\n");
}

function Chevron(props: { direction: "right" | "down" }): JSX.Element {
  return (
    <IconChevronRight
      class={`w-3 h-3 transition-transform ${props.direction === "down" ? "rotate-90" : ""}`}
    />
  );
}
