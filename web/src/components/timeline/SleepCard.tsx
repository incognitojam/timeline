import { For, Show } from "solid-js";
import { sourceLabel } from "@shared/sources";
import { formatDuration, formatTime } from "../../lib/format";
import {
  parseSleepEvent,
  SLEEP_STAGE_LABELS,
  type SleepStage,
  type SleepStageTotal,
} from "../../lib/sleep";
import { getSourceColorStyle } from "../../lib/source-styles";
import type { TimelineEvent } from "../../lib/types";
import { IconBedtime } from "../../ui/icons";

interface Props {
  event: TimelineEvent;
  isHighlighted?: boolean;
}

/** Night palette: warm for wakefulness, cooling as sleep deepens. */
const STAGE_COLORS: Record<SleepStage, string> = {
  awake: "#e8a05c",
  rem: "#6fc7dd",
  light: "#b3a5f7",
  deep: "#5a45c6",
};

const DONUT_RADIUS = 40;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;
// Hairline break between arcs so neighbouring stages stay distinct.
const DONUT_GAP = 3;

/** Stage composition as a ring: one arc per stage, in the legend's order. */
function StageDonut(props: { totals: SleepStageTotal[] }) {
  const arcs = () => {
    const total = props.totals.reduce((sum, entry) => sum + entry.durationMs, 0);
    let offset = 0;
    return props.totals.map((entry) => {
      const length = (entry.durationMs / total) * DONUT_CIRCUMFERENCE;
      const arc = {
        stage: entry.stage,
        offset,
        length: Math.max(length - DONUT_GAP, 1),
        share: Math.round((entry.durationMs / total) * 100),
        durationMs: entry.durationMs,
      };
      offset += length;
      return arc;
    });
  };

  return (
    <svg viewBox="0 0 100 100" class="w-[72px] h-[72px] shrink-0" aria-hidden>
      <For each={arcs()}>
        {(arc) => (
          <circle
            cx="50"
            cy="50"
            r={DONUT_RADIUS}
            fill="none"
            stroke={STAGE_COLORS[arc.stage]}
            stroke-width="17"
            stroke-dasharray={`${arc.length} ${DONUT_CIRCUMFERENCE - arc.length}`}
            stroke-dashoffset={-arc.offset}
            transform="rotate(-90 50 50)"
          >
            <title>{`${SLEEP_STAGE_LABELS[arc.stage]} ${formatDuration(arc.durationMs)} · ${arc.share}%`}</title>
          </circle>
        )}
      </For>
    </svg>
  );
}

export default function SleepCard(props: Props) {
  const colorStyle = () => getSourceColorStyle(props.event.source);
  const details = () => parseSleepEvent(props.event);

  // Headline: time actually asleep where the record reports it, else the
  // recorded period — labelled for whichever it is.
  const headlineMs = () => details().asleepMs ?? props.event.duration_ms;
  // Time in bed only earns a slot when it differs from the headline (a nap with
  // no wakefulness reports the same number twice).
  const inBedMs = () => {
    const inBed = details().inBedMs;
    return inBed === null || inBed === details().asleepMs ? null : inBed;
  };
  // A lone stage total just restates the headline; the breakdown earns its
  // place once there is more than one stage to compare.
  const stageTotals = () => (details().stageTotals.length > 1 ? details().stageTotals : []);

  return (
    <div class={`relative pl-8 pb-4 ${props.isHighlighted ? "ring-2 ring-ring rounded-lg" : ""}`}>
      {/* Timeline spine */}
      <div class="absolute left-3 top-0 bottom-0 w-px bg-border timeline-spine" />

      {/* Event node */}
      <div
        class="absolute left-1 top-1 w-5 h-5 rounded-full flex items-center justify-center source-icon"
        style={colorStyle()}
      >
        <IconBedtime class="w-3 h-3" aria-hidden />
      </div>

      <div class={`rounded-lg bg-card p-3 flex items-center gap-4 ${props.isHighlighted ? "bg-accent" : ""}`}>
        <div class="flex-1 min-w-0">
          {/* Header: when it happened, and where it came from */}
          <div class="flex items-baseline gap-2 flex-wrap">
            <span class="text-xs text-muted-foreground font-mono shrink-0">
              {formatTime(props.event.timestamp)}
              <Show when={props.event.end_timestamp}>
                {(endTs) => <>{" – "}{formatTime(endTs())}</>}
              </Show>
            </span>
            <span class="text-xs font-medium source-label" style={colorStyle()}>
              {sourceLabel(props.event.source)}
            </span>
            <span class="text-xs text-muted-foreground">
              {props.event.type === "sleep:nap" ? "nap" : "sleep"}
            </span>
          </div>

          {/* Headline: time asleep, then the qualifiers that describe it */}
          <div class="flex items-baseline gap-3 flex-wrap mt-1.5">
            <Show when={headlineMs()}>
              {(ms) => (
                <span class="font-display text-2xl leading-none tracking-tight">{formatDuration(ms())}</span>
              )}
            </Show>
            <span class="text-xs text-muted-foreground">
              {details().asleepMs !== null ? "asleep" : "in bed"}
            </span>
            <Show when={details().efficiency}>
              {(efficiency) => (
                <span class="text-xs text-muted-foreground">
                  <span class="text-foreground font-medium">{efficiency()}%</span> efficiency
                </span>
              )}
            </Show>
            <Show when={inBedMs()}>
              {(ms) => (
                <span class="text-xs text-muted-foreground">
                  <span class="text-foreground font-medium">{formatDuration(ms())}</span> in bed
                </span>
              )}
            </Show>
          </div>

          {/* Stage breakdown, lightest sleep first */}
          <Show when={stageTotals().length > 0}>
            <div class="flex items-center gap-x-3 gap-y-1 flex-wrap mt-2.5">
              <For each={stageTotals()}>
                {(total) => (
                  <span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      class="w-2 h-2 rounded-xs shrink-0"
                      style={{ "background-color": STAGE_COLORS[total.stage] }}
                      aria-hidden
                    />
                    {SLEEP_STAGE_LABELS[total.stage]}
                    <span class="text-foreground">{formatDuration(total.durationMs)}</span>
                  </span>
                )}
              </For>
            </div>
          </Show>
        </div>

        {/* Stage composition, echoing the legend's colours */}
        <Show when={stageTotals().length > 0}>
          <StageDonut totals={stageTotals()} />
        </Show>
      </div>
    </div>
  );
}
