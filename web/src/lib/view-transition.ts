import { useIsRouting, useLocation, useNavigate } from "@solidjs/router";
import { createSignal, startTransition } from "solid-js";

/**
 * Shared-element navigation with the View Transitions API.
 *
 * A list row and its detail page both name the same element (artwork, title)
 * with `sharedElementName(key, part)`. Only the item being navigated carries a
 * name, so a page never holds two elements with one name and the rest of the
 * list crossfades with the page instead of animating row by row.
 *
 * A named element is treated as one object flying between its two boxes (see
 * app.css). Text takes `sharedTextStyle(key, part)` instead: it moves at its
 * natural size and crossfades between the two type sizes.
 */

/** Longest the old page stays frozen waiting for the new one to commit. */
const MAX_UPDATE_MS = 300;

const [activeKey, setActiveKey] = createSignal<string | null>(null);
let latestClick = 0;

/** `view-transition-name` for `part` of `key`, set only while `key` is the shared item. */
export function sharedElementName(key: string, part: string): string | undefined {
  if (activeKey() !== key) return undefined;
  // Lowercase: Chrome lowercases the name in an animate() pseudoElement, so a
  // mixed-case name could not be animated from flyAsOne. One key is active at
  // a time, so two keys differing only in case never collide.
  return `${part}-${key}`.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

/**
 * Style naming `part` of `key` as shared text. Browsers without
 * `view-transition-class` (Chrome 111–124) would treat it as an object and
 * scale the glyphs, so there it stays unnamed and fades with the page.
 */
export function sharedTextStyle(key: string, part: string) {
  if (!CSS.supports("view-transition-class", "shared-text")) return {};
  return { "view-transition-name": sharedElementName(key, part), "view-transition-class": "shared-text" };
}

type Box = { width: number; height: number; radius: string };

/** Size and corner radius of every element named for the transition. */
function measureShared(): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const element of document.querySelectorAll<HTMLElement>('[style*="view-transition-name"]')) {
    const style = getComputedStyle(element);
    const name = style.getPropertyValue("view-transition-name");
    if (name === "none" || style.getPropertyValue("view-transition-class") === "shared-text") continue;
    const rect = element.getBoundingClientRect();
    boxes.set(name, { width: rect.width, height: rect.height, radius: style.borderRadius });
  }
  return boxes;
}

/**
 * The CSS shows one snapshot of each shared object for the whole flight. Show
 * the larger end's, which never has to be scaled up, and animate the corner
 * radius between the two ends with the group's own timing.
 */
function flyAsOne(before: Map<string, Box>, after: Map<string, Box>): Animation[] {
  const root = document.documentElement;
  const flights: Animation[] = [];
  for (const [name, a] of before) {
    const b = after.get(name);
    if (!b) continue;
    const group = getComputedStyle(root, `::view-transition-group(${name})`);
    const timing = {
      duration: Number.parseFloat(group.animationDuration) * 1000,
      easing: group.animationTimingFunction,
      // Hold the end state until the transition tears down (the caller cancels
      // them then), should any other animation outlast these.
      fill: "forwards" as const,
    };
    const hidden = a.width * a.height > b.width * b.height ? "new" : "old";
    flights.push(
      root.animate({ borderRadius: [a.radius, b.radius] }, { ...timing, pseudoElement: `::view-transition-group(${name})` }),
      root.animate({ opacity: [0, 0] }, { ...timing, pseudoElement: `::view-transition-${hidden}(${name})` }),
    );
  }
  return flights;
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
    // The snapshot ignores clipping by scroll containers and the transition
    // paints above everything, so a link partly hidden under the mobile nav
    // bar or a list's edge would start its flight on top of them.
    event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    // Name this item's elements now, so the old snapshot includes them.
    setActiveKey(key);
    const before = measureShared();
    let after = new Map<string, Box>();
    const transition = document.startViewTransition(async () => {
      // The browser calls this a frame later. A navigation started meanwhile
      // (a newer click, another link, Back) wins over this one.
      if (click !== latestClick || isRouting() || location.pathname + location.search !== from) return;
      // The router navigates inside a Solid transition, which commits the new
      // route to the DOM before its promise settles; joining it here makes the
      // browser snapshot the new page only once it is there. The timeout keeps
      // a destination that suspends from freezing the old page.
      const committed = await Promise.race([
        startTransition(() => navigate(url.pathname + url.search + url.hash)).then(() => true),
        new Promise<false>((resolve) => setTimeout(resolve, MAX_UPDATE_MS, false)),
      ]);
      // Animating now would fly the element to where it already is; let the
      // navigation finish without a transition instead.
      if (!committed) {
        transition.skipTransition();
        return;
      }
      // A remounted list starts at the top; bring the shared element into view
      // so the morph lands where the eye can follow it.
      // "nearest" also scrolls any clipping list container, and is a no-op
      // when the element is already in view.
      const shared = document.querySelector<HTMLElement>('[style*="view-transition-name"]');
      const rect = shared?.getBoundingClientRect();
      const offscreen = rect !== undefined && (rect.top < 0 || rect.bottom > window.innerHeight);
      shared?.scrollIntoView({ block: offscreen ? "center" : "nearest" });
      after = measureShared();
    });
    // A newer transition or navigation skips this one; that is not an error.
    transition.ready.then(() => {
      const flights = flyAsOne(before, after);
      const land = () => {
        for (const flight of flights) flight.cancel();
      };
      transition.finished.then(land, land);
    }, () => {});
    transition.finished.catch(() => {});
  };
}
