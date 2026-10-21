import { Show, For, Match, Switch, createSignal, createEffect, createMemo } from "solid-js";
import type { Attachment } from "../../lib/api";
import type { TimelineEvent } from "../../lib/types";
import type { EventGroupData } from "@shared/grouping";
import { sourceLabel } from "@shared/sources";
import TimelineEventCard from "./TimelineEventCard";
import TransportCard from "./TransportCard";
import JournalCard from "./JournalCard";
import RecallCard from "./RecallCard";
import RecallSessionCard from "./RecallSessionCard";
import SleepCard from "./SleepCard";
import CheckinCard from "./CheckinCard";
import { isSleepEvent } from "../../lib/sleep";
import { getSourceColorStyle } from "../../lib/source-styles";
import SourceIcon from "../SourceIcon";
import { getSenderLabel, getDisplayName, getResolvedIdentity } from "../../lib/identities";
import { getSessionAlbumArts, getEventAlbumArt, isSpotifyEvent } from "../../lib/spotify-art";
import { formatDuration, formatTime } from "../../lib/format";
import { getConversationContent } from "../../lib/conversation";
import { discordMentionsToPlainText } from "../../lib/discord-mentions";
import { viewerTimeZone } from "../../lib/discord-timestamps";
import { IconChevronDown, IconGridView } from "../../ui/icons";

const discordUserResolver = (id: string) => getResolvedIdentity(`discord:${id}`)?.name ?? null;

interface Props {
  group: EventGroupData<TimelineEvent>;
  highlightEventId?: number;
  defaultExpanded?: boolean;
  trackImageMap?: Map<string, string>;
  attachmentsByEvent?: Record<number, Attachment[]>;
  onOpenConversation?: (event: TimelineEvent) => void;
  onOpenInWorkspace?: (event: TimelineEvent) => void;
  onPersonClick?: (name: string, source: string, e: MouseEvent) => void;
  onExpandedChange?: (groupId: string, expanded: boolean) => void;
  setEventRef?: (eventId: number, el: HTMLDivElement) => void;
  onEditEvent?: (event: TimelineEvent) => void;
  onDeleteEvent?: (event: TimelineEvent) => void;
  onToggleJournal?: () => void;
}

// Format time range
function formatTimeRange(start: string | null, end: string | null): string {
  if (!start) return "";
  const startTime = formatTime(start);
  if (!end || start === end) return startTime;
  const endTime = formatTime(end);
  // Collapse when the formatted labels match (check-ins seconds apart share a
  // HH:MM), not just when the raw timestamps are identical.
  if (startTime === endTime) return startTime;
  return `${startTime} - ${endTime}`;
}

/** Renders a grid of 1-4 album art images */
function AlbumArtGrid(props: { urls: string[] }) {
  return (
    <Show when={props.urls.length > 0}>
      <div
        class="shrink-0 rounded-sm overflow-hidden"
        style={{
          width: "44px",
          height: "44px",
          display: "grid",
          "grid-template-columns": props.urls.length === 1 ? "1fr" : "1fr 1fr",
          "grid-template-rows": props.urls.length <= 2 ? "1fr" : "1fr 1fr",
        }}
      >
        <For each={props.urls.slice(0, 4)}>
          {(url) => (
            <img
              src={url}
              alt=""
              class="w-full h-full object-cover"
              loading="lazy"
            />
          )}
        </For>
        {/* Fill empty cells in 2x2 grid when we have 3 images */}
        <Show when={props.urls.length === 3}>
          <div class="w-full h-full bg-muted" />
        </Show>
      </div>
    </Show>
  );
}

/** Picks the card a lone event renders as; most sources use the generic one. */
function SingleEventCard(props: Props & { event: TimelineEvent }) {
  const isHighlighted = () => props.event.id === props.highlightEventId;

  return (
    <div id={`event-${props.event.id}`} ref={(el) => props.setEventRef?.(props.event.id, el)}>
      <Switch
        fallback={
          <TimelineEventCard
            event={props.event}
            isHighlighted={isHighlighted()}
            trackImageMap={props.trackImageMap}
            onOpenConversation={props.onOpenConversation}
            onPersonClick={props.onPersonClick}
            onEditEvent={props.onEditEvent}
            onDeleteEvent={props.onDeleteEvent}
          />
        }
      >
        <Match when={isSleepEvent(props.event)}>
          <SleepCard event={props.event} isHighlighted={isHighlighted()} />
        </Match>
        <Match when={props.event.type.startsWith("transport:")}>
          <TransportCard
            event={props.event}
            isHighlighted={isHighlighted()}
            onEditEvent={props.onEditEvent}
            onDeleteEvent={props.onDeleteEvent}
          />
        </Match>
        <Match when={props.event.source === "recall"}>
          <RecallCard
            event={props.event}
            attachment={props.attachmentsByEvent?.[props.event.id]?.[0]}
            isHighlighted={isHighlighted()}
          />
        </Match>
      </Switch>
    </div>
  );
}

export default function EventGroup(props: Props) {
  const isConversation = () => props.group.type === "conversation";
  const participantNames = createMemo(() => (props.group.participants ?? []).map(getDisplayName));
  const participantsRepeatLabel = () => isConversation() && participantNames().join(", ") === props.group.label;

  // A count and a time range add nothing for a lone message.
  const isSingleMessage = () => isConversation() && props.group.events.length === 1;

  // Check if group contains highlighted event
  const containsHighlighted = () =>
    props.highlightEventId !== undefined &&
    props.group.events.some((e) => e.id === props.highlightEventId);

  // Auto-expand if highlighted event is in group (sessions only — conversations
  // open the dedicated pane on click, so inline expansion is not used).
  const [expanded, setExpanded] = createSignal(
    !isConversation() && (props.defaultExpanded ?? containsHighlighted())
  );

  // Update expansion when highlighted changes
  createEffect(() => {
    if (!isConversation() && containsHighlighted() && !expanded()) {
      setExpanded(true);
    }
  });

  const handleHeaderClick = () => {
    if (isConversation()) {
      props.onOpenInWorkspace?.(props.group.events[0]);
      return;
    }
    const newState = !expanded();
    setExpanded(newState);
    props.onExpandedChange?.(props.group.id, newState);
  };

  const isSpotifySession = () =>
    (props.group.source === "spotify" || props.group.source === "spotify-friends") &&
    props.group.type === "session";

  const sessionAlbumArts = () =>
    isSpotifySession()
      ? getSessionAlbumArts(props.group.events, 4, props.trackImageMap)
      : [];

  // Journal groups render as a single summary card that opens the journal pane
  if (props.group.source === "journal" && props.group.type === "session") {
    return (
      <JournalCard
        events={props.group.events}
        isHighlighted={containsHighlighted()}
        onToggleJournal={props.onToggleJournal}
      />
    );
  }

  // Recall sessions render as a thumbnail strip with collapsed OCR
  if (props.group.source === "recall" && props.group.type === "session") {
    return (
      <RecallSessionCard
        group={props.group}
        attachmentsByEvent={props.attachmentsByEvent ?? {}}
        isHighlighted={containsHighlighted()}
        setEventRef={props.setEventRef}
        highlightEventId={props.highlightEventId}
      />
    );
  }

  // Swarm check-ins render as a flat visit card (both merged sessions and
  // singles) — expandable child rows would just repeat the venue name.
  if (props.group.source === "swarm") {
    return (
      <CheckinCard
        group={props.group}
        highlightEventId={props.highlightEventId}
        setEventRef={props.setEventRef}
        onPersonClick={props.onPersonClick}
      />
    );
  }

  // For single events, just render the card
  if (props.group.type === "single") {
    return <SingleEventCard {...props} event={props.group.events[0]} />;
  }

  return (
    <div class="relative pl-8 pb-4">
      {/* Timeline spine */}
      <div class="absolute left-3 top-0 bottom-0 w-px bg-border timeline-spine" />

      {/* Group node */}
      <div
        class="absolute left-1 top-1 w-5 h-5 rounded-full flex items-center justify-center source-icon"
        style={getSourceColorStyle(props.group.source)}
      >
        <SourceIcon source={props.group.source} class="w-3 h-3" />
      </div>

      {/* Group card — elevated surface marks it as openable */}
      <div
        class={`rounded-lg bg-card transition-colors ${
          containsHighlighted() ? "ring-2 ring-ring" : ""
        }`}
      >
        {/* Header - always visible */}
        <button
          class="w-full p-3 flex items-start gap-2 hover:bg-accent/30 transition-colors rounded-t-lg text-left"
          onClick={handleHeaderClick}
        >
          {/* Time */}
          <span class="text-xs text-muted-foreground shrink-0 w-12 font-mono pt-0.5">
            {formatTime(props.group.timeRange.start)}
          </span>

          {/* Album art grid for spotify sessions */}
          <AlbumArtGrid urls={sessionAlbumArts()} />

          {/* Content */}
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-medium source-label" style={getSourceColorStyle(props.group.source)}>
                {sourceLabel(props.group.source)}
              </span>
              <span class="text-xs text-muted-foreground">
                {props.group.type === "conversation" ? props.group.type : props.group.summary}
                {/* For friends sources, add clickable participant name */}
                <Show when={props.group.source === "spotify-friends" && props.group.participants?.[0]}>
                  {" "}&bull;{" "}
                  <button
                    class="cursor-pointer hover:text-primary hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onPersonClick?.(props.group.participants?.[0] ?? "", props.group.source, e);
                    }}
                  >
                    {getDisplayName(props.group.participants?.[0] ?? "")}
                  </button>
                </Show>
              </span>
            </div>

            <p class="text-sm font-medium truncate">{props.group.label}</p>

            <Show when={!isSingleMessage()}>
              <div class="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                {(() => {
                  const items: string[] = [];
                  if (props.group.type === "conversation") items.push(props.group.summary);
                  if (props.group.totalDuration) items.push(formatDuration(props.group.totalDuration));
                  if (props.group.timeRange.start !== props.group.timeRange.end) {
                    items.push(formatTimeRange(props.group.timeRange.start, props.group.timeRange.end));
                  }
                  return items.join(" \u00b7 ");
                })()}
              </div>
            </Show>

            {/* Hide participants for friends sources since it's in the header */}
            <Show when={participantNames().length > 0 && !participantsRepeatLabel() && props.group.source !== "spotify-friends"}>
              <p class="text-xs text-muted-foreground mt-1">
                {participantNames().slice(0, 3).join(", ")}
                <Show when={participantNames().length > 3}>
                  <span> +{participantNames().length - 3}</span>
                </Show>
              </p>
            </Show>
          </div>

          {/* Trailing affordance: dropdown arrow for sessions, open-pane hint for conversations */}
          <div class="shrink-0 text-muted-foreground">
            <Show
              when={isConversation()}
              fallback={
                <IconChevronDown class={`w-4 h-4 transition-transform ${expanded() ? "rotate-180" : ""}`} />
              }
            >
              <IconGridView class="w-4 h-4" aria-label="Opens conversation pane" />
            </Show>
          </div>
        </button>

        {/* Expanded content */}
        <Show when={expanded()}>
          <div class="border-t border-border">
            <For each={props.group.events}>
              {(event) => {
                const trackArt = () =>
                  isSpotifyEvent(event)
                    ? getEventAlbumArt(event, props.trackImageMap)
                    : null;
                return (
                  <div
                    id={`event-${event.id}`}
                    ref={(el) => props.setEventRef?.(event.id, el)}
                    class="border-b border-border/50 last:border-b-0"
                  >
                    <div class="pl-14 pr-3 py-2">
                      <div class="flex items-start gap-2">
                        <span class="text-xs text-muted-foreground shrink-0 w-12 font-mono">
                          {formatTime(event.timestamp)}
                        </span>
                        <Show when={trackArt()}>
                          {(url) => (
                            <img
                              src={url()}
                              alt=""
                              class="w-7 h-7 rounded-xs shrink-0 object-cover"
                              loading="lazy"
                            />
                          )}
                        </Show>
                        <div class="flex-1 min-w-0">
                          {/* Don't show sender for friends sources - friend name is in header */}
                          <Show when={props.group.source !== "spotify-friends"}>
                            <Show when={getSenderLabel(event)}>
                              {(senderName) => (
                                <span class="text-xs text-muted-foreground">&lt;{senderName()}&gt; </span>
                              )}
                            </Show>
                          </Show>
                          <span
                            class={`text-sm ${event.id === props.highlightEventId ? "bg-yellow-500/20 px-1 rounded" : ""}`}
                          >
                            {(() => {
                              // Trakt sessions: title (movie/show name) is preferred over content (IMDB id).
                              if (props.group.source === "trakt") return event.title || event.content;
                              // YouTube: content is the channel name (already in the <sender> prefix); title is the video.
                              if (props.group.source === "youtube") return event.title || event.content;
                              const content = getConversationContent(event);
                              if (content) {
                                if (event.source === "discord") {
                                  return discordMentionsToPlainText(content, event.raw_data, { user: discordUserResolver }, { timeZone: viewerTimeZone() });
                                }
                                return content;
                              }
                              // Sessions and singles from non-message sources (chrome, youtube, etc.):
                              // title is genuinely meaningful when content is empty.
                              return event.title;
                            })()}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
