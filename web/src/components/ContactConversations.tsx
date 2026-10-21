import { Show, For } from "solid-js";
import { sourceLabel } from "@shared/sources";
import { useContactConversations } from "../lib/queries";
import { formatRelativeDate } from "../lib/format";
import { buildConversationUrl } from "../lib/routes";
import { getSourceColorStyle } from "../lib/source-styles";
import { staleContentClass } from "../lib/stale-content";

interface Props {
  contactId: number;
}

export default function ContactConversations(props: Props) {
  const query = useContactConversations(() => props.contactId);
  const conversations = () => {
    if (query.isPending || query.isError) return undefined;
    const c = query.data?.conversations;
    return c && c.length > 0 ? c : undefined;
  };

  return (
    <Show when={conversations()}>
      {(convs) => (
        <div class={`rounded-lg bg-card p-4 ${staleContentClass(query.isPlaceholderData)}`} aria-busy={query.isPlaceholderData}>
          <h3 class="text-sm font-medium text-muted-foreground mb-3">
            Conversations
            <span class="ml-1 font-mono tabular-nums">({convs().length})</span>
          </h3>
          <div class="max-h-96 overflow-y-auto space-y-0.5 pr-1">
            <For each={convs()}>
              {(conv) => (
                <a
                  href={buildConversationUrl(conv.source, conv.conversationId)}
                  class="flex items-center gap-2 p-2 rounded-sm hover:bg-accent transition-colors"
                >
                  <span
                    class="text-xs px-1.5 py-0.5 rounded source-badge shrink-0"
                    style={getSourceColorStyle(conv.source)}
                  >
                    {sourceLabel(conv.source)}
                  </span>
                  <span class="truncate flex-1 text-sm">{conv.title}</span>
                  <span class="text-xs text-muted-foreground font-mono tabular-nums shrink-0">
                    {conv.messageCount.toLocaleString()}
                  </span>
                  <span class="text-xs text-muted-foreground shrink-0 w-16 text-right">
                    {formatRelativeDate(conv.lastMessage)}
                  </span>
                </a>
              )}
            </For>
          </div>
        </div>
      )}
    </Show>
  );
}
