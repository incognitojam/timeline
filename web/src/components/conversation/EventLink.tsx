import type { JSX } from "solid-js";
import { buildConversationUrl } from "../../lib/routes";

interface Props {
  eventId: number;
  source: string;
  conversationId: string;
  children: JSX.Element;
  class?: string;
}

export function EventLink(props: Props): JSX.Element {
  return (
    <a
      href={buildConversationUrl(props.source, props.conversationId, props.eventId)}
      class={`hover:text-foreground hover:underline ${props.class ?? ""}`}
    >
      {props.children}
    </a>
  );
}
