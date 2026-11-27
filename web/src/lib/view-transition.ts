import { useIsRouting, useLocation, useNavigate } from "@solidjs/router";
import { createSignal, startTransition } from "solid-js";

/**
 * Shared-element navigation with the View Transitions API.
 *
 * A list row and its detail page both name the same element (artwork, title)
 * with `sharedElementName(key, part)`. Only the item being navigated carries a
 * name, so a page never holds two elements with one name and the rest of the
 * list crossfades with the page instead of animating row by row.
 */

/** Longest the old page stays frozen waiting for the new one to commit. */
const MAX_UPDATE_MS = 300;

const [activeKey, setActiveKey] = createSignal<string | null>(null);
let latestClick = 0;

/** `view-transition-name` for `part` of `key`, set only while `key` is the shared item. */
export function sharedElementName(key: string, part: string): string | undefined {
  if (activeKey() !== key) return undefined;
  return `${part}-${key}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function canAnimate(): boolean {
  return (
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Click handler for a link whose destination shares `key`'s elements. Plain
 * left clicks navigate inside a view transition; anything else (modified
 * clicks, no API, reduced motion) is left to the router as an ordinary link.
 *
 * The destination must render the shared elements without suspending, from
 * data already in the query cache, or the morph lands on the old page.
 */
export function useSharedElementLink() {
  const navigate = useNavigate();
  const location = useLocation();
  const isRouting = useIsRouting();
  return (key: string) => (event: MouseEvent & { currentTarget: HTMLAnchorElement }) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !canAnimate()
    ) {
      return;
    }
    // Runs before the router's document listener, which skips prevented clicks.
    event.preventDefault();
    const url = new URL(event.currentTarget.href);
    const from = location.pathname + location.search;
    const click = ++latestClick;
    // Name this item's elements now, so the old snapshot includes them.
    setActiveKey(key);
    const transition = document.startViewTransition(async () => {
      // The browser calls this a frame later. A navigation started meanwhile
      // (a newer click, another link, Back) wins over this one.
      if (click !== latestClick || isRouting() || location.pathname + location.search !== from) return;
      // The router navigates inside a Solid transition, which commits the new
      // route to the DOM before its promise settles; joining it here makes the
      // browser snapshot the new page only once it is there. The timeout keeps
      // a destination that suspends from freezing the old page.
      await Promise.race([
        startTransition(() => navigate(url.pathname + url.search + url.hash)),
        new Promise((resolve) => setTimeout(resolve, MAX_UPDATE_MS)),
      ]);
      // A remounted list starts at the top; bring the shared element into view
      // so the morph lands where the eye can follow it.
      // "nearest" also scrolls any clipping list container, and is a no-op
      // when the element is already in view.
      const shared = document.querySelector<HTMLElement>('[style*="view-transition-name"]');
      const rect = shared?.getBoundingClientRect();
      const offscreen = rect !== undefined && (rect.top < 0 || rect.bottom > window.innerHeight);
      shared?.scrollIntoView({ block: offscreen ? "center" : "nearest" });
    });
    // A newer transition or navigation skips this one; that is not an error.
    transition.ready.catch(() => {});
    transition.finished.catch(() => {});
  };
}
