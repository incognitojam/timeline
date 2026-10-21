import { A, useNavigate } from "@solidjs/router";
import { useQueryClient } from "@tanstack/solid-query";
import { createMemo, createSignal, Show } from "solid-js";
import { type Attachment, type ConversationServerBreadcrumb, createTimelineEventCursor } from "../../lib/api";
import {
  CONVERSATION_AUTO_REFETCH_INTERVAL_MS,
  computeSenderHeaderIds,
  type ReplyTarget,
  reverseEventsChronologically,
} from "../../lib/conversation";
import { createMessageScroller } from "../../lib/createMessageScroller";
import { navigateToIdentity, populateCacheFromParticipants } from "../../lib/identities";
import { queryOptions } from "../../lib/queries";
import { buildConversationUrl, buildDiscordServerUrl } from "../../lib/routes";
import type { TimelineConversationPane, TimelineEvent } from "../../lib/types";
import { IconArrowDownward, IconClose, IconOpenInNew } from "../../ui/icons";
import { ConversationMessage } from "../conversation/ConversationMessage";
import { ConversationTranscript } from "../conversation/ConversationTranscript";

interface Props {
  pane: TimelineConversationPane;
  onClose: () => void;
}

export default function ConversationPane(props: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [attachments, setAttachments] = createSignal<Record<string, Attachment[]>>({});
  const [server, setServer] = createSignal<ConversationServerBreadcrumb | null>(null);
  const [highlightedEventId, setHighlightedEventId] = createSignal<number | null>(null);

  // Handle clicking on a person's name
  const handlePersonClick = async (identifier: string, e: MouseEvent) => {
    e.stopPropagation();
    await navigateToIdentity(navigate, identifier, props.pane.conversationSource);
  };

  const mergeAttachments = (next: Record<string, Attachment[]> | undefined) => {
    setAttachments((prev) => ({ ...prev, ...(next ?? {}) }));
  };
  const paneKey = () => props.pane.id;

  const loadAfterPage = async (cursor: string, staleTime?: number) => {
    const key = paneKey();
    const options = queryOptions.conversationPage({
      conversationId: props.pane.conversationId,
      source: props.pane.conversationSource,
      sourceAccount: props.pane.conversationSourceAccount,
      limit: 50,
      cursor,
      order: "asc",
    });
    const data = await queryClient.fetchQuery(
      staleTime === undefined ? options : { ...options, staleTime },
    );
    if (key === paneKey()) {
      populateCacheFromParticipants(data.participants);
      mergeAttachments(data.attachments as Record<string, Attachment[]>);
    }
    return {
      items: data.events as TimelineEvent[],
      hasMore: !!data.nextCursor,
      nextCursor: data.nextCursor,
    };
  };

  const scroller = createMessageScroller<TimelineEvent>({
    key: paneKey,
    loadInitial: async () => {
      const key = paneKey();
      setAttachments({});
      setServer(null);

      // With a focus event, load a window centered on it; otherwise the
      // conversation opens at its start (oldest messages first).
      if (props.pane.focusEventId) {
        const data = await queryClient.fetchQuery(queryOptions.conversationAround({
          conversationId: props.pane.conversationId,
          source: props.pane.conversationSource,
          sourceAccount: props.pane.conversationSourceAccount,
          eventId: props.pane.focusEventId,
          before: 50,
          after: 50,
        }));
        if (key === paneKey()) {
          populateCacheFromParticipants(data.participants);
          setAttachments((data.attachments as Record<string, Attachment[]>) || {});
          setServer(data.server ?? null);
        }
        return {
          items: data.events as TimelineEvent[],
          hasBefore: data.hasBefore,
          hasAfter: data.hasAfter,
          beforeCursor: data.beforeCursor,
          afterCursor: data.afterCursor,
        };
      }

      const data = await queryClient.fetchQuery(queryOptions.conversationPage({
        conversationId: props.pane.conversationId,
        source: props.pane.conversationSource,
        sourceAccount: props.pane.conversationSourceAccount,
        limit: 100,
        order: "asc",
      }));
      if (key === paneKey()) {
        populateCacheFromParticipants(data.participants);
        setAttachments((data.attachments as Record<string, Attachment[]>) || {});
        setServer(data.server ?? null);
      }
      return {
        items: data.events as TimelineEvent[],
        hasBefore: false,
        hasAfter: !!data.nextCursor,
        beforeCursor: null,
        afterCursor: data.nextCursor,
      };
    },
    loadBefore: async (cursor) => {
      const key = paneKey();
      const data = await queryClient.fetchQuery(queryOptions.conversationPage({
        conversationId: props.pane.conversationId,
        source: props.pane.conversationSource,
        sourceAccount: props.pane.conversationSourceAccount,
        limit: 50,
        cursor,
        order: "desc",
      }));
      if (key === paneKey()) {
        populateCacheFromParticipants(data.participants);
        mergeAttachments(data.attachments as Record<string, Attachment[]>);
      }
      return {
        items: reverseEventsChronologically(data.events),
        hasMore: !!data.nextCursor,
        nextCursor: data.nextCursor,
      };
    },
    loadAfter: (cursor) => loadAfterPage(cursor),
    onInitialLoad: (s) => {
      const target = props.pane.focusEventId;
      if (!target) return;
      if (!s.scrollToMessage(target)) return;
      setHighlightedEventId(target);
      setTimeout(() => {
        setHighlightedEventId((current) => (current === target ? null : current));
      }, 1500);
    },
    messageElementId: (id) => `event-${id}`,
    autoRefetch: {
      intervalMs: CONVERSATION_AUTO_REFETCH_INTERVAL_MS,
      getCursor: createTimelineEventCursor,
      loadAfter: (cursor) => loadAfterPage(cursor, 0),
    },
  });

  // Jump to a replied-to message within this pane, reusing the deep-link
  // highlight ring. Returns false when the target isn't loaded, so the reply
  // preview falls through to its href — the full conversation page, which
  // loads a window centered on the target and highlights it (fresh mount).
  const jumpToRepliedMessage = (reply: ReplyTarget): boolean => {
    const eventId = reply.eventId;
    if (eventId === null) return false;
    if (!scroller.scrollToMessage(eventId, "smooth")) return false;
    setHighlightedEventId(eventId);
    setTimeout(() => {
      setHighlightedEventId((current) => (current === eventId ? null : current));
    }, 1500);
    return true;
  };

  const senderHeaderIds = createMemo(() => computeSenderHeaderIds(scroller.items()));

  return (
    <div class="relative h-full flex flex-col">
      {/* Header */}
      <div class="border-b border-border bg-card px-3 py-2 flex items-center justify-between shrink-0">
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-medium truncate">{props.pane.conversationTitle}</h3>
          <p class="text-xs text-muted-foreground truncate">
            <span>{props.pane.conversationSource}</span>
            <Show when={server()}>
              {(srv) => (
                <>
                  <span aria-hidden="true"> / </span>
                  <A
                    href={buildDiscordServerUrl(srv().id)}
                    class="hover:text-foreground hover:underline"
                    title={srv().name ? `Open ${srv().name}` : "Open server"}
                  >
                    {srv().name ?? "Server"}
                  </A>
                </>
              )}
            </Show>
          </p>
        </div>
        <div class="flex items-center shrink-0 ml-2">
          <A
            href={buildConversationUrl(props.pane.conversationSource, props.pane.conversationId, props.pane.focusEventId)}
            class="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="Open full conversation"
          >
            <IconOpenInNew class="w-4 h-4" />
          </A>
          <button
            class="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            onClick={props.onClose}
            title="Close pane"
          >
            <IconClose class="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div
        ref={scroller.viewportRef}
        class="flex-1 overflow-auto"
      >
        <Show when={scroller.error()}>
          <div class="text-center py-4 px-2 text-red-500 text-sm">Error: {scroller.error()}</div>
        </Show>

        <Show when={scroller.isLoading()}>
          <div class="text-center py-4 px-2 text-muted-foreground text-sm">Loading...</div>
        </Show>

        <Show when={!scroller.isLoading() && scroller.items().length > 0}>
          {/* Top sentinel */}
          <div ref={scroller.topSentinelRef} class="h-1" />

          <Show when={scroller.isLoadingBefore()}>
            <div class="text-center py-2 px-2 text-muted-foreground text-xs">
              Loading older messages...
            </div>
          </Show>

          <Show when={!scroller.hasBefore() && !scroller.isLoadingBefore()}>
            <div class="text-center py-2 px-2 text-muted-foreground text-xs">
              Beginning of conversation
            </div>
          </Show>

          <ConversationTranscript
            events={scroller.items()}
            density="compact"
            renderMessage={(event) => (
              <ConversationMessage
                event={event}
                conversationSource={props.pane.conversationSource}
                attachments={attachments()[event.id] || []}
                showSenderHeader={senderHeaderIds().has(event.id)}
                density="compact"
                highlighted={highlightedEventId() === event.id}
                onPersonClick={handlePersonClick}
                onReplyJump={jumpToRepliedMessage}
              />
            )}
          />

          {/* Bottom sentinel */}
          <div ref={scroller.bottomSentinelRef} class="h-1" />

          <Show when={scroller.isLoadingAfter()}>
            <div class="text-center py-2 px-2 text-muted-foreground text-xs">
              Loading newer messages...
            </div>
          </Show>

          <Show when={!scroller.hasAfter() && !scroller.isLoadingAfter()}>
            <div class="text-center py-2 px-2 text-muted-foreground text-xs">
              End of conversation
            </div>
          </Show>
        </Show>

        <Show when={!scroller.isLoading() && scroller.items().length === 0 && !scroller.error()}>
          <div class="text-center py-4 px-2 text-muted-foreground text-sm">
            No messages found
          </div>
        </Show>
      </div>

      {/* Jump-to-latest control — shown when the reader has scrolled up off
          the live edge. Gated on !hasAfter(): scrollToEnd only reaches the
          bottom of the loaded window, so when newer pages are still unloaded
          it wouldn't actually reach the latest message. */}
      <Show when={!scroller.isLoading() && scroller.items().length > 0 && !scroller.isAtEnd() && !scroller.hasAfter()}>
        <button
          class="absolute bottom-3 right-3 z-20 flex items-center justify-center w-8 h-8 rounded-full bg-card shadow-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          onClick={() => scroller.scrollToEnd("smooth")}
          title="Jump to latest"
          aria-label="Jump to latest messages"
        >
          <IconArrowDownward class="w-4 h-4" />
        </button>
      </Show>
    </div>
  );
}
