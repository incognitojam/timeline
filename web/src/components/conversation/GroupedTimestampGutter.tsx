import { Show, type JSX } from "solid-js";
import { EventLink } from "./EventLink";

interface Props {
  eventId: number;
  source: string;
  /** Null when the event predates conversation ids, so it has no permalink. */
  conversationId: string | null;
  /** Preformatted clock time, e.g. "09:12". */
  time: string;
}

/**
 * The avatar-width column under a message that continues a sender's run. It
 * reserves the same width the `sm` Avatar occupies so grouped content stays
 * aligned, and reveals that message's permalinked timestamp on hover of the
 * enclosing `group` row. The link is absolutely positioned so it can overflow
 * the narrow column into the row padding without shifting layout.
 */
export function GroupedTimestampGutter(props: Props): JSX.Element {
  const timestampClass =
    "absolute right-0 top-0.5 whitespace-nowrap text-[10px] leading-4 tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100";

  return (
    <div class="relative w-6 shrink-0">
      <Show
        when={props.conversationId}
        fallback={<span class={timestampClass}>{props.time}</span>}
      >
        {(conversationId) => (
          <EventLink
            eventId={props.eventId}
            source={props.source}
            conversationId={conversationId()}
            class={timestampClass}
          >
            {props.time}
          </EventLink>
        )}
      </Show>
    </div>
  );
}
