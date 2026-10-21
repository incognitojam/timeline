import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { DateActivity } from "../../lib/dateActivityQueries";
import { buildActivityRows, findRowForDate, formatMonthLabel } from "./dateRows";

const ROW_HEIGHT = 32;
const OVERSCAN = 5;

interface Props {
  dates: readonly DateActivity[];
  isLoading: boolean;
  selectedDate: string;
  onSelectDate: (date: string) => void;
}

// Format date for display
function formatDateLabel(dateStr: string): { day: string; date: string } {
  const date = new Date(dateStr + "T12:00:00Z");
  const day = date.toLocaleDateString([], { weekday: "short" });
  const dateNum = date.toLocaleDateString([], { day: "numeric" });
  return { day, date: dateNum };
}

export default function DateActivityList(props: Props) {
  let containerRef: HTMLDivElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [containerHeight, setContainerHeight] = createSignal(400);
  const activityByDate = createMemo(
    () => new Map(props.dates.map((activity) => [activity.date, activity])),
  );

  // Update container height after mount and on resize
  onMount(() => {
    if (containerRef) {
      setContainerHeight(containerRef.clientHeight);

      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContainerHeight(entry.contentRect.height);
        }
      });
      resizeObserver.observe(containerRef);
      onCleanup(() => resizeObserver.disconnect());
    }
  });

  const allDates = createMemo(() => props.dates.map((activity) => activity.date));

  const activityScaleByMonth = createMemo(() => {
    const countsByMonth = new Map<string, number[]>();
    for (const activity of props.dates) {
      const month = activity.date.slice(0, 7);
      const counts = countsByMonth.get(month) ?? [];
      counts.push(activity.eventCount);
      countsByMonth.set(month, counts);
    }
    return new Map(
      [...countsByMonth].map(([month, counts]) => {
        counts.sort((a, b) => a - b);
        return [month, counts[Math.ceil(counts.length * 0.9) - 1]];
      }),
    );
  });

  const rows = createMemo(() => buildActivityRows(allDates()));
  const monthSections = createMemo(() => {
    const list = rows();
    const sections: { month: string; start: number; end: number }[] = [];
    for (const [index, row] of list.entries()) {
      if (row.kind !== "month") continue;
      const previous = sections.at(-1);
      if (previous) previous.end = index * ROW_HEIGHT;
      sections.push({
        month: row.month,
        start: index * ROW_HEIGHT,
        end: list.length * ROW_HEIGHT,
      });
    }
    return sections;
  });
  const visibleMonthSections = createMemo(() =>
    monthSections().filter(
      (section) =>
        section.end > scrollTop() &&
        section.start < scrollTop() + containerHeight() + OVERSCAN * ROW_HEIGHT,
    ),
  );

  // Calculate virtual list state
  const virtualState = createMemo(() => {
    const list = rows();
    const height = containerHeight();
    const scroll = scrollTop();

    const totalHeight = list.length * ROW_HEIGHT;
    const firstVisibleIndex = Math.max(
      0,
      Math.floor(scroll / ROW_HEIGHT) - OVERSCAN,
    );
    const visibleCount = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
    const lastVisibleIndex = Math.min(
      list.length,
      firstVisibleIndex + visibleCount,
    );

    return {
      totalHeight,
      visibleRows: list.slice(firstVisibleIndex, lastVisibleIndex),
      offsetTop: firstVisibleIndex * ROW_HEIGHT,
    };
  });

  // A refresh can prepend a newly active date. Hold the viewport on the rows it
  // was showing instead of shifting someone reading further back in history.
  createEffect(
    on(rows, (list, previous) => {
      const previousFirst = previous?.[0];
      if (!previousFirst || !containerRef) return;
      const prepended = list.findIndex((row) => row.key === previousFirst.key);
      if (prepended <= 0) return;
      const top = containerRef.scrollTop + prepended * ROW_HEIGHT;
      containerRef.scrollTop = top;
      setScrollTop(top);
    }),
  );

  const handleScroll = (e: Event) => {
    const target = e.currentTarget as HTMLDivElement;
    setScrollTop(target.scrollTop);
  };

  // Centre the selected date once the index arrives, settling for the nearest
  // active day when the selected day has no events of its own.
  let centred: { date: string; exact: boolean } | null = null;
  createEffect(() => {
    const date = props.selectedDate;
    const match = findRowForDate(rows(), date);
    if (!containerRef || !match) return;
    if (centred?.date === date && (centred.exact || !match.exact)) return;

    centred = { date, exact: match.exact };
    // Jump rather than animate so a pending index refresh cannot cancel the
    // movement halfway through and leave the selected day off screen.
    const top = Math.max(
      0,
      match.index * ROW_HEIGHT - containerRef.clientHeight / 2 + ROW_HEIGHT / 2,
    );
    containerRef.scrollTop = top;
    setScrollTop(top);
  });

  return (
    <div class="absolute inset-0 overflow-hidden">
      <div
        ref={containerRef}
        class="absolute inset-0 overflow-auto scrollbar-hide px-1"
        onScroll={handleScroll}
      >
        <Show
          when={allDates().length > 0 || !props.isLoading}
          fallback={
            <div class="text-center py-4 text-sm text-muted-foreground">
              Loading...
            </div>
          }
        >
          <div
            style={{
              height: `${virtualState().totalHeight}px`,
              position: "relative",
            }}
          >
            <For each={visibleMonthSections()}>
              {(section) => (
                <div
                  class="pointer-events-none absolute inset-x-0"
                  style={{
                    top: `${section.start}px`,
                    height: `${section.end - section.start}px`,
                  }}
                >
                  <div
                    class="pointer-events-auto sticky top-0 z-20 bg-card"
                    style={{ height: `${ROW_HEIGHT}px` }}
                  >
                    <MonthDivider month={section.month} />
                  </div>
                </div>
              )}
            </For>
            <div
              style={{
                position: "absolute",
                top: `${virtualState().offsetTop}px`,
                width: "100%",
              }}
            >
              <For each={virtualState().visibleRows}>
                {(row) => (
                  <div style={{ height: `${ROW_HEIGHT}px` }}>
                    <Show when={row.kind === "date" ? row : undefined}>
                      {(dateRow) => {
                        const date = dateRow().date;
                        const activity = createMemo(() =>
                          activityByDate().get(date),
                        );
                        const label = formatDateLabel(date);
                        const scale = () =>
                          activityScaleByMonth().get(date.slice(0, 7)) ?? 0;
                        const barWidth = () => {
                          const count = activity()?.eventCount ?? 0;
                          return scale() > 0
                            ? `${Math.min(100, (count / scale()) * 100)}%`
                            : "0%";
                        };
                        const isSelected = () => date === props.selectedDate;

                        return (
                          <button
                            data-date={date}
                            aria-current={isSelected() ? "date" : undefined}
                            // The selection ring is a box-shadow, which
                            // transition-colors leaves out: it would snap
                            // into place while the background faded in
                            // after it.
                            class={`w-full h-full flex items-center gap-2 px-2 rounded text-sm transition-[color,background-color,box-shadow] relative ${
                              isSelected()
                                ? "bg-accent ring-1 ring-inset ring-ring z-10"
                                : "hover:bg-accent z-0"
                            }`}
                            onClick={() => props.onSelectDate(date)}
                          >
                            {/* Day name */}
                            <span class="w-8 text-xs text-muted-foreground shrink-0">
                              {label.day}
                            </span>

                            {/* Date number */}
                            <span
                              class={`w-5 text-xs shrink-0 ${isSelected() ? "font-bold" : ""}`}
                            >
                              {label.date}
                            </span>

                            {/* Activity bar */}
                            <div
                              class="h-2 flex-1 overflow-hidden rounded-full bg-muted"
                              title={`Full bar: ${scale()} events or more this month`}
                              aria-hidden="true"
                            >
                              <div
                                class="h-full rounded-full bg-primary"
                                style={{ width: barWidth() }}
                              />
                            </div>

                            {/* Event count */}
                            <span class="text-xs text-muted-foreground min-w-8 text-right shrink-0">
                              {activity()?.eventCount ?? 0}
                            </span>
                          </button>
                        );
                      }}
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}

function MonthDivider(props: { month: string }) {
  return (
    <div class="flex h-full items-center gap-2 px-2">
      <span class="shrink-0 text-[11px] font-semibold uppercase tracking-wide">
        {formatMonthLabel(props.month)}
      </span>
      <div class="h-px flex-1 bg-border" />
    </div>
  );
}
