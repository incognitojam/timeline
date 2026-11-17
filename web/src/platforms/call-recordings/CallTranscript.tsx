import { For, Show, createMemo } from "solid-js";
import { type TranscriptTurn, turnInstant } from "@platforms/call-recordings/shared/transcript";
import { formatTime } from "../../lib/format";

/** Colours for speakers in the order they first speak. */
const SPEAKER_COLORS = ["text-sky-600 dark:text-sky-400", "text-amber-600 dark:text-amber-400", "text-emerald-600 dark:text-emerald-400"];

interface Props {
  turns: readonly TranscriptTurn[];
  /** The recording's `start`, which places each turn's time. */
  start: string | null;
}

/** A call transcript as a conversation: time, speaker, what they said. */
export default function CallTranscript(props: Props) {
  const colors = createMemo(() => {
    const bySpeaker = new Map<string, string>();
    for (const turn of props.turns) {
      if (turn.speaker && !bySpeaker.has(turn.speaker)) {
        bySpeaker.set(turn.speaker, SPEAKER_COLORS[bySpeaker.size % SPEAKER_COLORS.length] ?? "");
      }
    }
    return bySpeaker;
  });

  const time = (turn: TranscriptTurn) => {
    const at = props.start ? turnInstant(turn, props.start) : null;
    return at === null ? "" : formatTime(new Date(at));
  };

  return (
    <ol class="mt-2 space-y-1.5 text-sm">
      <For each={props.turns}>
        {(turn) => (
          <li class="flex gap-2">
            <span class="text-xs text-muted-foreground font-mono shrink-0 w-16 pt-0.5">{time(turn)}</span>
            <p class="min-w-0">
              <Show when={turn.speaker}>
                {(speaker) => <span class={`font-medium ${colors().get(speaker()) ?? ""}`}>{speaker()} </span>}
              </Show>
              <span class="text-muted-foreground">{turn.text}</span>
            </p>
          </li>
        )}
      </For>
    </ol>
  );
}
