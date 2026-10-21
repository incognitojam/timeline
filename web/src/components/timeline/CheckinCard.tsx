import { For, Show } from "solid-js";
import type { EventGroupData } from "@shared/grouping";
import { sourceLabel } from "@shared/sources";
import type { TimelineEvent } from "../../lib/types";
import { getSourceColorStyle } from "../../lib/source-styles";
import { getDisplayName } from "../../lib/identities";
import SourceIcon from "../SourceIcon";
import { formatTime } from "../../lib/format";

interface Props {
  group: EventGroupData<TimelineEvent>;
  highlightEventId?: number;
  setEventRef?: (eventId: number, el: HTMLDivElement) => void;
  onPersonClick?: (name: string, source: string, e: MouseEvent) => void;
}

// A check-in's venue name, never prefixed with "Checked in at".
function venueName(event: TimelineEvent): string {
  if (event.location_name) return event.location_name;
  if (event.title) {
    const stripped = event.title.replace(/^Checked in at /, "");
    if (stripped) return stripped;
  }
  return "Check-in";
}

// First venue category from the tags JSON array (e.g. "Train Station").
function firstCategory(event: TimelineEvent): string | null {
  if (!event.tags) return null;
  try {
    const tags = JSON.parse(event.tags) as unknown;
    if (Array.isArray(tags)) {
      const first = tags[0];
      if (typeof first === "string" && first.trim()) return first;
    }
  } catch {
    // Ignore malformed tags
  }
  return null;
}

// Companion identifiers stored in the people JSON array.
function companions(event: TimelineEvent): string[] {
  if (!event.people) return [];
  try {
    const people = JSON.parse(event.people) as unknown;
    if (Array.isArray(people)) {
      return people.filter((p): p is string => typeof p === "string" && p.length > 0);
    }
  } catch {
    // Ignore malformed people
  }
  return [];
}

// One companion line, shared by the parent title block and nested rows.
function CompanionLine(props: {
  event: TimelineEvent;
  onPersonClick?: (name: string, source: string, e: MouseEvent) => void;
}) {
  const people = () => companions(props.event);
  return (
    <Show when={people().length > 0}>
      <p class="text-xs text-muted-foreground mt-0.5">
        {"with "}
        <For each={people()}>
          {(person, i) => (
            <>
              <Show when={i() > 0}>{", "}</Show>
              <button
                class="cursor-pointer hover:text-primary hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onPersonClick?.(person, "swarm", e);
                }}
              >
                {getDisplayName(person)}
              </button>
            </>
          )}
        </For>
      </p>
    </Show>
  );
}

export default function CheckinCard(props: Props) {
  const colorStyle = () => getSourceColorStyle("swarm");
  const events = () => props.group.events;
  const parent = () => events()[0];
  const nested = () => events().slice(1);
  const parentTime = () => formatTime(parent().timestamp);

  const containsHighlighted = () =>
    props.highlightEventId !== undefined &&
    events().some((e) => e.id === props.highlightEventId);

  const metaSuffix = () => {
    const category = firstCategory(parent());
    if (category) return category;
    const count = events().length;
    return count > 1 ? `${count} check-ins` : "check-in";
  };

  return (
    <div
      id={`event-${parent().id}`}
      ref={(el) => props.setEventRef?.(parent().id, el)}
      class="relative pl-8 pb-4"
    >
      {/* Timeline spine */}
      <div class="absolute left-3 top-0 bottom-0 w-px bg-border timeline-spine" />

      {/* Source node */}
      <div
        class="absolute left-1 top-1 w-5 h-5 rounded-full flex items-center justify-center source-icon"
        style={colorStyle()}
      >
        <SourceIcon source="swarm" class="w-3 h-3" />
      </div>

      {/* Card */}
      <div
        class={`rounded-lg bg-card p-3 transition-colors ${
          containsHighlighted() ? "ring-2 ring-ring" : ""
        }`}
      >
        <div class="flex items-start gap-2">
          {/* Time */}
          <span class="text-xs text-muted-foreground shrink-0 w-12 font-mono pt-0.5">
            {parentTime()}
          </span>

          {/* Content */}
          <div class="flex-1 min-w-0">
            {/* Meta line: source + category (or count fallback) */}
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-medium source-label" style={colorStyle()}>
                {sourceLabel(props.group.source)}
              </span>
              <span class="text-xs text-muted-foreground">· {metaSuffix()}</span>
            </div>

            {/* Parent venue */}
            <p class="text-sm font-medium">
              <span
                class={
                  parent().id === props.highlightEventId
                    ? "bg-yellow-500/20 px-1 rounded"
                    : ""
                }
              >
                {venueName(parent())}
              </span>
            </p>

            {/* Parent shout */}
            <Show when={parent().content}>
              {(shout) => (
                <p class="text-sm text-muted-foreground mt-0.5 whitespace-pre-line">
                  {shout()}
                </p>
              )}
            </Show>

            {/* Parent companions */}
            <CompanionLine event={parent()} onPersonClick={props.onPersonClick} />
          </div>
        </div>

        {/* Nested check-ins: same time gutter as the parent row, so all
            timestamps share one left-aligned column */}
        <For each={nested()}>
          {(event) => (
            <div
              id={`event-${event.id}`}
              ref={(el) => props.setEventRef?.(event.id, el)}
              class="flex items-start gap-2 mt-1.5"
            >
              {/* Aligned with the parent time column but visually subordinate:
                  the parent time anchors the visit, nested times are detail */}
              <span class="text-xs text-muted-foreground/60 shrink-0 w-12 font-mono">
                <Show when={formatTime(event.timestamp) !== parentTime()}>
                  {formatTime(event.timestamp)}
                </Show>
              </span>
              <div class="flex-1 min-w-0">
                <p class="text-xs text-muted-foreground">
                  <span
                    class={
                      event.id === props.highlightEventId
                        ? "bg-yellow-500/20 px-1 rounded"
                        : ""
                    }
                  >
                    {venueName(event)}
                  </span>
                </p>
                <Show when={event.content}>
                  {(shout) => (
                    <p class="text-xs text-muted-foreground mt-0.5 whitespace-pre-line">
                      {shout()}
                    </p>
                  )}
                </Show>
                <CompanionLine event={event} onPersonClick={props.onPersonClick} />
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
