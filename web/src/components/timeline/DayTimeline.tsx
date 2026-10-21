import { type EventGroupData, groupEvents } from "@shared/grouping";
import { useNavigate } from "@solidjs/router";
import { createEffect, createResource, createSignal, For, on, onCleanup, Show, Suspense } from "solid-js";
import { fetchTrackImages } from "../../lib/api";
import { dayHasGoogleHealthSleep, isDailyHealthMetric, isFitbitSleep } from "../../lib/health-events";
import { hiddenSources } from "../../lib/hiddenSourcesStore";
import { navigateToIdentity } from "../../lib/identities";
import { useDayEvents } from "../../lib/queries";
import { getAlbumArtUrl, getTrackUri } from "../../lib/spotify-art";
import { staleContentClass } from "../../lib/stale-content";
import type { TimelineEvent } from "../../lib/types";
import { IconAdd, IconAutoAwesome, IconChevronLeft, IconChevronRight, IconEditNote, IconMap, IconMenuBook, IconTrain } from "../../ui/icons";
import EventGroup from "./EventGroup";
import DayHealthPanel from "./DayHealthPanel";
import SourceFilterButton from "./SourceFilterButton";
import TimeSection from "./TimeSection";

interface Props {
  date: string;  // YYYY-MM-DD
  highlightEventId?: number;
  onOpenConversation?: (event: TimelineEvent) => void;
  onOpenInWorkspace?: (event: TimelineEvent) => void;
  onDateChange?: (date: string) => void;
  onOpenDatePicker: () => void;
  // Map pane controls
  showMapToggle?: boolean;
  isMapOpen?: boolean;
  onToggleMap?: () => void;
  // Summary pane controls
  showSummaryToggle?: boolean;
  isSummaryOpen?: boolean;
  onToggleSummary?: () => void;
  // Journal pane controls
  showJournalToggle?: boolean;
  isJournalOpen?: boolean;
  onToggleJournal?: () => void;
  // Manual event entry
  onAddEvent?: (date: string) => void;
  onAddTransport?: (date: string) => void;
  onEditEvent?: (event: TimelineEvent) => void;
  onDeleteEvent?: (event: TimelineEvent) => void;
}

// Normalize timestamp to string
function toTimestampString(ts: string | Date | null): string | null {
  if (!ts) return null;
  if (typeof ts === "string") return ts;
  if (ts instanceof Date) return ts.toISOString();
  return null;
}

// Get hour from timestamp
function getHour(ts: string | Date | null): number {
  if (!ts) return 0;
  const str = toTimestampString(ts);
  if (!str) return 0;
  return parseInt(str.slice(11, 13));
}

// Group events by time-of-day period
function groupByPeriod(groups: EventGroupData<TimelineEvent>[]): {
  morning: EventGroupData<TimelineEvent>[];
  afternoon: EventGroupData<TimelineEvent>[];
  evening: EventGroupData<TimelineEvent>[];
  night: EventGroupData<TimelineEvent>[];
} {
  const periods = {
    morning: [] as EventGroupData<TimelineEvent>[],
    afternoon: [] as EventGroupData<TimelineEvent>[],
    evening: [] as EventGroupData<TimelineEvent>[],
    night: [] as EventGroupData<TimelineEvent>[],
  };

  for (const group of groups) {
    const hour = getHour(group.timeRange.start);
    if (hour >= 6 && hour < 12) {
      periods.morning.push(group);
    } else if (hour >= 12 && hour < 18) {
      periods.afternoon.push(group);
    } else if (hour >= 18 && hour < 24) {
      periods.evening.push(group);
    } else {
      periods.night.push(group);
    }
  }

  return periods;
}

// Format date for header
function formatDateHeader(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00Z");
  return date.toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Storage key for expanded groups
const EXPANDED_GROUPS_KEY = "timeline:expandedGroups";

// Load expanded groups from localStorage
function loadExpandedGroups(): Set<string> {
  try {
    const stored = localStorage.getItem(EXPANDED_GROUPS_KEY);
    if (stored) {
      return new Set(JSON.parse(stored));
    }
  } catch {
    // Ignore errors
  }
  return new Set();
}

// Save expanded groups to localStorage
function saveExpandedGroups(groups: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_GROUPS_KEY, JSON.stringify(Array.from(groups)));
  } catch {
    // Ignore errors
  }
}

export default function DayTimeline(props: Props) {
  const navigate = useNavigate();
  const dayEventsQuery = useDayEvents(() => ({ date: props.date }));
  const data = () => dayEventsQuery.data ?? null;
  const error = () => dayEventsQuery.error ? String(dayEventsQuery.error) : null;
  const dayEventsAreStale = () => dayEventsQuery.isPlaceholderData;
  const [expandedGroups, setExpandedGroups] = createSignal<Set<string>>(loadExpandedGroups());
  // Fetch cached album art for Spotify events that don't have images in raw_data
  const [trackImageMap] = createResource(
    () => {
      // The source memo is owned above the local timeline Suspense boundary.
      // Only read the Query resource once its initial request has settled so a
      // pending day fetch cannot charge the route-level boundary instead.
      if (dayEventsQuery.isPending || dayEventsQuery.isLoadingError) {
        return undefined;
      }
      const dayData = data();
      if (!dayData) return undefined;
      const uris = new Set<string>();
      for (const event of dayData.events) {
        if (event.source !== "spotify" && event.source !== "spotify-friends") continue;
        if (getAlbumArtUrl(event.raw_data)) continue;
        const uri = getTrackUri(event.raw_data);
        if (uri) uris.add(uri);
      }
      return uris.size > 0 ? [...uris] : undefined;
    },
    async (uris) => {
      const images = await fetchTrackImages(uris);
      return new Map(Object.entries(images));
    }
  );

  let scrollContainerRef: HTMLDivElement | undefined;
  const eventRefs = new Map<number, HTMLDivElement>();

  // Set ref for an event
  const setEventRef = (eventId: number, el: HTMLDivElement) => {
    eventRefs.set(eventId, el);
  };

  // Scroll to highlighted event after the day's data has rendered.
  createEffect(on(
    () => [data(), props.highlightEventId] as const,
    ([dayData, eventId]) => {
      if (dayData && eventId) {
        // Wait for refs to be set after render
        setTimeout(() => {
          const targetRef = eventRefs.get(eventId);
          if (targetRef) {
            targetRef.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }, 100);
      }
    }
  ));

  // Handle group expansion changes
  const handleExpandedChange = (groupId: string, expanded: boolean) => {
    const current = new Set(expandedGroups());
    if (expanded) {
      current.add(groupId);
    } else {
      current.delete(groupId);
    }
    setExpandedGroups(current);
    saveExpandedGroups(current);
  };

  // Handle person click
  const handlePersonClick = async (identifier: string, source: string, e: MouseEvent) => {
    e.stopPropagation();
    await navigateToIdentity(navigate, identifier, source);
  };

  // Filter out daily health metrics (handled by health panel) and any sources
  // the user has hidden via the SourceFilterButton. Plain derived accessors (not
  // createMemo): a memo's owner — and thus the Suspense boundary its data() read
  // charges — is fixed at its creation site (the component body, under the route
  // boundary), so a memo would suspend the whole page. A plain thunk instead runs
  // under whatever computation calls it — here the <Show>/<Suspense> in the
  // content area below — so the pending fetch only suspends the event list.
  const filteredEvents = () => {
    const d = data();
    if (!d) return [];
    const hidden = hiddenSources();
    // google-health is the canonical health source; on days it provides sleep,
    // suppress the duplicate fitbit sleep so the same night isn't shown twice.
    const ghSleep = dayHasGoogleHealthSleep(d.events);
    return d.events.filter(e => {
      if (isDailyHealthMetric(e)) return false;
      if (ghSleep && isFitbitSleep(e)) return false;
      if (hidden.has(e.source)) return false;
      return true;
    });
  };

  const periods = () => {
    const events = filteredEvents();
    if (events.length === 0 && !data()) return null;
    // First group events, then split by time period
    const grouped = groupEvents(events);
    return groupByPeriod(grouped);
  };

  // Navigate to previous/next day
  const goToPrevDay = () => {
    const current = new Date(props.date + "T12:00:00Z");
    current.setDate(current.getDate() - 1);
    const newDate = current.toISOString().slice(0, 10);
    props.onDateChange?.(newDate);
  };

  const goToNextDay = () => {
    const current = new Date(props.date + "T12:00:00Z");
    current.setDate(current.getDate() + 1);
    const newDate = current.toISOString().slice(0, 10);
    props.onDateChange?.(newDate);
  };

  return (
    <div class="h-full flex flex-col">
      {/* Day Header */}
      <div class="shrink-0 border-b border-border bg-card px-2 py-2 sm:px-4 sm:py-3 lg:flex lg:items-center lg:justify-between lg:gap-4">
        <div class="flex min-w-0 items-center gap-1 sm:gap-2">
          <button
            type="button"
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={goToPrevDay}
            aria-label="Previous day"
            title="Previous day"
          >
            <IconChevronLeft class="h-5 w-5" aria-hidden />
          </button>
          <button
            type="button"
            class="min-h-12 min-w-0 flex-1 rounded-xl px-2 py-1 text-center transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:text-left"
            onClick={props.onOpenDatePicker}
            aria-label={`Choose date, currently ${formatDateHeader(props.date)}`}
          >
            <h1 class="truncate font-display text-lg font-semibold sm:text-2xl">{formatDateHeader(props.date)}</h1>
            <p class={`text-xs text-muted-foreground ${staleContentClass(dayEventsAreStale())}`} aria-busy={dayEventsAreStale()}>
              <Suspense fallback={null}>
                <Show when={data()}>
                  {(d) => <>{d().summary.totalEvents.toLocaleString()} events</>}
                </Show>
              </Suspense>
            </p>
          </button>
          <button
            type="button"
            class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={goToNextDay}
            aria-label="Next day"
            title="Next day"
          >
            <IconChevronRight class="h-5 w-5" aria-hidden />
          </button>
        </div>

        {/* Header actions */}
        <div class="mt-2 flex items-center justify-center border-t border-border pt-2 lg:mt-0 lg:shrink-0 lg:border-t-0 lg:pt-0">
          {/* Add event button with dropdown */}
          <Show when={props.onAddEvent}>
            {(_) => {
              const [showMenu, setShowMenu] = createSignal(false);
              let menuRef: HTMLDivElement | undefined;

              // Close on outside click
              const handleClickOutside = (e: MouseEvent) => {
                if (menuRef && !menuRef.contains(e.target as Node)) {
                  setShowMenu(false);
                }
              };

              createEffect(() => {
                if (!showMenu()) return;
                document.addEventListener("click", handleClickOutside, true);
                onCleanup(() => document.removeEventListener("click", handleClickOutside, true));
              });

              return (
                <div class="relative" ref={menuRef}>
                  <button
                    type="button"
                    class="flex h-12 w-12 items-center justify-center rounded-xl transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    onClick={() => setShowMenu(!showMenu())}
                    aria-label="Add event"
                    aria-expanded={showMenu()}
                    aria-haspopup="menu"
                    title="Add event"
                  >
                    <IconAdd class="h-5 w-5" aria-hidden />
                  </button>
                  <Show when={showMenu()}>
                    <div
                      class="absolute left-0 top-full z-20 mt-1 min-w-[160px] rounded-xl border border-border bg-popover py-1 text-popover-foreground shadow-lg sm:left-auto sm:right-0"
                      role="menu"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        class="flex min-h-12 w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                        onClick={() => { setShowMenu(false); props.onAddEvent?.(props.date); }}
                      >
                        <IconEditNote class="h-5 w-5 text-muted-foreground" aria-hidden />
                        Note
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        class="flex min-h-12 w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                        onClick={() => { setShowMenu(false); props.onAddTransport?.(props.date); }}
                      >
                        <IconTrain class="h-5 w-5 text-muted-foreground" aria-hidden />
                        Transport
                      </button>
                    </div>
                  </Show>
                </div>
              );
            }}
          </Show>

          {/* Journal toggle button */}
          <Show when={props.showJournalToggle}>
            <button
              type="button"
              class={`flex h-12 w-12 items-center justify-center rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                props.isJournalOpen
                  ? "bg-secondary text-secondary-foreground"
                  : "hover:bg-accent"
              }`}
              onClick={props.onToggleJournal}
              aria-label={props.isJournalOpen ? "Hide journal" : "Show journal"}
              aria-pressed={Boolean(props.isJournalOpen)}
              title={props.isJournalOpen ? "Hide journal (j)" : "Show journal (j)"}
            >
              <IconMenuBook class="h-5 w-5" aria-hidden />
            </button>
          </Show>

          {/* Summary toggle button */}
          <Show when={props.showSummaryToggle}>
            <button
              type="button"
              class={`flex h-12 w-12 items-center justify-center rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                props.isSummaryOpen
                  ? "bg-secondary text-secondary-foreground"
                  : "hover:bg-accent"
              }`}
              onClick={props.onToggleSummary}
              aria-label={props.isSummaryOpen ? "Hide AI summary" : "Show AI summary"}
              aria-pressed={Boolean(props.isSummaryOpen)}
              title={props.isSummaryOpen ? "Hide AI summary (s)" : "Show AI summary (s)"}
            >
              <IconAutoAwesome class="h-5 w-5" aria-hidden />
            </button>
          </Show>

          {/* Map toggle button */}
          <Show when={props.showMapToggle}>
            <button
              type="button"
              class={`flex h-12 w-12 items-center justify-center rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                props.isMapOpen
                  ? "bg-secondary text-secondary-foreground"
                  : "hover:bg-accent"
              }`}
              onClick={props.onToggleMap}
              aria-label={props.isMapOpen ? "Hide map" : "Show map"}
              aria-pressed={Boolean(props.isMapOpen)}
              title={props.isMapOpen ? "Hide map (m)" : "Show map (m)"}
            >
              <IconMap class="h-5 w-5" aria-hidden />
            </button>
          </Show>

          {/* Source filter button */}
          <div class={staleContentClass(dayEventsAreStale())} aria-busy={dayEventsAreStale()}>
            <Suspense fallback={<SourceFilterButton bySource={undefined} />}>
              <SourceFilterButton bySource={data()?.summary.bySource} />
            </Suspense>
          </div>
        </div>
      </div>

      {/* Timeline content. A local <Suspense> keeps the header/toggles above
          mounted while the day-events fetch is pending — only this area shows a
          fallback. periods()/data() are read here (under this boundary), so
          their suspension is caught locally rather than bubbling to the route. */}
      <div ref={scrollContainerRef} class="flex-1 overflow-auto p-4">
        <Suspense fallback={
          <div class="flex items-center justify-center py-8 text-sm text-muted-foreground">
            Loading events...
          </div>
        }>
        <Show when={error()}>
          <div class="text-center py-8 text-red-500">Error: {error()}</div>
        </Show>

        <Show when={periods()}>
          {(p) => (<>
            {/* Health Stats Panel */}
            <DayHealthPanel date={props.date} />

            <div class={staleContentClass(dayEventsAreStale())} aria-busy={dayEventsAreStale()}>
              {/* Night Section (12am-6am) */}
              <Show when={p().night.length > 0}>
                <TimeSection label="Night">
                  <For each={p().night}>
                    {(group) => (
                      <EventGroup
                        group={group}
                        highlightEventId={props.highlightEventId}
                        defaultExpanded={expandedGroups().has(group.id)}
                        trackImageMap={trackImageMap()}
                        attachmentsByEvent={data()?.attachments}
                        onOpenConversation={props.onOpenConversation}
                        onOpenInWorkspace={props.onOpenInWorkspace}
                        onPersonClick={handlePersonClick}
                        onExpandedChange={handleExpandedChange}
                        setEventRef={setEventRef}
                        onEditEvent={props.onEditEvent}
                        onDeleteEvent={props.onDeleteEvent}
                        onToggleJournal={props.onToggleJournal}
                      />
                    )}
                  </For>
                </TimeSection>
              </Show>

              {/* Morning Section (6am-12pm) */}
              <Show when={p().morning.length > 0}>
                <TimeSection label="Morning">
                  <For each={p().morning}>
                    {(group) => (
                      <EventGroup
                        group={group}
                        highlightEventId={props.highlightEventId}
                        defaultExpanded={expandedGroups().has(group.id)}
                        trackImageMap={trackImageMap()}
                        attachmentsByEvent={data()?.attachments}
                        onOpenConversation={props.onOpenConversation}
                        onOpenInWorkspace={props.onOpenInWorkspace}
                        onPersonClick={handlePersonClick}
                        onExpandedChange={handleExpandedChange}
                        setEventRef={setEventRef}
                        onEditEvent={props.onEditEvent}
                        onDeleteEvent={props.onDeleteEvent}
                        onToggleJournal={props.onToggleJournal}
                      />
                    )}
                  </For>
                </TimeSection>
              </Show>

              {/* Afternoon Section (12pm-6pm) */}
              <Show when={p().afternoon.length > 0}>
                <TimeSection label="Afternoon">
                  <For each={p().afternoon}>
                    {(group) => (
                      <EventGroup
                        group={group}
                        highlightEventId={props.highlightEventId}
                        defaultExpanded={expandedGroups().has(group.id)}
                        trackImageMap={trackImageMap()}
                        attachmentsByEvent={data()?.attachments}
                        onOpenConversation={props.onOpenConversation}
                        onOpenInWorkspace={props.onOpenInWorkspace}
                        onPersonClick={handlePersonClick}
                        onExpandedChange={handleExpandedChange}
                        setEventRef={setEventRef}
                        onEditEvent={props.onEditEvent}
                        onDeleteEvent={props.onDeleteEvent}
                        onToggleJournal={props.onToggleJournal}
                      />
                    )}
                  </For>
                </TimeSection>
              </Show>

              {/* Evening Section (6pm-12am) */}
              <Show when={p().evening.length > 0}>
                <TimeSection label="Evening">
                  <For each={p().evening}>
                    {(group) => (
                      <EventGroup
                        group={group}
                        highlightEventId={props.highlightEventId}
                        defaultExpanded={expandedGroups().has(group.id)}
                        trackImageMap={trackImageMap()}
                        attachmentsByEvent={data()?.attachments}
                        onOpenConversation={props.onOpenConversation}
                        onOpenInWorkspace={props.onOpenInWorkspace}
                        onPersonClick={handlePersonClick}
                        onExpandedChange={handleExpandedChange}
                        setEventRef={setEventRef}
                        onEditEvent={props.onEditEvent}
                        onDeleteEvent={props.onDeleteEvent}
                        onToggleJournal={props.onToggleJournal}
                      />
                    )}
                  </For>
                </TimeSection>
              </Show>

              {/* Empty state */}
              <Show when={
                p().morning.length === 0 &&
                p().afternoon.length === 0 &&
                p().evening.length === 0 &&
                p().night.length === 0
              }>
                <div class="text-center py-8 text-muted-foreground">
                  No events for this day
                </div>
              </Show>
            </div>
          </>)}
        </Show>
        </Suspense>
      </div>
    </div>
  );
}
