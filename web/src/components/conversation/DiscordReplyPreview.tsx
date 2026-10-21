import { For, Show } from "solid-js";
import { IconImage, IconReply } from "../../ui/icons";
import type { ReplyTarget } from "../../lib/conversation";
import { parseDiscordMentions } from "../../lib/discord-mentions";
import { formatDiscordTimestamp } from "../../lib/discord-timestamps";
import { discordUserResolver } from "./DiscordContent";
import { DiscordEmoji } from "./DiscordEmoji";

interface Props {
  reply: ReplyTarget;
  /**
   * Jump to the replied-to message: scroll it into view when loaded, or load
   * a window around it. Returns true when the jump was handled, in which case
   * link navigation is suppressed; false falls through to the `url` href.
   */
  onJump?: (reply: ReplyTarget) => boolean;
}

/**
 * Preview text as a single ellipsized line, with custom Discord emoji tokens
 * rendered as small inline images (via the shared mention/emoji parser used by
 * DiscordContent) and mentions flattened to their plain-text names.
 */
function PreviewText(props: { content: string }) {
  const segments = () =>
    parseDiscordMentions(props.content, null, { user: discordUserResolver });
  return (
    <For each={segments()}>
      {(seg) => {
        switch (seg.kind) {
          case "text":
            return <>{seg.value}</>;
          case "user-mention":
            return <>@{seg.name}</>;
          case "channel-mention":
            return <>#{seg.name}</>;
          case "role-mention":
            return <>@{seg.name ?? `role:${seg.id.slice(0, 4)}…`}</>;
          case "custom-emoji":
            return <DiscordEmoji id={seg.id} name={seg.name} size="preview" />;
          case "timestamp":
            return <>{formatDiscordTimestamp(seg.seconds, seg.style)}</>;
        }
      }}
    </For>
  );
}

/** A plain primary-button click — modified clicks keep native link behavior. */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 &&
    !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/**
 * Discord-style reply indicator shown above a message: the replied-to author
 * and a one-line preview of their message, with an image marker when it had
 * attachments. Clicking a resolved preview jumps to the original message.
 */
export function DiscordReplyPreview(props: Props) {
  const reply = () => props.reply;
  const author = () => reply().authorName ?? "Unknown";
  const previewText = () => {
    const content = reply().content?.trim();
    if (content) return content;
    return reply().hasAttachment ? "Attachment" : "";
  };

  const Inner = () => (
    <>
      <IconReply class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span class="max-w-[45%] shrink-0 truncate font-medium">{author()}</span>
      <Show when={reply().hasAttachment}>
        <IconImage class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </Show>
      <Show when={previewText()}>
        {(text) => (
          <span class="truncate">
            <PreviewText content={text()} />
          </span>
        )}
      </Show>
    </>
  );

  return (
    <Show
      when={reply().url && reply().eventId !== null ? reply() : null}
      fallback={
        <div
          class="mb-1 flex items-center gap-1 text-xs text-muted-foreground/80"
          aria-label={`Replying to ${author()}`}
        >
          <Inner />
        </div>
      }
    >
      {(resolved) => (
        <a
          href={resolved().url ?? undefined}
          class="mb-1 flex items-center gap-1 rounded-xs text-xs text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Replying to ${author()} — jump to the original message`}
          title="Jump to the original message"
          onClick={(event) => {
            event.stopPropagation();
            if (!isPlainClick(event)) return;
            if (props.onJump?.(resolved())) {
              event.preventDefault();
            }
          }}
        >
          <Inner />
        </a>
      )}
    </Show>
  );
}
