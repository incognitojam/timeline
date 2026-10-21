import { Show } from "solid-js";
import { sourceLabel } from "@shared/sources";
import type { TimelineEvent } from "../../lib/types";

export function sourceDeletedTitle(event: TimelineEvent): string | undefined {
  const observedAt = event.source_deleted_observed_at;
  if (!observedAt) return undefined;
  const source = sourceLabel(event.source);
  const noticed = new Date(observedAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `Deleted on ${source} · noticed ${noticed}`;
}

/** Class suffix (leading space) for the message body of a source-deleted event. */
export function sourceDeletedClass(event: TimelineEvent): string {
  return event.source_deleted_observed_at ? " border-l-2 border-red-400/50 pl-2 opacity-70" : "";
}

export function SourceDeletedBadge(props: { event: TimelineEvent; class?: string }) {
  return (
    <Show when={props.event.source_deleted_observed_at}>
      <span class={`text-red-400 ${props.class ?? ""}`} title={sourceDeletedTitle(props.event)}>
        deleted
      </span>
    </Show>
  );
}
