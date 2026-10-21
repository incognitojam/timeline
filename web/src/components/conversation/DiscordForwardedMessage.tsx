import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { IconChevronRight, IconForward } from "../../ui/icons";
import { formatDateSeparator } from "../../lib/format";
import type { ForwardedMessageSource } from "../../lib/conversation";
import ServerAvatar from "../ServerAvatar";

interface Props {
  forwarded: boolean;
  source: ForwardedMessageSource | null;
  children: JSX.Element;
}

/** Preserve Discord's outer sender while nesting the message they forwarded. */
export function DiscordForwardedMessage(props: Props) {
  return (
    <div
      class={props.forwarded
        ? "mt-1.5 border-l-2 border-muted-foreground/30 pl-3"
        : undefined}
      role={props.forwarded ? "group" : undefined}
      aria-label={props.forwarded ? "Forwarded message" : undefined}
    >
      <Show when={props.forwarded}>
        <div class="mb-1 flex items-center gap-1 text-muted-foreground">
          <IconForward class="h-4 w-4" aria-hidden="true" />
          <span class="text-xs font-semibold italic">Forwarded</span>
        </div>
      </Show>
      {props.children}
      <Show when={props.forwarded ? props.source : null}>
        {(source) => {
          const date = () => formatDateSeparator(source().timestamp);
          return (
            <a
              href={source().url}
              aria-label={`View original message from ${source().name} in Timeline`}
              title="View original message in Timeline"
              class="mt-2.5 inline-flex max-w-full items-center gap-1.5 rounded-xs text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => event.stopPropagation()}
            >
              <ServerAvatar
                name={source().name}
                iconUrl={source().iconUrl}
                class="h-5 w-5"
              />
              <span class="truncate">{source().name}</span>
              <Show when={date()}>
                {(label) => (
                  <>
                    <span aria-hidden="true">•</span>
                    <time datetime={source().timestamp ?? undefined}>{label()}</time>
                  </>
                )}
              </Show>
              <IconChevronRight class="h-4 w-4 shrink-0" aria-hidden="true" />
            </a>
          );
        }}
      </Show>
    </div>
  );
}
