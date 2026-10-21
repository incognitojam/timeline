import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { formatDuration, formatTime } from "../../lib/format";
import { getPeopleFromEvent } from "../../lib/identities";
import { getTransportMode } from "../../lib/transport-modes";
import type { TimelineEvent } from "../../lib/types";
import { IconArrowForward, IconDelete, IconEdit } from "../../ui/icons";

interface Props {
  event: TimelineEvent;
  isHighlighted?: boolean;
  onEditEvent?: (event: TimelineEvent) => void;
  onDeleteEvent?: (event: TimelineEvent) => void;
}

function parseTransport(event: TimelineEvent) {
  try {
    const raw = typeof event.raw_data === "string" ? JSON.parse(event.raw_data) : event.raw_data;
    return raw?.transport ?? null;
  } catch {
    return null;
  }
}

export default function TransportCard(props: Props) {
  const transport = () => parseTransport(props.event);
  const modeValue = () => props.event.type.replace("transport:", "");
  const mode = () => getTransportMode(modeValue());
  const color = () => mode().color;
  const people = () => getPeopleFromEvent(props.event);
  const isManual = () => props.event.source === "manual";

  const origin = () => transport()?.origin;
  const destination = () => transport()?.destination;
  const hasCodes = () => !!(origin()?.code && destination()?.code);
  const hasNames = () => !!(origin()?.name && destination()?.name);

  return (
    <div class={`relative pl-8 pb-4 ${props.isHighlighted ? "ring-2 ring-ring rounded-lg" : ""}`}>
      {/* Timeline spine */}
      <div class="absolute left-3 top-0 bottom-0 w-px bg-border timeline-spine" />

      {/* Event node */}
      <div
        class="absolute left-1 top-1 w-5 h-5 rounded-full flex items-center justify-center text-xs"
        style={{
          "background-color": `color-mix(in srgb, ${color()} 25%, transparent)`,
          color: color(),
        }}
      >
        <Dynamic component={mode().icon} class="h-3 w-3" aria-hidden />
      </div>

      {/* Card */}
      <div class={`group rounded-lg bg-card p-3 transition-colors hover:bg-accent/30 ${props.isHighlighted ? "bg-accent" : ""}`}>
        {/* Header: time + mode + edit buttons */}
        <div class="flex items-center gap-2 mb-2">
          <span class="text-xs text-muted-foreground shrink-0">
            {formatTime(props.event.timestamp)}
            <Show when={props.event.end_timestamp}>
              {(endTs) => <>{" \u2013 "}{formatTime(endTs())}</>}
            </Show>
          </span>
          <span
            class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-sm"
            style={{
              "background-color": `color-mix(in srgb, ${color()} 20%, transparent)`,
              color: color(),
            }}
          >
            <Dynamic component={mode().icon} class="h-3.5 w-3.5" aria-hidden />
            {modeValue()}
          </span>
          <Show when={props.event.duration_ms}>
            {(dur) => (
              <span class="text-xs text-muted-foreground">{formatDuration(dur())}</span>
            )}
          </Show>
          <Show when={transport()?.service}>
            <span class="text-xs font-mono text-muted-foreground">{transport()?.service}</span>
          </Show>

          {/* Edit/delete */}
          <Show when={isManual() && (props.onEditEvent || props.onDeleteEvent)}>
            <div class="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <Show when={props.onEditEvent}>
                <button
                  class="p-1 rounded-sm hover:bg-accent text-muted-foreground hover:text-foreground"
                  onClick={(e) => { e.stopPropagation(); props.onEditEvent?.(props.event); }}
                  title="Edit transport"
                >
                  <IconEdit class="w-3.5 h-3.5" />
                </button>
              </Show>
              <Show when={props.onDeleteEvent}>
                <button
                  class="p-1 rounded-sm hover:bg-red-500/20 text-muted-foreground hover:text-red-500"
                  onClick={(e) => { e.stopPropagation(); props.onDeleteEvent?.(props.event); }}
                  title="Delete transport"
                >
                  <IconDelete class="w-3.5 h-3.5" />
                </button>
              </Show>
            </div>
          </Show>
        </div>

        {/* Route display */}
        <div class="flex items-center gap-3">
          {/* Origin */}
          <div class="flex-1 text-right">
            <Show when={hasCodes()}>
              <p class="text-base font-semibold font-mono">{origin()?.code}</p>
            </Show>
            <Show when={origin()?.name}>
              <p class={`text-muted-foreground ${hasCodes() ? "text-xs" : "text-sm font-medium"}`}>
                {origin()?.name}
              </p>
            </Show>
          </div>

          {/* Arrow */}
          <div class="shrink-0 text-muted-foreground">
            <IconArrowForward class="w-5 h-5" />
          </div>

          {/* Destination */}
          <div class="flex-1">
            <Show when={hasCodes()}>
              <p class="text-base font-semibold font-mono">{destination()?.code}</p>
            </Show>
            <Show when={destination()?.name}>
              <p class={`text-muted-foreground ${hasCodes() ? "text-xs" : "text-sm font-medium"}`}>
                {destination()?.name}
              </p>
            </Show>
          </div>
        </div>

        {/* Operator */}
        <Show when={transport()?.operator}>
          <p class="text-xs text-muted-foreground mt-1.5">{transport()?.operator}</p>
        </Show>

        {/* People */}
        <Show when={people().length > 0}>
          <p class="text-xs text-muted-foreground mt-1">
            {people().slice(0, 3).join(", ")}
            <Show when={people().length > 3}>
              <span> +{people().length - 3}</span>
            </Show>
          </p>
        </Show>

        {/* Notes */}
        <Show when={props.event.content}>
          <p class="text-xs text-muted-foreground mt-1 line-clamp-2">{props.event.content}</p>
        </Show>
      </div>
    </div>
  );
}
