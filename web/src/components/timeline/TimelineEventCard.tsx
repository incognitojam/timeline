import { Show, For, createSignal, onCleanup, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { sourceLabel } from "@shared/sources";
import type { TimelineEvent } from "../../lib/types";
import { getSourceColorStyle } from "../../lib/source-styles";
import SourceIcon from "../SourceIcon";
import { getResolvedIdentity, getSenderFromEvent, getSenderIdentifier, getSenderLabel, getPeopleFromEvent } from "../../lib/identities";
import { getEventAlbumArt, isSpotifyEvent } from "../../lib/spotify-art";
import { formatDuration, formatTime } from "../../lib/format";
import { discordMentionsToPlainText } from "../../lib/discord-mentions";
import { viewerTimeZone } from "../../lib/discord-timestamps";
import { buildCodingProjectUrl } from "../../lib/routes";
import { describeTraktSource } from "../../lib/trakt-source";
import { IconDelete, IconEdit } from "../../ui/icons";

interface WakaTimeRawData {
  languages?: Record<string, number>;
  branches?: string[];
}

function parseWakaTimeRawData(raw: string): WakaTimeRawData | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WakaTimeRawData;
  } catch {
    return null;
  }
}

function extractWakaTimeProjectName(title: string | null): string | null {
  if (!title) return null;
  return title.match(/^(.+?)\s*\(/)?.[1] || title;
}

const MONZO_ACCOUNT_LABELS: Record<string, string> = {
  uk_retail: "Personal",
  uk_business: "Business",
  uk_monzo_flex: "Flex",
  uk_rewards: "Rewards",
};

function getMonzoAccountLabel(account: string | null): string | null {
  if (!account) return null;
  return MONZO_ACCOUNT_LABELS[account] ?? account;
}

const discordUserResolver = (id: string) => getResolvedIdentity(`discord:${id}`)?.name ?? null;

interface Props {
  event: TimelineEvent;
  isHighlighted?: boolean;
  trackImageMap?: Map<string, string>;
  onOpenConversation?: (event: TimelineEvent) => void;
  onPersonClick?: (name: string, source: string, e: MouseEvent) => void;
  onEditEvent?: (event: TimelineEvent) => void;
  onDeleteEvent?: (event: TimelineEvent) => void;
}

// Get sender display name from people JSON field (uses identity cache)
function getSender(event: TimelineEvent): string | null {
  return getSenderFromEvent(event);
}

// Format content for display, suppressing redundant patterns
function formatContent(event: TimelineEvent): string | null {
  if (event.source === "spotify-friends" && event.content) {
    const artistMatch = event.content.match(/by (.+?)(?:\s+from\s+|$)/);
    const albumMatch = event.content.match(/from (.+)$/);
    if (artistMatch && albumMatch) {
      return `${albumMatch[1]} by ${artistMatch[1]}`;
    }
  }
  // Steam sessions: content is "Played <game>" which is redundant with the title
  if (event.source === "steam" && event.type === "steam:session") {
    return null;
  }
  // YouTube: content is the channel name, already shown on the sender line
  if (event.source === "youtube") {
    return null;
  }
  // Discord encodes mentions as <@id>, <#id>, etc. — resolve to @name/#name
  // so condensed snippets are readable.
  if (event.source === "discord" && event.content) {
    return discordMentionsToPlainText(
      event.content,
      event.raw_data,
      { user: discordUserResolver },
      { timeZone: viewerTimeZone() },
    );
  }
  return event.content;
}

export default function TimelineEventCard(props: Props) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = createSignal(false);
  const sender = () => getSender(props.event);
  const senderLabel = () => getSenderLabel(props.event);
  const senderIdentifier = () => getSenderIdentifier(props.event);
  const people = () => getPeopleFromEvent(props.event);
  const isMessage = () => props.event.type.startsWith("message");
  const isWakaTimeSession = () =>
    props.event.source === "wakatime" && props.event.type === "code:session";
  const wakaTimeRaw = () =>
    isWakaTimeSession() ? parseWakaTimeRawData(props.event.raw_data) : null;
  const wakaTimeProjectName = () => extractWakaTimeProjectName(props.event.title);
  const wakaTimeLanguages = () => {
    const raw = wakaTimeRaw();
    if (!raw?.languages) return [];
    return Object.entries(raw.languages)
      .sort(([, a], [, b]) => b - a)
      .map(([lang]) => lang);
  };
  const wakaTimeBranches = () => {
    const raw = wakaTimeRaw();
    return Array.isArray(raw?.branches) ? raw.branches : [];
  };
  const isManual = () => props.event.source === "manual";
  const colorStyle = () => getSourceColorStyle(props.event.source);
  const traktDescriptor = () =>
    props.event.source === "trakt" ? describeTraktSource(props.event.raw_data) : null;

  const albumArt = () =>
    isSpotifyEvent(props.event)
      ? getEventAlbumArt(props.event, props.trackImageMap)
      : null;

  // Whether the clamped content is actually cut off. Truncation depends on the
  // rendered width rather than the character count, so it has to be measured:
  // content that fits inside the clamp gets no "Show more" button.
  const [contentClamped, setContentClamped] = createSignal(false);
  const measureClamp = (el: HTMLElement) => {
    const measure = () => {
      if (!expanded()) setContentClamped(el.scrollHeight - el.clientHeight > 1);
    };
    // Refs run before the element is in the document, where it has no layout.
    onMount(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  };
  const hasExpandableContent = () => expanded() || contentClamped();

  return (
    <div
      class={`relative pl-8 pb-4 ${props.isHighlighted ? "ring-2 ring-ring rounded-lg" : ""}`}
    >
      {/* Timeline spine */}
      <div class="absolute left-3 top-0 bottom-0 w-px bg-border timeline-spine" />

      {/* Event node */}
      <div
        class="absolute left-1 top-1 w-5 h-5 rounded-full flex items-center justify-center source-icon"
        style={colorStyle()}
      >
        <SourceIcon source={props.event.source} class="w-3 h-3" />
      </div>

      {/* Event content */}
      <div
        class={`group rounded-lg bg-card p-3 ${props.isHighlighted ? "bg-accent" : ""} ${isWakaTimeSession() ? "cursor-pointer transition-colors hover:bg-accent/30" : ""}`}
        onClick={() => {
          if (!isWakaTimeSession()) return;
          const projectName = wakaTimeProjectName();
          if (projectName) navigate(buildCodingProjectUrl(projectName));
        }}
      >
        <div class="flex items-start gap-2">
          {/* Time */}
          <span class="text-xs text-muted-foreground shrink-0 font-mono pt-0.5">
            {formatTime(props.event.timestamp)}
            <Show when={props.event.end_timestamp}>
              {(endTs) => <>{" – "}{formatTime(endTs())}</>}
            </Show>
          </span>

          {/* Album art thumbnail */}
          <Show when={albumArt()}>
            {(url) => (
              <img
                src={url()}
                alt=""
                class="w-10 h-10 rounded-sm shrink-0 object-cover"
                loading="lazy"
              />
            )}
          </Show>

          {/* Content */}
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-medium source-label" style={colorStyle()}>
                {sourceLabel(props.event.source)}
              </span>
              <span class="text-xs text-muted-foreground">
                {(props.event.source === "spotify" || props.event.source === "spotify-friends") ? "1 track" : props.event.type}
                <Show when={traktDescriptor()}>
                  {(desc) => <>{" "}&bull; {desc()}</>}
                </Show>
                <Show when={props.event.source === "monzo" && getMonzoAccountLabel(props.event.source_account)}>
                  {(label) => <>{" "}&bull; {label()}</>}
                </Show>
                <Show when={props.event.duration_ms}>
                  {(dur) => <>{" "}&bull; {formatDuration(dur())}</>}
                </Show>
                <Show when={props.event.source === "spotify-friends" && senderIdentifier()}>
                  {(ident) => (
                    <>
                      {" "}&bull;{" "}
                      <button
                        class="cursor-pointer hover:text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onPersonClick?.(ident(), props.event.source, e);
                        }}
                      >
                        {sender()}
                      </button>
                    </>
                  )}
                </Show>
              </span>
              {/* Edit/delete buttons for manual events */}
              <Show when={isManual() && (props.onEditEvent || props.onDeleteEvent)}>
                <div class="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Show when={props.onEditEvent}>
                    <button
                      class="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onEditEvent?.(props.event);
                      }}
                      title="Edit event"
                    >
                      <IconEdit class="w-3.5 h-3.5" />
                    </button>
                  </Show>
                  <Show when={props.onDeleteEvent}>
                    <button
                      class="p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-500"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onDeleteEvent?.(props.event);
                      }}
                      title="Delete event"
                    >
                      <IconDelete class="w-3.5 h-3.5" />
                    </button>
                  </Show>
                </div>
              </Show>
            </div>

            <Show when={props.event.title}>
              <Show when={isMessage()} fallback={
                <p class="text-sm font-medium truncate">
                  {isWakaTimeSession() ? wakaTimeProjectName() : props.event.title}
                </p>
              }>
                <button
                  class="text-sm font-medium truncate hover:text-primary hover:underline text-left block"
                  onClick={() => props.onOpenConversation?.(props.event)}
                >
                  {props.event.title}
                </button>
              </Show>
            </Show>

            <Show when={isWakaTimeSession()}>
              <Show when={wakaTimeLanguages().length > 0}>
                <div class="flex items-center gap-1.5 mt-1 flex-wrap">
                  <For each={wakaTimeLanguages()}>
                    {(lang) => (
                      <span class="px-2 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs">
                        {lang}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={wakaTimeBranches().length > 0}>
                <p class="text-xs text-muted-foreground font-mono mt-1">
                  {wakaTimeBranches()[0]}
                  <Show when={wakaTimeBranches().length > 1}>
                    {` +${wakaTimeBranches().length - 1}`}
                  </Show>
                </p>
              </Show>
            </Show>

            <Show when={isManual() && people().length > 0}>
              <p class="text-xs text-muted-foreground">
                {people().slice(0, 3).join(", ")}
                <Show when={people().length > 3}>
                  <span> +{people().length - 3}</span>
                </Show>
              </p>
            </Show>

            <Show when={!isManual() && props.event.source !== "spotify-friends" && !(props.event.source === "youtube" && sender() === props.event.title) && senderLabel() && senderIdentifier()}>
              {(ident) => (
                <button
                  class="text-xs text-muted-foreground hover:text-primary hover:underline cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onPersonClick?.(ident(), props.event.source, e);
                  }}
                >
                  <Show when={props.event.source === "youtube"} fallback={<>&lt;{senderLabel()}&gt;</>}>
                    {senderLabel()}
                  </Show>
                </button>
              )}
            </Show>

            <Show when={!isWakaTimeSession() && formatContent(props.event) && formatContent(props.event) !== props.event.title}>
              <p
                ref={measureClamp}
                class={`text-sm text-muted-foreground mt-1 whitespace-pre-line ${expanded() ? "" : "line-clamp-2"}`}
              >
                {formatContent(props.event)}
              </p>
              <Show when={hasExpandableContent()}>
                <button
                  class="text-xs text-primary hover:underline mt-1"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded(!expanded());
                  }}
                >
                  {expanded() ? "Show less" : "Show more"}
                </button>
              </Show>
            </Show>

            <Show when={props.event.location_name}>
              <p class="text-xs text-muted-foreground mt-1">@ {props.event.location_name}</p>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
