import { parseDiscordPoll } from "@shared/discord-forward";
import { For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Attachment } from "../../lib/api";
import {
  getConversationContent,
  getDiscordAttachments,
  getForwardedMessageSource,
  getMessageCallInfo,
  getMessageTypeInfo,
  getReactions,
  getReplyTarget,
  isDiscordForwardedEvent,
  isPlaceholderContent,
  type ReplyTarget,
} from "../../lib/conversation";
import {
  getRangeSelectionHighlightClass,
  type RangeVisualPosition,
} from "../../lib/conversation-range-selection";
import { formatTime } from "../../lib/format";
import {
  getAvatarUrl,
  getResolvedNameOr,
  getSenderFromEvent,
  getSenderIdentifier,
  resolveIdentifiers,
} from "../../lib/identities";
import type { TimelineEvent } from "../../lib/types";
import AttachmentPreview from "../AttachmentPreview";
import Avatar from "../Avatar";
import { DiscordAttachmentFallback } from "./DiscordAttachmentFallback";
import { DiscordContent } from "./DiscordContent";
import { DiscordEmbed, getDiscordEmbeds } from "./DiscordEmbed";
import { DiscordEmoji } from "./DiscordEmoji";
import { DiscordForwardedMessage } from "./DiscordForwardedMessage";
import { DiscordPoll } from "./DiscordPoll";
import { DiscordReplyPreview } from "./DiscordReplyPreview";
import { EditedBadge } from "./EditedBadge";
import { EventLink } from "./EventLink";
import { GroupedTimestampGutter } from "./GroupedTimestampGutter";
import {
  SourceDeletedBadge,
  sourceDeletedClass,
  sourceDeletedTitle,
} from "./SourceDeletedBadge";

export interface ConversationMessageProps {
  event: TimelineEvent;
  conversationSource: string;
  attachments: Attachment[];
  showSenderHeader: boolean;
  density: "full" | "compact";
  highlighted: boolean;
  rangeMode?: boolean;
  rangeVisualPosition?: RangeVisualPosition;
  onMessageClick?: (event: MouseEvent) => void;
  onPersonClick: (identifier: string, event: MouseEvent) => void;
  onReplyJump: (reply: ReplyTarget) => boolean;
}

interface ShareInfo {
  link: string | null;
  shareText: string | null;
}

function getShareInfo(event: TimelineEvent): ShareInfo | null {
  if (!event.raw_data || event.source !== "facebook" || !event.type.includes("share")) {
    return null;
  }
  try {
    const raw = JSON.parse(event.raw_data);
    if (!raw.share) return null;
    return {
      link: raw.share.link || null,
      shareText: raw.share.share_text || null,
    };
  } catch {
    return null;
  }
}

function formatCallDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  if (ms === 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function isEmojiOnly(content: string | null): boolean {
  if (!content) return false;
  const withoutEmojis = content
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/[\u200D\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, "") // emoji-guard-allow-data
    .replace(/\s/g, "");
  return withoutEmojis.length === 0 && content.trim().length > 0;
}

function rootClass(props: ConversationMessageProps): string {
  if (props.density === "compact") {
    return `group rounded ${
      props.showSenderHeader ? "mt-1 p-2" : "px-2 py-0.5"
    } hover:bg-accent/30 transition-all ${
      props.highlighted ? "ring-2 ring-inset ring-primary" : ""
    }`;
  }

  const surface = props.highlighted
    ? "bg-accent ring-2 ring-inset ring-ring"
    : props.rangeVisualPosition
      ? getRangeSelectionHighlightClass(props.rangeVisualPosition)
      : "my-1 rounded-lg hover:bg-accent/30";
  return `group ${props.showSenderHeader ? "p-3" : "px-3 py-0.5"} ${surface} ${
    props.rangeMode ? "cursor-crosshair" : ""
  } transition-colors`;
}

function reactionClass(props: ConversationMessageProps): string {
  if (props.density === "compact") {
    return "inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-xs";
  }
  if (!props.rangeVisualPosition) {
    return "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border/50 bg-muted/80 text-sm shadow-xs";
  }
  return "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-primary/20 bg-background/90 text-sm shadow-xs shadow-primary/10 ring-1 ring-background/80";
}

export function ConversationMessage(props: ConversationMessageProps): JSX.Element {
  const sender = () => getSenderFromEvent(props.event);
  const senderIdentifier = () => getSenderIdentifier(props.event);
  const typeInfo = () => getMessageTypeInfo(props.event);
  const shareInfo = () => getShareInfo(props.event);
  const reactions = () => getReactions(props.event);
  // Reactor names appear only in the tooltip, so they resolve when a reader
  // goes looking for them.
  const resolveReactors = () => {
    void resolveIdentifiers(
      (reactions() ?? [])
        .flatMap((reaction) => reaction.actors ?? [])
        .map((actor) => actor.identifier)
        .filter((identifier): identifier is string => identifier !== null),
    );
  };
  const callInfo = () => getMessageCallInfo(props.event);
  const duration = () => formatCallDuration(callInfo()?.durationMs);
  const messageContent = () => getConversationContent(props.event);
  const forwardedMessageSource = () => getForwardedMessageSource(props.event);
  const replyTarget = () => getReplyTarget(props.event);
  const discordAttachments = () => getDiscordAttachments(props.event);
  const discordEmbeds = () => getDiscordEmbeds(props.event);
  const discordPoll = () =>
    props.event.source === "discord" ? parseDiscordPoll(props.event.raw_data) : null;
  const pollHidesContent = () => {
    const poll = discordPoll();
    return poll !== null && props.event.content === poll.poll.question.text;
  };
  const compact = () => props.density === "compact";
  const contentIsPlaceholder = () =>
    compact()
      ? props.attachments.length > 0 &&
        isPlaceholderContent(messageContent(), props.event.type)
      : isPlaceholderContent(messageContent(), props.event.type, shareInfo()?.link);

  return (
    <div
      id={`event-${props.event.id}`}
      class={rootClass(props)}
      onClick={(event) => props.onMessageClick?.(event)}
    >
      <div class="flex items-start gap-2">
        <Show when={senderIdentifier()}>
          {(identifier) => (
            <Show
              when={props.showSenderHeader}
              fallback={
                <GroupedTimestampGutter
                  eventId={props.event.id}
                  source={props.conversationSource}
                  conversationId={props.event.conversation_id}
                  time={formatTime(props.event.timestamp)}
                />
              }
            >
              <Avatar
                url={getAvatarUrl(identifier())}
                name={sender() || "?"}
                size="sm"
                class="mt-0.5"
              />
            </Show>
          )}
        </Show>
        <div
          class={`flex-1 min-w-0${sourceDeletedClass(props.event)}`}
          title={sourceDeletedTitle(props.event)}
        >
          <Show when={props.showSenderHeader}>
            <div class="flex items-baseline gap-2 flex-wrap">
              <Show when={sender() && senderIdentifier()}>
                {(identifier) => (
                  <button
                    type="button"
                    class={`${compact() ? "text-xs" : "text-sm"} font-medium hover:text-primary hover:underline cursor-pointer`}
                    onClick={(event) => props.onPersonClick(identifier(), event)}
                  >
                    {sender()}
                  </button>
                )}
              </Show>
              <Show
                when={props.event.conversation_id}
                fallback={
                  <span class={`${compact() ? "text-xs" : "text-sm"} text-muted-foreground`}>
                    {formatTime(props.event.timestamp)}
                  </span>
                }
              >
                {(conversationId) => (
                  <EventLink
                    eventId={props.event.id}
                    source={props.conversationSource}
                    conversationId={conversationId()}
                    class={`${compact() ? "text-xs" : "text-sm"} text-muted-foreground`}
                  >
                    {formatTime(props.event.timestamp)}
                  </EventLink>
                )}
              </Show>
              <SourceDeletedBadge
                event={props.event}
                class={compact() ? "text-xs" : "text-sm"}
              />
              <Show when={typeInfo()}>
                {(info) => (
                  <span class={`${compact() ? "text-xs" : "text-sm"} flex items-center gap-1 ${info().className}`}>
                    <Dynamic component={info().icon} class="h-[1em] w-[1em] shrink-0" aria-hidden />
                    <span>{info().label}</span>
                    <Show when={callInfo()?.missed}>
                      <span class="text-red-400">(Missed)</span>
                    </Show>
                    <Show when={!callInfo()?.missed ? duration() : null}>
                      {(value) => <span class="text-muted-foreground">({value()})</span>}
                    </Show>
                  </span>
                )}
              </Show>
            </div>
          </Show>

          <Show when={replyTarget()}>
            {(reply) => (
              <DiscordReplyPreview reply={reply()} onJump={props.onReplyJump} />
            )}
          </Show>

          <DiscordForwardedMessage
            forwarded={isDiscordForwardedEvent(props.event)}
            source={forwardedMessageSource()}
          >
            <Show when={!contentIsPlaceholder() && !pollHidesContent() ? messageContent() : null}>
              {(content) => (
                <p
                  class={`${compact() ? "mt-0.5" : props.showSenderHeader ? "mt-1" : ""} whitespace-pre-wrap break-words ${
                    compact() ? "text-sm" : isEmojiOnly(content()) ? "text-4xl" : "text-base"
                  }`}
                >
                  <Show when={props.event.source === "discord"} fallback={content()}>
                    <DiscordContent content={content()} rawData={props.event.raw_data} />
                  </Show>
                  <EditedBadge event={props.event} class="ml-1" />
                </p>
              )}
            </Show>

            <Show when={discordPoll()}>
              {(poll) => (
                <div class={compact() ? "mt-1" : "mt-2"}>
                  <DiscordPoll parsedPoll={poll()} />
                </div>
              )}
            </Show>

            <Show when={shareInfo()}>
              {(share) => (
                <div class="mt-2 p-2 rounded bg-muted/50 border border-border/50 text-sm">
                  <Show when={share().shareText}>
                    {(text) => (
                      <p class="text-muted-foreground text-sm line-clamp-2 mb-1">{text()}</p>
                    )}
                  </Show>
                  <Show when={share().link}>
                    {(link) => (
                      <a
                        href={link()}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-sm text-primary hover:underline truncate block"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {link()}
                      </a>
                    )}
                  </Show>
                </div>
              )}
            </Show>

            <Show when={props.attachments.length > 0}>
              <AttachmentPreview attachments={props.attachments} />
            </Show>
            <Show when={props.attachments.length > 0 ? null : discordAttachments()}>
              {(attachments) => <DiscordAttachmentFallback attachments={attachments()} />}
            </Show>
            <Show when={discordEmbeds()}>
              {(embeds) => (
                <div class={`flex flex-col ${compact() ? "gap-1.5 mt-1" : "gap-2 mt-2"}`}>
                  <For each={embeds()}>
                    {(embed) => <DiscordEmbed embed={embed} />}
                  </For>
                </div>
              )}
            </Show>
          </DiscordForwardedMessage>

          <Show when={reactions()}>
            {(eventReactions) => (
              <div
                class={`flex flex-wrap ${compact() ? "gap-1 mt-1" : "gap-1.5 mt-2"}`}
                onMouseEnter={resolveReactors}
                onFocusIn={resolveReactors}
              >
                <For each={eventReactions()}>
                  {(reaction) => (
                    <span
                      class={reactionClass(props)}
                      title={reaction.actors
                        ?.map((actor) => getResolvedNameOr(actor.identifier, actor.name))
                        .join(", ")}
                    >
                      <Show
                        when={reaction.custom}
                        fallback={<span class={compact() ? "" : "text-lg"}>{reaction.emoji}</span>}
                      >
                        {(custom) => (
                          <DiscordEmoji
                            id={custom().id}
                            name={custom().name}
                            size="reaction"
                          />
                        )}
                      </Show>
                      <span class="text-muted-foreground">{reaction.count}</span>
                    </span>
                  )}
                </For>
              </div>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
