import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js";

/**
 * Headless bidirectional-pagination + scroll engine for conversation
 * transcripts. Owns the loaded window, the older/newer cursor state, the
 * IntersectionObserver sentinels that prefetch on scroll, and the scroll-
 * position bookkeeping that keeps the reader's place when pages are prepended
 * or appended.
 *
 * Consumers supply the source-specific fetches (different API param shapes,
 * identity-cache population, etc.) and the scroller drives the rest. The
 * primitive is generic over the item type so it stays decoupled from
 * TimelineEvent; per-page side data (attachments, breadcrumbs) is the
 * consumer's to accumulate inside the load callbacks.
 *
 * Inspired by shadcn's MessageScroller.
 */

/** Full initial window for a conversation. */
export interface MessagePage<T> {
  items: T[];
  hasBefore: boolean;
  hasAfter: boolean;
  beforeCursor: string | null;
  afterCursor: string | null;
}

/** An older (prepended) or newer (appended) page. */
export interface MessagePageDelta<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface MessageScrollerOptions<T> {
  /**
   * Reactive reload key. When it changes the list is torn down and reloaded
   * from {@link loadInitial} — e.g. `() => `${source()}-${title()}`` or
   * `() => props.pane.id`.
   */
  key: Accessor<unknown>;
  /** Load the initial window for the current key. */
  loadInitial: () => Promise<MessagePage<T>>;
  /** Load older items, prepended above the current window. */
  loadBefore: (cursor: string) => Promise<MessagePageDelta<T>>;
  /** Load newer items, appended below the current window. */
  loadAfter: (cursor: string) => Promise<MessagePageDelta<T>>;
  /**
   * Runs once after the initial page has painted (the sentinels and items are
   * in the DOM). Use it to settle the viewport — scroll to a focused message,
   * or call `scroller.scrollToEnd()` to open at the live edge.
   */
  onInitialLoad?: (scroller: MessageScroller<T>) => void;
  /**
   * Maps an application message id to the DOM id rendered for that message.
   * Used by `scrollToMessage`. Default: `message-${id}`.
   */
  messageElementId?: (id: string | number) => string;
  /** How far outside the viewport to begin prefetching. Default `"500px"`. */
  rootMargin?: string;
  /**
   * Poll for newer messages after the current newest item while the loaded
   * window is already at the live edge. Consumers provide cursor creation so
   * the scroll engine stays decoupled from the item shape.
   */
  autoRefetch?: {
    intervalMs: number;
    getCursor: (item: T) => string | null;
    /** Fetch a fresh page for polling when cached pagination pages may still be fresh. */
    loadAfter?: (cursor: string) => Promise<MessagePageDelta<T>>;
    /** Distance from the bottom that still counts as pinned. Default `32`. */
    stickToEndThresholdPx?: number;
  };
}

export interface MessageScroller<T> {
  items: Accessor<T[]>;
  isLoading: Accessor<boolean>;
  isLoadingBefore: Accessor<boolean>;
  isLoadingAfter: Accessor<boolean>;
  hasBefore: Accessor<boolean>;
  hasAfter: Accessor<boolean>;
  /**
   * Whether the viewport is pinned to the bottom of the loaded content (within
   * the stick-to-end threshold). Drives a jump-to-latest control: hide it when
   * the reader is already at the live edge, show it when they've scrolled up.
   */
  isAtEnd: Accessor<boolean>;
  error: Accessor<string | null>;
  /** Attach to the scrollable viewport element. */
  viewportRef: (el: HTMLElement) => void;
  /** Attach to a zero-height sentinel rendered above the first item. */
  topSentinelRef: (el: HTMLElement) => void;
  /** Attach to a zero-height sentinel rendered below the last item. */
  bottomSentinelRef: (el: HTMLElement) => void;
  /** Jump the viewport to the newest item. */
  scrollToEnd: (behavior?: ScrollBehavior) => void;
  /** Jump the viewport to the oldest item. */
  scrollToStart: (behavior?: ScrollBehavior) => void;
  /** Scroll a rendered message into view. Returns false if it is not loaded. */
  scrollToMessage: (id: string | number, behavior?: ScrollBehavior, block?: ScrollLogicalPosition) => boolean;
}

// rAF where available (browser), falling back to a macrotask under jsdom so
// the post-load scroll/observer wiring still runs in tests.
const raf: (cb: () => void) => void =
  typeof requestAnimationFrame !== "undefined" ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 0);

/** Run `fn` after the next paint, once the latest DOM mutations are laid out. */
function afterPaint(fn: () => void): void {
  raf(() => raf(fn));
}

export function createMessageScroller<T>(options: MessageScrollerOptions<T>): MessageScroller<T> {
  const rootMargin = options.rootMargin ?? "500px";
  const messageElementId = options.messageElementId ?? ((id: string | number) => `message-${id}`);

  const [items, setItems] = createSignal<T[]>([]);
  const [isLoading, setIsLoading] = createSignal(true);
  const [isLoadingBefore, setIsLoadingBefore] = createSignal(false);
  const [isLoadingAfter, setIsLoadingAfter] = createSignal(false);
  const [beforeCursor, setBeforeCursor] = createSignal<string | null>(null);
  const [afterCursor, setAfterCursor] = createSignal<string | null>(null);
  const [hasBefore, setHasBefore] = createSignal(false);
  const [hasAfter, setHasAfter] = createSignal(false);
  const [isAtEnd, setIsAtEnd] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  let viewportEl: HTMLElement | undefined;
  let topSentinelEl: HTMLElement | undefined;
  let bottomSentinelEl: HTMLElement | undefined;
  let topObserver: IntersectionObserver | undefined;
  let bottomObserver: IntersectionObserver | undefined;
  let autoRefetchTimer: ReturnType<typeof setInterval> | undefined;
  let isAutoRefetching = false;
  let loadGeneration = 0;
  let scrollRafScheduled = false;

  const isPinnedToEnd = (viewport: HTMLElement): boolean => {
    const threshold = options.autoRefetch?.stickToEndThresholdPx ?? 32;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= threshold;
  };

  const updateIsAtEnd = () => {
    if (viewportEl) setIsAtEnd(isPinnedToEnd(viewportEl));
  };

  // rAF-throttle scroll updates so streaming/momentum scrolling doesn't churn
  // the signal once per scroll event.
  const onViewportScroll = () => {
    if (scrollRafScheduled) return;
    scrollRafScheduled = true;
    raf(() => {
      scrollRafScheduled = false;
      updateIsAtEnd();
    });
  };

  const isCurrentGeneration = (generation: number): boolean => generation === loadGeneration;

  const disconnectObservers = () => {
    topObserver?.disconnect();
    bottomObserver?.disconnect();
    topObserver = undefined;
    bottomObserver = undefined;
  };

  const connectObservers = () => {
    const viewport = viewportEl;
    if (!viewport) return;
    if (topSentinelEl) {
      topObserver = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting && hasBefore() && !isLoadingBefore() && !isAutoRefetching) loadBefore();
        },
        { root: viewport, rootMargin }
      );
      topObserver.observe(topSentinelEl);
    }
    if (bottomSentinelEl) {
      bottomObserver = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting && hasAfter() && !isLoadingAfter() && !isAutoRefetching) loadAfter();
        },
        { root: viewport, rootMargin }
      );
      bottomObserver.observe(bottomSentinelEl);
    }
  };

  // Prepend older messages, holding the reader's place by growing scrollTop by
  // exactly the height the new content added above the viewport.
  const loadBefore = async () => {
    const cursor = beforeCursor();
    const viewport = viewportEl;
    if (!cursor || isLoadingBefore() || isAutoRefetching || !hasBefore() || !viewport) return;

    setIsLoadingBefore(true);
    const scrollHeightBefore = viewport.scrollHeight;
    const generation = loadGeneration;
    try {
      const delta = await options.loadBefore(cursor);
      if (!isCurrentGeneration(generation)) return;
      setItems((prev) => [...delta.items, ...prev]);
      setHasBefore(delta.hasMore);
      setBeforeCursor(delta.nextCursor);
      raf(() => {
        if (!isCurrentGeneration(generation)) return;
        viewport.scrollTop += viewport.scrollHeight - scrollHeightBefore;
        setIsLoadingBefore(false);
      });
    } catch (e) {
      if (!isCurrentGeneration(generation)) return;
      setError(String(e));
      setIsLoadingBefore(false);
    }
  };

  // Append newer messages, holding scrollTop steady so the appended content
  // doesn't yank the viewport.
  const loadAfter = async () => {
    const cursor = afterCursor();
    const viewport = viewportEl;
    if (!cursor || isLoadingAfter() || isAutoRefetching || !hasAfter() || !viewport) return;

    setIsLoadingAfter(true);
    const generation = loadGeneration;
    try {
      const delta = await options.loadAfter(cursor);
      if (!isCurrentGeneration(generation)) return;
      // Capture right before the DOM update to minimize drift from momentum scrolling.
      const scrollTopBefore = viewport.scrollTop;
      setItems((prev) => [...prev, ...delta.items]);
      setHasAfter(delta.hasMore);
      setAfterCursor(delta.nextCursor);
      raf(() => {
        if (!isCurrentGeneration(generation)) return;
        viewport.scrollTop = scrollTopBefore;
        setIsLoadingAfter(false);
        updateIsAtEnd();
      });
    } catch (e) {
      if (!isCurrentGeneration(generation)) return;
      setError(String(e));
      setIsLoadingAfter(false);
    }
  };

  const autoRefetchAfterNewest = async () => {
    const autoRefetch = options.autoRefetch;
    const viewport = viewportEl;
    if (!autoRefetch || !viewport || isLoading() || isLoadingBefore() || isLoadingAfter() || isAutoRefetching || hasAfter()) {
      return;
    }

    const currentItems = items();
    const newest = currentItems[currentItems.length - 1];
    if (!newest) return;

    const cursor = autoRefetch.getCursor(newest);
    if (!cursor) return;

    isAutoRefetching = true;
    const generation = loadGeneration;
    const wasPinnedToEnd = isPinnedToEnd(viewport);
    const scrollTopBefore = viewport.scrollTop;
    try {
      const delta = await (autoRefetch.loadAfter ?? options.loadAfter)(cursor);
      if (!isCurrentGeneration(generation)) return;
      const receivedItems = delta.items.length > 0;
      if (receivedItems) {
        setItems((prev) => [...prev, ...delta.items]);
      }
      setHasAfter(delta.hasMore);
      setAfterCursor(delta.nextCursor);
      raf(() => {
        if (!isCurrentGeneration(generation)) return;
        if (receivedItems) {
          if (wasPinnedToEnd) {
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
          } else {
            viewport.scrollTop = scrollTopBefore;
          }
        }
        isAutoRefetching = false;
        updateIsAtEnd();
      });
    } catch (e) {
      if (!isCurrentGeneration(generation)) return;
      setError(String(e));
      isAutoRefetching = false;
    }
  };

  const reload = async () => {
    const generation = ++loadGeneration;
    disconnectObservers();
    isAutoRefetching = false;
    setIsLoading(true);
    setIsLoadingBefore(false);
    setIsLoadingAfter(false);
    setError(null);
    setItems([]);
    setHasBefore(false);
    setHasAfter(false);
    setBeforeCursor(null);
    setAfterCursor(null);

    try {
      const page = await options.loadInitial();
      if (!isCurrentGeneration(generation)) return;
      setItems(page.items);
      setHasBefore(page.hasBefore);
      setHasAfter(page.hasAfter);
      setBeforeCursor(page.beforeCursor);
      setAfterCursor(page.afterCursor);
    } catch (e) {
      if (!isCurrentGeneration(generation)) return;
      setError(String(e));
    } finally {
      if (isCurrentGeneration(generation)) setIsLoading(false);
    }

    // Once the initial page is painted, wire the prefetch sentinels and let the
    // consumer settle the viewport (scroll to a focused message or the edge).
    afterPaint(() => {
      if (!isCurrentGeneration(generation)) return;
      connectObservers();
      options.onInitialLoad?.(scroller);
      updateIsAtEnd();
    });
  };

  createEffect(on(options.key, reload));
  if (options.autoRefetch) {
    autoRefetchTimer = setInterval(() => {
      void autoRefetchAfterNewest();
    }, options.autoRefetch.intervalMs);
  }
  onCleanup(() => {
    loadGeneration++;
    disconnectObservers();
    if (autoRefetchTimer) clearInterval(autoRefetchTimer);
    viewportEl?.removeEventListener("scroll", onViewportScroll);
  });

  const scrollToEnd = (behavior: ScrollBehavior = "instant") => {
    viewportEl?.scrollTo({ top: viewportEl.scrollHeight, behavior });
  };
  const scrollToStart = (behavior: ScrollBehavior = "instant") => {
    viewportEl?.scrollTo({ top: 0, behavior });
  };
  const findMessageElement = (id: string | number): HTMLElement | null => {
    const targetId = messageElementId(id);
    if (viewportEl) {
      if (viewportEl.id === targetId) return viewportEl;
      for (const el of viewportEl.querySelectorAll<HTMLElement>("[id]")) {
        if (el.id === targetId) return el;
      }
      return null;
    }
    if (typeof document === "undefined") return null;
    return document.getElementById(targetId);
  };
  const scrollToMessage = (
    id: string | number,
    behavior: ScrollBehavior = "instant",
    block: ScrollLogicalPosition = "center"
  ): boolean => {
    const el = findMessageElement(id);
    if (!el) return false;
    el.scrollIntoView({ behavior, block });
    return true;
  };

  const scroller: MessageScroller<T> = {
    items,
    isLoading,
    isLoadingBefore,
    isLoadingAfter,
    hasBefore,
    hasAfter,
    isAtEnd,
    error,
    viewportRef: (el) => {
      viewportEl = el;
      el.addEventListener("scroll", onViewportScroll, { passive: true });
    },
    topSentinelRef: (el) => {
      topSentinelEl = el;
    },
    bottomSentinelRef: (el) => {
      bottomSentinelEl = el;
    },
    scrollToEnd,
    scrollToStart,
    scrollToMessage,
  };

  return scroller;
}
