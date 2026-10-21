import { createEffect, onCleanup } from "solid-js";

interface InfiniteScrollSentinelProps {
  /**
   * Opaque token that re-arms the observer when the underlying query identity
   * changes (filters, data updates). The callback always reads live props, so
   * this only needs to change when the sentinel should re-subscribe.
   */
  version: string;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

/**
 * Bottom-of-list sentinel that fetches the next page as it scrolls into view,
 * shared by the infinite-scroll media grids.
 */
export default function InfiniteScrollSentinel(props: InfiniteScrollSentinelProps) {
  let sentinelRef: HTMLDivElement | undefined;

  createEffect(() => {
    void props.version;
    if (!sentinelRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && props.hasNextPage && !props.isFetchingNextPage) {
          props.onLoadMore();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(sentinelRef);
    onCleanup(() => observer.disconnect());
  });

  return <div ref={sentinelRef} class="h-1" />;
}
