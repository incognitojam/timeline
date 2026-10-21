import { createSignal, For, type JSX, Show } from "solid-js";
import type { ContentBlock, Helpline } from "../../../lib/content-blocks";

export function FlagBlock(props: { block: ContentBlock }): JSX.Element {
  const [expanded, setExpanded] = createSignal(true);

  const flag = () => props.block.flag ?? "";
  const helplines = (): Helpline[] => {
    const h = props.block.helpline;
    if (!h) return [];
    return Array.isArray(h) ? h : [h];
  };

  return (
    <div class="rounded-md border border-amber-500/40 bg-amber-500/5 text-sm overflow-hidden">
      <button
        type="button"
        class="w-full flex items-start gap-2 px-2 py-1.5 text-left hover:bg-amber-500/10 transition-colors"
        onClick={() => setExpanded(!expanded())}
      >
        <span class="text-amber-600 dark:text-amber-500 shrink-0" aria-hidden="true">
          {expanded() ? "▾" : "▸"}
        </span>
        <span class="font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide text-xs shrink-0 pt-0.5">
          Safety flag
        </span>
        <Show when={flag()}>
          <span class="font-mono text-amber-700 dark:text-amber-400 truncate min-w-0 flex-1">
            {flag()}
          </span>
        </Show>
      </button>
      <Show when={expanded() && helplines().length > 0}>
        <ul class="px-3 pb-2 pt-0 space-y-1">
          <For each={helplines()}>
            {(h) => <HelplineRow helpline={h} />}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function HelplineRow(props: { helpline: Helpline }): JSX.Element {
  const h = () => props.helpline;
  return (
    <li class="flex flex-wrap gap-x-2 gap-y-0.5 items-baseline">
      <Show when={h().name}>
        <span class="font-medium">{h().name}</span>
      </Show>
      <Show when={h().phone_number}>
        {(phone) => (
          <a href={`tel:${phone().replace(/\s+/g, "")}`} class="text-primary hover:underline">
            {phone()}
          </a>
        )}
      </Show>
      <Show when={h().sms_number}>
        {(sms) => (
          <span class="text-muted-foreground">
            SMS{" "}
            <a
              href={`sms:${sms().replace(/\s+/g, "")}`}
              class="text-primary hover:underline"
            >
              {sms()}
            </a>
          </span>
        )}
      </Show>
      <Show when={h().web_chat_url}>
        {(url) => (
          <a
            href={url()}
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary hover:underline"
          >
            web chat
          </a>
        )}
      </Show>
      <Show when={h().url}>
        {(url) => (
          <a
            href={url()}
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary hover:underline"
          >
            website
          </a>
        )}
      </Show>
    </li>
  );
}
