import { For, type JSX } from "solid-js";
import { createKeyedRecords } from "../../lib/createKeyedRecords";
import { formatDateSeparator } from "../../lib/format";
import type { TimelineEvent } from "../../lib/types";

export interface ConversationTranscriptProps {
  events: TimelineEvent[];
  density: "full" | "compact";
  renderMessage: (event: TimelineEvent) => JSX.Element;
}

function groupByDate(events: TimelineEvent[]): Map<string, TimelineEvent[]> {
  const groups = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const date = event.timestamp ? formatDateSeparator(event.timestamp) : "Unknown Date";
    let group = groups.get(date);
    if (!group) {
      group = [];
      groups.set(date, group);
    }
    group.push(event);
  }
  return groups;
}

export function ConversationTranscript(props: ConversationTranscriptProps): JSX.Element {
  const dateGroups = createKeyedRecords(
    () => Array.from(groupByDate(props.events), ([date, events]) => ({ date, events })),
    (group) => group.date,
  );
  const compact = () => props.density === "compact";

  return (
    <For each={dateGroups()}>
      {(record) => {
        const group = record.value;
        return (
          <div>
            <div
              class={`sticky top-0 z-10 flex items-center gap-2 ${
                compact() ? "py-1 px-2" : "py-2 px-4"
              } bg-background/95 backdrop-blur-sm`}
            >
              <div class="flex-1 h-px bg-border" />
              <span
                class={`${compact() ? "text-xs" : "text-sm"} font-medium text-muted-foreground px-2 bg-background rounded`}
              >
                {group().date}
              </span>
              <div class="flex-1 h-px bg-border" />
            </div>

            <div class={compact() ? "px-2" : "px-4"}>
              <For each={group().events}>{props.renderMessage}</For>
            </div>
          </div>
        );
      }}
    </For>
  );
}
