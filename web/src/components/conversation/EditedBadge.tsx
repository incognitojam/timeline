import { Show } from "solid-js";
import type { TimelineEvent } from "../../lib/types";

export function editedTitle(event: TimelineEvent): string | undefined {
  const count = event.version_count ?? 0;
  if (count === 0) return undefined;
  return `Edited · ${count} earlier ${count === 1 ? "version" : "versions"} captured`;
}

export function EditedBadge(props: { event: TimelineEvent; class?: string }) {
  return (
    <Show when={editedTitle(props.event)}>
      {(title) => (
        <span
          class={`text-xs text-muted-foreground ${props.class ?? ""}`}
          title={title()}
        >
          (edited)
        </span>
      )}
    </Show>
  );
}
