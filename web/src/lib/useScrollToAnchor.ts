import { useLocation } from "@solidjs/router";
import { createEffect, on } from "solid-js";
import { parseEventIdFromHash } from "./routes";

/**
 * Hook for scrolling to #event-{id} anchors in the URL.
 * Optionally calls a callback with the parsed event ID.
 */
export function useScrollToAnchor(onEventId?: (id: number | undefined) => void) {
  const location = useLocation();

  createEffect(on(
    () => location.hash,
    (hash) => {
      const eventId = parseEventIdFromHash(hash);
      onEventId?.(eventId);

      if (hash) {
        requestAnimationFrame(() => {
          const el = document.getElementById(hash.slice(1));
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      }
    }
  ));

  return () => parseEventIdFromHash(location.hash);
}
