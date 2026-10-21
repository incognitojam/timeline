import { renderHook, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageScroller, type MessagePage, type MessagePageDelta } from "./createMessageScroller";

// Controllable IntersectionObserver: records instances so a test can find the
// observer watching a given sentinel and fire its callback to simulate the
// reader scrolling that sentinel into view.
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  static reset() {
    MockIntersectionObserver.instances = [];
  }
  static findObserving(el: Element): MockIntersectionObserver | undefined {
    return MockIntersectionObserver.instances.find((o) => o.elements.has(el));
  }
  callback: IntersectionObserverCallback;
  elements = new Set<Element>();
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.elements.add(el);
  }
  unobserve(el: Element) {
    this.elements.delete(el);
  }
  disconnect() {
    this.elements.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  trigger(isIntersecting: boolean) {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

beforeEach(() => {
  MockIntersectionObserver.reset();
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A viewport with a stubbed scrollTo (jsdom doesn't lay out / implement it).
function makeViewport() {
  const el = document.createElement("div");
  el.scrollTo = vi.fn();
  return el;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function page<T>(over: Partial<MessagePage<T>> & Pick<MessagePage<T>, "items">): MessagePage<T> {
  return { hasBefore: false, hasAfter: false, beforeCursor: null, afterCursor: null, ...over };
}

describe("createMessageScroller", () => {
  it("loads the initial page and exposes its cursor state", async () => {
    const { result } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1, 2, 3], hasBefore: true, beforeCursor: "b1" }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter: async () => ({ items: [], hasMore: false, nextCursor: null }),
      })
    );
    result.viewportRef(makeViewport());

    await waitFor(() => expect(result.isLoading()).toBe(false));
    expect(result.items()).toEqual([1, 2, 3]);
    expect(result.hasBefore()).toBe(true);
    expect(result.hasAfter()).toBe(false);
  });

  it("prepends older messages when the top sentinel intersects", async () => {
    const loadBefore = vi.fn(
      async (): Promise<MessagePageDelta<number>> => ({ items: [-1, 0], hasMore: false, nextCursor: null })
    );
    const { result } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1, 2], hasBefore: true, beforeCursor: "b1" }),
        loadBefore,
        loadAfter: async () => ({ items: [], hasMore: false, nextCursor: null }),
      })
    );
    result.viewportRef(makeViewport());
    const topSentinel = document.createElement("div");
    result.topSentinelRef(topSentinel);

    await waitFor(() => expect(result.isLoading()).toBe(false));
    const observer = await waitFor(() => {
      const o = MockIntersectionObserver.findObserving(topSentinel);
      expect(o).toBeDefined();
      return o;
    });

    observer?.trigger(true);

    await waitFor(() => expect(result.items()).toEqual([-1, 0, 1, 2]));
    expect(loadBefore).toHaveBeenCalledWith("b1");
    expect(result.hasBefore()).toBe(false);
  });

  it("appends newer messages when the bottom sentinel intersects", async () => {
    const loadAfter = vi.fn(
      async (): Promise<MessagePageDelta<number>> => ({ items: [3, 4], hasMore: true, nextCursor: "a2" })
    );
    const { result } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1, 2], hasAfter: true, afterCursor: "a1" }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter,
      })
    );
    result.viewportRef(makeViewport());
    const bottomSentinel = document.createElement("div");
    result.bottomSentinelRef(bottomSentinel);

    await waitFor(() => expect(result.isLoading()).toBe(false));
    const observer = await waitFor(() => {
      const o = MockIntersectionObserver.findObserving(bottomSentinel);
      expect(o).toBeDefined();
      return o;
    });

    observer?.trigger(true);

    await waitFor(() => expect(result.items()).toEqual([1, 2, 3, 4]));
    expect(loadAfter).toHaveBeenCalledWith("a1");
    expect(result.hasAfter()).toBe(true);
  });

  it("does not paginate past an exhausted edge", async () => {
    const loadBefore = vi.fn(
      async (): Promise<MessagePageDelta<number>> => ({ items: [], hasMore: false, nextCursor: null })
    );
    const { result } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1, 2], hasBefore: false }),
        loadBefore,
        loadAfter: async () => ({ items: [], hasMore: false, nextCursor: null }),
      })
    );
    result.viewportRef(makeViewport());
    const topSentinel = document.createElement("div");
    result.topSentinelRef(topSentinel);

    await waitFor(() => expect(result.isLoading()).toBe(false));
    await waitFor(() => expect(MockIntersectionObserver.findObserving(topSentinel)).toBeDefined());

    MockIntersectionObserver.findObserving(topSentinel)?.trigger(true);

    expect(loadBefore).not.toHaveBeenCalled();
  });

  it("reloads from scratch when the key changes", async () => {
    const [key, setKey] = createSignal("a");
    const loadInitial = vi.fn(async (): Promise<MessagePage<string>> => {
      return key() === "a" ? page({ items: ["a1", "a2"] }) : page({ items: ["b1"] });
    });
    const { result } = renderHook(() =>
      createMessageScroller<string>({
        key,
        loadInitial,
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter: async () => ({ items: [], hasMore: false, nextCursor: null }),
      })
    );
    result.viewportRef(makeViewport());

    await waitFor(() => expect(result.items()).toEqual(["a1", "a2"]));

    setKey("b");

    await waitFor(() => expect(result.items()).toEqual(["b1"]));
    expect(loadInitial).toHaveBeenCalledTimes(2);
  });

  it("runs onInitialLoad after the first page settles", async () => {
    const onInitialLoad = vi.fn();
    const { result } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1] }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter: async () => ({ items: [], hasMore: false, nextCursor: null }),
        onInitialLoad,
      })
    );
    result.viewportRef(makeViewport());

    await waitFor(() => expect(onInitialLoad).toHaveBeenCalledTimes(1));
    expect(onInitialLoad).toHaveBeenCalledWith(result);
  });

  it("surfaces an error from the initial load", async () => {
    const { result } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => {
          throw new Error("boom");
        },
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter: async () => ({ items: [], hasMore: false, nextCursor: null }),
      })
    );
    result.viewportRef(makeViewport());

    await waitFor(() => expect(result.isLoading()).toBe(false));
    expect(result.error()).toContain("boom");
    expect(result.items()).toEqual([]);
  });

  it("scrolls the viewport to the live edge on scrollToEnd", async () => {
    const viewport = makeViewport();
    Object.defineProperty(viewport, "scrollHeight", { value: 1234, configurable: true });
    const { result } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1] }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter: async () => ({ items: [], hasMore: false, nextCursor: null }),
      })
    );
    result.viewportRef(viewport);

    await waitFor(() => expect(result.isLoading()).toBe(false));
    result.scrollToEnd();

    expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 1234, behavior: "instant" });
  });

  it("scrolls a loaded message into view by id", async () => {
    const viewport = makeViewport();
    const target = document.createElement("div");
    target.id = "event-42";
    target.scrollIntoView = vi.fn();
    viewport.append(target);
    const outsideTarget = document.createElement("div");
    outsideTarget.id = "event-42";
    outsideTarget.scrollIntoView = vi.fn();
    document.body.append(outsideTarget);
    const { result } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [42] }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter: async () => ({ items: [], hasMore: false, nextCursor: null }),
        messageElementId: (id) => `event-${id}`,
      })
    );
    result.viewportRef(viewport);

    await waitFor(() => expect(result.isLoading()).toBe(false));

    expect(result.scrollToMessage(42, "smooth", "nearest")).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });
    expect(outsideTarget.scrollIntoView).not.toHaveBeenCalled();

    outsideTarget.remove();
  });

  it("returns false when a message is not loaded", async () => {
    const { result } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1] }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter: async () => ({ items: [], hasMore: false, nextCursor: null }),
        messageElementId: (id) => `event-${id}`,
      })
    );
    result.viewportRef(makeViewport());

    await waitFor(() => expect(result.isLoading()).toBe(false));

    expect(result.scrollToMessage(2)).toBe(false);
  });

  it("tracks isAtEnd as the reader scrolls away from and back to the live edge", async () => {
    let scrollHeight = 100;
    const viewport = makeViewport();
    Object.defineProperty(viewport, "scrollHeight", { get: () => scrollHeight, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { value: 100, configurable: true });
    viewport.scrollTop = 0;
    const { result } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1, 2] }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter: async () => ({ items: [], hasMore: false, nextCursor: null }),
      })
    );
    result.viewportRef(viewport);

    // Opens pinned to the bottom (nothing to scroll).
    await waitFor(() => expect(result.isAtEnd()).toBe(true));

    // Content grows above the fold and the reader stays scrolled up.
    scrollHeight = 300;
    viewport.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(result.isAtEnd()).toBe(false));

    // Scrolling back to the bottom re-pins.
    viewport.scrollTop = 200;
    viewport.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(result.isAtEnd()).toBe(true));
  });

  it("auto-refetches newer messages from the newest loaded item cursor", async () => {
    const loadAfter = vi.fn(async (cursor: string): Promise<MessagePageDelta<number>> => {
      return cursor === "c2"
        ? { items: [3], hasMore: false, nextCursor: null }
        : { items: [], hasMore: false, nextCursor: null };
    });
    const { result, cleanup } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1, 2] }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter,
        autoRefetch: {
          intervalMs: 5,
          getCursor: (item) => `c${item}`,
        },
      })
    );
    result.viewportRef(makeViewport());

    await waitFor(() => expect(result.items()).toEqual([1, 2, 3]));

    expect(loadAfter).toHaveBeenCalledWith("c2");
    cleanup();
  });

  it("keeps the viewport pinned to the end when auto-refetched messages arrive at the live edge", async () => {
    let scrollHeight = 100;
    const viewport = makeViewport();
    Object.defineProperty(viewport, "scrollHeight", { get: () => scrollHeight, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { value: 100, configurable: true });
    viewport.scrollTop = 0;
    const loadAfter = vi.fn(async (cursor: string): Promise<MessagePageDelta<number>> => {
      if (cursor !== "c2") return { items: [], hasMore: false, nextCursor: null };
      scrollHeight = 150;
      return { items: [3], hasMore: false, nextCursor: null };
    });
    const { result, cleanup } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1, 2] }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter,
        autoRefetch: {
          intervalMs: 5,
          getCursor: (item) => `c${item}`,
        },
      })
    );
    result.viewportRef(viewport);

    await waitFor(() => expect(result.items()).toEqual([1, 2, 3]));
    await waitFor(() => {
      expect(viewport.scrollTo).toHaveBeenCalledWith({ top: 150, behavior: "instant" });
    });

    cleanup();
  });

  it("preserves scrollTop when auto-refetched messages arrive while the reader is away from the end", async () => {
    let scrollHeight = 300;
    const viewport = makeViewport();
    Object.defineProperty(viewport, "scrollHeight", { get: () => scrollHeight, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { value: 100, configurable: true });
    viewport.scrollTop = 50;
    const loadAfter = vi.fn(async (cursor: string): Promise<MessagePageDelta<number>> => {
      if (cursor !== "c2") return { items: [], hasMore: false, nextCursor: null };
      scrollHeight = 350;
      return { items: [3], hasMore: false, nextCursor: null };
    });
    const { result, cleanup } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1, 2] }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter,
        autoRefetch: {
          intervalMs: 5,
          getCursor: (item) => `c${item}`,
        },
      })
    );
    result.viewportRef(viewport);

    await waitFor(() => expect(result.items()).toEqual([1, 2, 3]));
    await wait(20);

    expect(viewport.scrollTop).toBe(50);
    expect(viewport.scrollTo).not.toHaveBeenCalled();
    cleanup();
  });

  it("does not auto-refetch while a newer page is already known", async () => {
    const loadAfter = vi.fn(
      async (): Promise<MessagePageDelta<number>> => ({ items: [], hasMore: false, nextCursor: null })
    );
    const { result, cleanup } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1, 2], hasAfter: true, afterCursor: "a1" }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter,
        autoRefetch: {
          intervalMs: 5,
          getCursor: (item) => `c${item}`,
        },
      })
    );
    result.viewportRef(makeViewport());

    await waitFor(() => expect(result.isLoading()).toBe(false));
    await wait(20);

    expect(loadAfter).not.toHaveBeenCalled();
    cleanup();
  });

  it("uses the dedicated auto-refetch loader when provided", async () => {
    const loadAfter = vi.fn(
      async (): Promise<MessagePageDelta<number>> => ({ items: [], hasMore: false, nextCursor: null })
    );
    const loadFreshAfter = vi.fn(
      async (cursor: string): Promise<MessagePageDelta<number>> => cursor === "c2"
        ? { items: [3], hasMore: false, nextCursor: null }
        : { items: [], hasMore: false, nextCursor: null }
    );
    const { result, cleanup } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1, 2] }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter,
        autoRefetch: {
          intervalMs: 5,
          getCursor: (item) => `c${item}`,
          loadAfter: loadFreshAfter,
        },
      })
    );
    result.viewportRef(makeViewport());

    await waitFor(() => expect(result.items()).toEqual([1, 2, 3]));

    expect(loadFreshAfter).toHaveBeenCalledWith("c2");
    expect(loadAfter).not.toHaveBeenCalled();
    cleanup();
  });

  it("does not auto-refetch when the newest item has no cursor", async () => {
    const loadAfter = vi.fn(
      async (): Promise<MessagePageDelta<number>> => ({ items: [], hasMore: false, nextCursor: null })
    );
    const { result, cleanup } = renderHook(() =>
      createMessageScroller<number>({
        key: () => "k",
        loadInitial: async () => page({ items: [1, 2] }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter,
        autoRefetch: {
          intervalMs: 5,
          getCursor: () => null,
        },
      })
    );
    result.viewportRef(makeViewport());

    await waitFor(() => expect(result.isLoading()).toBe(false));
    await wait(20);

    expect(loadAfter).not.toHaveBeenCalled();
    cleanup();
  });

  it("ignores stale auto-refetch responses after the key changes", async () => {
    const [key, setKey] = createSignal("a");
    const staleAfter = deferred<MessagePageDelta<number>>();
    const loadAfter = vi.fn(async (cursor: string): Promise<MessagePageDelta<number>> => {
      if (cursor === "c2") return staleAfter.promise;
      return { items: [], hasMore: false, nextCursor: null };
    });
    const { result, cleanup } = renderHook(() =>
      createMessageScroller<number>({
        key,
        loadInitial: async () => key() === "a" ? page({ items: [1, 2] }) : page({ items: [10, 20] }),
        loadBefore: async () => ({ items: [], hasMore: false, nextCursor: null }),
        loadAfter,
        autoRefetch: {
          intervalMs: 5,
          getCursor: (item) => `c${item}`,
        },
      })
    );
    result.viewportRef(makeViewport());

    await waitFor(() => expect(loadAfter).toHaveBeenCalledWith("c2"));
    setKey("b");
    await waitFor(() => expect(result.items()).toEqual([10, 20]));

    staleAfter.resolve({ items: [3], hasMore: false, nextCursor: null });
    await wait(20);

    expect(result.items()).toEqual([10, 20]);
    cleanup();
  });
});
