import { Show, createSignal } from "solid-js";
import { getInitials } from "../lib/format";

interface AvatarProps {
  url: string | null | undefined;
  name: string;
  size?: "sm" | "md" | "lg";
  class?: string;
  /** Names it for a shared-element view transition (see lib/view-transition.ts). */
  transitionName?: string;
}

const SIZE_CLASSES = {
  sm: "w-6 h-6 text-[10px]",
  md: "w-8 h-8 text-xs",
  lg: "w-12 h-12 text-base",
};

function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 40%, 50%)`;
}

export default function Avatar(props: AvatarProps) {
  // The URL that failed, so a reused avatar shows the next contact's photo.
  const [failedUrl, setFailedUrl] = createSignal<string>();

  const sizeClass = () => SIZE_CLASSES[props.size ?? "md"];

  return (
    <Show
      when={props.url !== failedUrl() && props.url}
      fallback={
        <div
          class={`rounded-full flex items-center justify-center text-white font-medium flex-shrink-0 ${sizeClass()} ${props.class ?? ""}`}
          style={{ "background-color": hashColor(props.name), "view-transition-name": props.transitionName }}
        >
          {getInitials(props.name)}
        </div>
      }
    >
      {(url) => (
        <img
          src={url()}
          alt={props.name}
          class={`rounded-full object-cover flex-shrink-0 ${sizeClass()} ${props.class ?? ""}`}
          style={{ "view-transition-name": props.transitionName }}
          onError={() => setFailedUrl(url())}
          loading="lazy"
          referrerpolicy="no-referrer"
        />
      )}
    </Show>
  );
}
