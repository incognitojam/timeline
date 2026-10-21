import { createMemo, createSignal, Show } from "solid-js";
import { guildAcronym } from "../lib/format";
import { getSourceColorValue } from "../lib/source-styles";

const DISCORD = getSourceColorValue("discord");

interface ServerAvatarProps {
  name: string;
  /**
   * Discord CDN icon URL. When present (and it loads) the real server icon is
   * shown; otherwise it falls back to the blurple acronym square.
   */
  iconUrl?: string | null;
  // Tailwind sizing/shape classes for the square (e.g. "w-9 h-9").
  class?: string;
}

// A server's icon, with a Discord-blurple acronym square as fallback. The
// acronym length is fed to CSS as a custom property so clamp() can shrink the
// font for long acronyms instead of overflowing the fixed-size square: 1–2
// letters render at the full 0.875rem, 3+ scale down (1.75rem ÷ length) with a
// 0.4rem floor.
export default function ServerAvatar(props: ServerAvatarProps) {
  // Track the URL that failed (not a bare boolean) so reusing this instance for
  // a different server — e.g. the detail header on navigation — isn't stuck on
  // a previous icon's load error.
  const [failedUrl, setFailedUrl] = createSignal<string | null>(null);
  const acronym = createMemo(() => guildAcronym(props.name));
  const iconUrl = () => {
    const url = props.iconUrl;
    return url && failedUrl() !== url ? url : null;
  };

  return (
    <Show
      when={iconUrl()}
      fallback={
        <div
          class={`rounded-2xl shrink-0 flex items-center justify-center font-semibold text-white ${props.class ?? ""}`}
          style={{
            "background-color": DISCORD,
            "--acronym-length": String(acronym().length),
            "font-size": "clamp(0.4rem, calc(1.75rem / var(--acronym-length)), 0.875rem)",
          }}
        >
          {acronym()}
        </div>
      }
    >
      {(url) => (
        <img
          src={url()}
          alt={props.name}
          class={`rounded-2xl object-cover shrink-0 ${props.class ?? ""}`}
          onError={() => setFailedUrl(url())}
          loading="lazy"
          referrerpolicy="no-referrer"
        />
      )}
    </Show>
  );
}
