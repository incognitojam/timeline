import { For, Show, createMemo } from "solid-js";
import { sourceLabel } from "@shared/sources";
import { readRecording, recordingAppLabel } from "@platforms/call-recordings/shared/recording";
import type { TimelineEvent } from "../../lib/types";
import { getSourceColorStyle } from "../../lib/source-styles";
import { extractIdentifiers, getResolvedNameOr } from "../../lib/identities";
import { formatDuration, formatTime } from "../../lib/format";
import SourceIcon from "../../components/SourceIcon";

interface Props {
  event: TimelineEvent;
  /** Call events this recording recorded, shown here instead of on their own. */
  linkedCalls?: readonly TimelineEvent[];
  isHighlighted?: boolean;
  onPersonClick?: (identifier: string, source: string, e: MouseEvent) => void;
  onOpenConversation?: (event: TimelineEvent) => void;
}

/** "Outgoing call" for `call:outgoing`; "Call" for a message-style call such as `message:dm:call`. */
function callTypeLabel(type: string): string {
  if (!type.startsWith("call:")) return "Call";
  const kind = type.slice("call:".length);
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} call`;
}

/** A recorded call: who, when, how long, and its audio. */
export default function CallRecordingCard(props: Props) {
  const colorStyle = () => getSourceColorStyle(props.event.source);
  const recording = createMemo(() => readRecording(props.event.raw_data));
  /**
   * A recording with a number holds just that caller. One placed by its call
   * holds that call's people, the owner included, so its title names it instead.
   */
  const counterparty = () => {
    const people = extractIdentifiers([props.event]);
    return people.length === 1 ? (people[0] ?? null) : null;
  };
  const name = () => getResolvedNameOr(counterparty(), props.event.title ?? "Unknown caller");
  const callLabel = () => {
    const app = recording()?.app;
    return app ? `${recordingAppLabel(app)} call` : "Call";
  };

  return (
    <div class={`relative pl-8 pb-4 ${props.isHighlighted ? "ring-2 ring-ring rounded-lg" : ""}`}>
      <div class="absolute left-3 top-0 bottom-0 w-px bg-border timeline-spine" />
      <div
        class="absolute left-1 top-1 w-5 h-5 rounded-full flex items-center justify-center source-icon"
        style={colorStyle()}
      >
        <SourceIcon source={props.event.source} class="w-3 h-3" />
      </div>

      <div class={`rounded-lg bg-card p-3 ${props.isHighlighted ? "bg-accent" : ""}`}>
        <div class="flex items-start gap-2">
          <span class="text-xs text-muted-foreground shrink-0 font-mono pt-0.5">
            {formatTime(props.event.timestamp)}
            <Show when={props.event.end_timestamp}>
              {(end) => <>{" – "}{formatTime(end())}</>}
            </Show>
          </span>

          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1 flex-wrap">
              <span class="text-xs font-medium source-label" style={colorStyle()}>
                {sourceLabel(props.event.source)}
              </span>
              <span class="text-xs text-muted-foreground">
                {callLabel()}
                <Show when={props.event.duration_ms}>
                  {(ms) => <>{" "}&bull; {formatDuration(ms())}</>}
                </Show>
              </span>
            </div>

            <Show
              when={counterparty()}
              fallback={<p class="text-sm font-medium truncate">{name()}</p>}
            >
              {(identifier) => (
                <button
                  type="button"
                  class="text-sm font-medium truncate hover:text-primary hover:underline text-left block"
                  onClick={(e) => props.onPersonClick?.(identifier(), props.event.source, e)}
                >
                  {name()}
                </button>
              )}
            </Show>

            <For each={props.linkedCalls ?? []}>
              {(call) => (
                <button
                  type="button"
                  class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"
                  title="Open the conversation this call belongs to"
                  onClick={() => props.onOpenConversation?.(call)}
                >
                  <SourceIcon source={call.source} class="w-3 h-3" />
                  <span>
                    {sourceLabel(call.source)} &bull; {callTypeLabel(call.type)}
                    <Show when={call.duration_ms}>{(ms) => <> &bull; {formatDuration(ms())}</>}</Show>
                  </span>
                </button>
              )}
            </For>

            <Show
              when={recording()?.playable}
              fallback={
                <Show when={recording()}>
                  {(rec) => (
                    <p class="text-xs text-muted-foreground mt-1">
                      Can't be played in a browser
                      <Show when={rec().unplayable_reason}>{(reason) => <>: {reason()}</>}</Show>
                    </p>
                  )}
                </Show>
              }
            >
              <audio
                class="mt-2 w-full max-w-md h-8"
                controls
                preload="none"
                src={`/api/call-recordings/${props.event.id}/audio`}
              />
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
