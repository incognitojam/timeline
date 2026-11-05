import { createSignal, Show, type JSX } from "solid-js";

interface Props {
  id: string;
  name: string;
  /**
   * "inline" sits at message text size; "reaction" sits in a reaction badge;
   * "preview" matches the text-xs single-line reply preview.
   */
  size?: "inline" | "reaction" | "preview";
}

const SIZE_CLASSES = {
  inline: "h-6 w-6",
  reaction: "h-5 w-5",
  preview: "h-4 w-4",
} as const;

export function DiscordEmoji(props: Props): JSX.Element {
  const [failed, setFailed] = createSignal(false);

  const sizeClass = () => SIZE_CLASSES[props.size ?? "inline"];

  return (
    <Show
      when={!failed()}
      fallback={<span class="text-muted-foreground">:{props.name}:</span>}
    >
      <img
        src={`/api/discord/emoji/${props.id}`}
        alt={`:${props.name}:`}
        title={`:${props.name}:`}
        class={`inline-block ${sizeClass()} align-middle`}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </Show>
  );
}
