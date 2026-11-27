import { useLocation } from "@solidjs/router";
import { onCleanup } from "solid-js";

/** Each page URL's last scroll offset, for this tab's session. */
const offsets = new Map<string, number>();

/** Longest a return waits for the page to commit and grow tall enough. */
const MAX_FRAMES = 60;

/**
 * Ref for a page's own scroll container that brings it back to where it was
 * left on this URL, whether by Back, Forward or a link.
 *
 * Pages scroll inside an element of their own (Layout's <main> doesn't), and
 * the router replaces that element on every navigation, so neither the
 * browser's scroll restoration nor the router's, both of which follow the
 * window, keeps its offset. The page renders before the router swaps it into
 * the document, so the offset goes back once the element is connected and
 * tall enough to hold it.
 */
export function useRestoredScroll(): (element: HTMLElement) => void {
  const location = useLocation();
  const key = location.pathname + location.search;
  let frame: number | undefined;
  onCleanup(() => { if (frame !== undefined) cancelAnimationFrame(frame); });
  return (element) => {
    const saved = offsets.get(key);
    let restoring = saved !== undefined;
    element.addEventListener("scroll", () => {
      // Scroll events before the restore are the new element starting at the top.
      if (!restoring) offsets.set(key, element.scrollTop);
    }, { passive: true });
    if (saved === undefined) return;
    let frames = 0;
    const restore = () => {
      frame = undefined;
      const last = ++frames >= MAX_FRAMES;
      if (element.isConnected && (last || element.scrollHeight - element.clientHeight >= saved)) {
        element.scrollTop = saved;
      } else if (!last) {
        frame = requestAnimationFrame(restore);
        return;
      }
      restoring = false;
    };
    restore();
  };
}
