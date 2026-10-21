import { createSignal, createEffect, onCleanup, For, Show } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { useScrollToAnchor } from "../lib/useScrollToAnchor";
import { buildConversationUrl } from "../lib/routes";
import type { TimelineEvent, TimelineConversationPane } from "../lib/types";
import DateSidebar from "./timeline/DateSidebar";
import DayTimeline from "./timeline/DayTimeline";
import ConversationPane from "./timeline/ConversationPane";
import MapPane from "./timeline/MapPane";
import SummaryPane from "./timeline/SummaryPane";
import JournalPane from "./timeline/JournalPane";
import GoToDateDialog from "./timeline/GoToDateDialog";
import KeyboardShortcutsDialog from "./timeline/KeyboardShortcutsDialog";
import ManualEventModal from "./ManualEventModal";
import TransportEventModal from "./TransportEventModal";
import { fetchEvent } from "../lib/api";
import { getToday, resolveTimelineDate } from "../lib/timelineDate";
import { useDeleteManualEvent } from "../lib/queries";

// Generate unique pane ID
function generatePaneId(): string {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function TimelineView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const deleteManualEventMutation = useDeleteManualEvent();

  const selectedDate = (): string => resolveTimelineDate(searchParams.date);

  // Map visibility from URL
  const showMapPane = () => searchParams.map === "true";

  // Summary pane visibility from URL
  const showSummaryPane = () => searchParams.summary === "true";

  // Journal pane visibility from URL
  const showJournalPane = () => searchParams.journal === "true";

  // Conversation panes (ephemeral workspace, not in URL)
  const [conversationPanes, setConversationPanes] = createSignal<TimelineConversationPane[]>([]);

  // Event highlight from URL hash + local state for map clicks
  const [localHighlightId, setLocalHighlightId] = createSignal<number | undefined>(undefined);
  const hashHighlightId = useScrollToAnchor();
  const highlightEventId = () => localHighlightId() ?? hashHighlightId();

  // Dialog state
  const [showGoToDateDialog, setShowGoToDateDialog] = createSignal(false);
  const [showHelpDialog, setShowHelpDialog] = createSignal(false);
  // Manual event modal state
  const [showEventModal, setShowEventModal] = createSignal(false);
  const [eventModalDate, setEventModalDate] = createSignal<string | undefined>(undefined);
  const [editingEvent, setEditingEvent] = createSignal<TimelineEvent | undefined>(undefined);
  // Transport event modal state
  const [showTransportModal, setShowTransportModal] = createSignal(false);
  const [transportModalDate, setTransportModalDate] = createSignal<string | undefined>(undefined);
  const [editingTransport, setEditingTransport] = createSignal<TimelineEvent | undefined>(undefined);

  // Navigation helpers
  const openConversation = (event: TimelineEvent) => {
    if (!event.conversation_id) return;
    navigate(buildConversationUrl(event.source, event.conversation_id, event.id));
  };

  // Handle add event from DayTimeline
  const handleAddEvent = (date: string) => {
    setEventModalDate(date);
    setEditingEvent(undefined);
    setShowEventModal(true);
  };

  // Handle add transport from DayTimeline
  const handleAddTransport = (date: string) => {
    setTransportModalDate(date);
    setEditingTransport(undefined);
    setShowTransportModal(true);
  };

  // Handle edit event - route to correct modal based on type
  const handleEditEvent = (event: TimelineEvent) => {
    if (event.type.startsWith("transport:")) {
      setEditingTransport(event);
      setTransportModalDate(undefined);
      setShowTransportModal(true);
    } else {
      setEditingEvent(event);
      setEventModalDate(undefined);
      setShowEventModal(true);
    }
  };

  // Handle delete event
  const handleDeleteEvent = async (event: TimelineEvent) => {
    if (!confirm(`Delete "${event.title}"?`)) return;
    try {
      await deleteManualEventMutation.mutateAsync({ id: event.id, event, date: selectedDate() });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete event");
    }
  };

  // Handle date changes - update URL
  const handleDateChange = (date: string) => {
    setSearchParams({ date: date === getToday() ? undefined : date }, { replace: true });
  };

  // Toggle map pane - update URL
  const toggleMapPane = () => {
    setSearchParams({ map: showMapPane() ? undefined : "true" }, { replace: true });
  };

  // Close map pane - update URL
  const closeMapPane = () => {
    setSearchParams({ map: undefined }, { replace: true });
  };

  // Toggle summary pane - update URL
  const toggleSummaryPane = () => {
    setSearchParams({ summary: showSummaryPane() ? undefined : "true" }, { replace: true });
  };

  // Close summary pane - update URL
  const closeSummaryPane = () => {
    setSearchParams({ summary: undefined }, { replace: true });
  };

  // Toggle journal pane - update URL
  const toggleJournalPane = () => {
    setSearchParams({ journal: showJournalPane() ? undefined : "true" }, { replace: true });
  };

  // Close journal pane - update URL
  const closeJournalPane = () => {
    setSearchParams({ journal: undefined }, { replace: true });
  };

  // Handle map marker click - highlight event in timeline
  const handleMapEventClick = (eventId: number) => {
    setLocalHighlightId(eventId);
    // Clear highlight after a delay so it can be re-triggered
    setTimeout(() => setLocalHighlightId(undefined), 2000);
  };

  // Add a conversation pane (no-op if one for the same conversation is already open)
  const addConversationPane = (conversationId: string, title: string, source: string, sourceAccount?: string, focusEventId?: number) => {
    const existing = conversationPanes().find(
      p =>
        p.conversationId === conversationId &&
        p.conversationSource === source &&
        p.conversationSourceAccount === sourceAccount
    );
    if (existing) return;
    const newPane: TimelineConversationPane = {
      id: generatePaneId(),
      conversationId,
      conversationTitle: title,
      conversationSource: source,
      conversationSourceAccount: sourceAccount,
      focusEventId,
    };
    setConversationPanes([...conversationPanes(), newPane]);
  };

  // When the URL hash highlights a message event (e.g. someone landed via
  // /event/<id>), auto-open the corresponding conversation pane scrolled to
  // that event. Tracks last-handled id so we don't re-trigger on unrelated
  // re-renders.
  let lastAutoOpened: number | undefined;
  createEffect(() => {
    const id = hashHighlightId();
    if (!id || id === lastAutoOpened) return;
    lastAutoOpened = id;

    fetchEvent(id).then((event) => {
      if (!event || !event.conversation_id || !event.title || !event.type?.startsWith("message")) return;
      const alreadyOpen = conversationPanes().some(
        (p) =>
          p.conversationSource === event.source &&
          p.conversationId === event.conversation_id &&
          (p.conversationSourceAccount ?? undefined) === (event.source_account ?? undefined),
      );
      if (alreadyOpen) return;
      addConversationPane(event.conversation_id, event.title, event.source, event.source_account ?? undefined, event.id);
    }).catch((err) => {
      console.warn("[TimelineView] Failed to auto-open pane for event", id, err);
    });
  });

  // Remove a conversation pane
  const removeConversationPane = (paneId: string) => {
    setConversationPanes(conversationPanes().filter(p => p.id !== paneId));
  };

  // Handle opening a conversation - adds it as a pane
  const handleOpenInPane = (event: TimelineEvent) => {
    if (!event.conversation_id || !event.title) return;
    addConversationPane(
      event.conversation_id,
      event.title,
      event.source,
      event.source_account || undefined,
      event.id
    );
  };

  // Navigate to previous day
  const goToPrevDay = () => {
    const current = new Date(selectedDate() + "T12:00:00Z");
    current.setDate(current.getDate() - 1);
    handleDateChange(current.toISOString().slice(0, 10));
  };

  // Navigate to next day
  const goToNextDay = () => {
    const current = new Date(selectedDate() + "T12:00:00Z");
    current.setDate(current.getDate() + 1);
    handleDateChange(current.toISOString().slice(0, 10));
  };

  // Keyboard navigation
  const handleKeyDown = (e: KeyboardEvent) => {
    // Don't capture if user is typing in an input
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }

    // Don't capture if a dialog is open (let dialog handle its own keys)
    if (showGoToDateDialog() || showHelpDialog() || showEventModal()) {
      return;
    }

    if (e.key === "ArrowLeft" || (e.key === "p" && !e.metaKey && !e.ctrlKey)) {
      e.preventDefault();
      goToPrevDay();
    } else if (e.key === "ArrowRight" || (e.key === "n" && !e.metaKey && !e.ctrlKey)) {
      e.preventDefault();
      goToNextDay();
    } else if (e.key === "t" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      handleDateChange(getToday());
    } else if (e.key === "g" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      setShowGoToDateDialog(true);
    } else if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      setShowHelpDialog(true);
    } else if (e.key === "m" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      toggleMapPane();
    } else if (e.key === "s" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      toggleSummaryPane();
    } else if (e.key === "j" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      toggleJournalPane();
    }
  };

  // Add keyboard listener
  createEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown);
    });
  });

  // Calculate widths based on number of panes
  // +1 for timeline, +1 if map is shown
  const totalPanes = () => conversationPanes().length + 1 + (showMapPane() ? 1 : 0) + (showSummaryPane() ? 1 : 0) + (showJournalPane() ? 1 : 0);
  const paneWidth = () => `${100 / totalPanes()}%`;

  return (
    <div class="h-full flex">
      {/* Date sidebar */}
      <aside aria-label="Date navigation" class="hidden w-72 shrink-0 border-r border-border lg:block">
        <DateSidebar
          selectedDate={selectedDate()}
          onSelectDate={handleDateChange}
        />
      </aside>

      {/* Main content area with timeline, map, and conversation panes */}
      <div class="flex-1 min-w-0 flex overflow-x-auto">
        {/* Timeline pane */}
        <div
          class="min-w-full shrink-0 border-r border-border md:min-w-[300px]"
          classList={{ "hidden md:block": totalPanes() > 1 }}
          style={{ width: paneWidth() }}
        >
          <DayTimeline
            date={selectedDate()}
            highlightEventId={highlightEventId()}
            onOpenConversation={openConversation}
            onOpenInWorkspace={handleOpenInPane}
            onDateChange={handleDateChange}
            onOpenDatePicker={() => setShowGoToDateDialog(true)}
            showMapToggle
            isMapOpen={showMapPane()}
            onToggleMap={toggleMapPane}
            showSummaryToggle
            isSummaryOpen={showSummaryPane()}
            onToggleSummary={toggleSummaryPane}
            showJournalToggle
            isJournalOpen={showJournalPane()}
            onToggleJournal={toggleJournalPane}
            onAddEvent={handleAddEvent}
            onAddTransport={handleAddTransport}
            onEditEvent={handleEditEvent}
            onDeleteEvent={handleDeleteEvent}
          />
        </div>

        {/* Journal pane */}
        <Show when={showJournalPane()}>
          <div
            class="min-w-full shrink-0 border-r border-border md:min-w-[300px]"
            style={{ width: paneWidth() }}
          >
            <JournalPane
              date={selectedDate()}
              onClose={closeJournalPane}
            />
          </div>
        </Show>

        {/* Summary pane */}
        <Show when={showSummaryPane()}>
          <div
            class="min-w-full shrink-0 border-r border-border md:min-w-[300px]"
            style={{ width: paneWidth() }}
          >
            <SummaryPane
              date={selectedDate()}
              onClose={closeSummaryPane}
            />
          </div>
        </Show>

        {/* Map pane */}
        <Show when={showMapPane()}>
          <div
            class="min-w-full shrink-0 border-r border-border md:min-w-[300px]"
            style={{ width: paneWidth() }}
          >
            <MapPane
              date={selectedDate()}
              onClose={closeMapPane}
              onEventClick={handleMapEventClick}
            />
          </div>
        </Show>

        {/* Conversation panes */}
        <For each={conversationPanes()}>
          {(pane) => (
            <div
              class="min-w-full shrink-0 border-r border-border last:border-r-0 md:min-w-[300px]"
              style={{ width: paneWidth() }}
            >
              <ConversationPane
                pane={pane}
                onClose={() => removeConversationPane(pane.id)}
              />
            </div>
          )}
        </For>
      </div>

      {/* Dialogs */}
      <GoToDateDialog
        isOpen={showGoToDateDialog()}
        currentDate={selectedDate()}
        onClose={() => setShowGoToDateDialog(false)}
        onSelectDate={handleDateChange}
      />
      <KeyboardShortcutsDialog
        isOpen={showHelpDialog()}
        onClose={() => setShowHelpDialog(false)}
      />

      {/* Manual Event Modal */}
      <ManualEventModal
        isOpen={showEventModal()}
        onClose={() => {
          setShowEventModal(false);
          setEventModalDate(undefined);
          setEditingEvent(undefined);
        }}
        defaultDate={eventModalDate()}
        editEvent={editingEvent()}
        onSuccess={() => {
          setShowEventModal(false);
          setEventModalDate(undefined);
          setEditingEvent(undefined);
        }}
      />

      {/* Transport Event Modal */}
      <TransportEventModal
        isOpen={showTransportModal()}
        onClose={() => {
          setShowTransportModal(false);
          setTransportModalDate(undefined);
          setEditingTransport(undefined);
        }}
        defaultDate={transportModalDate()}
        editEvent={editingTransport()}
        onSuccess={() => {
          setShowTransportModal(false);
          setTransportModalDate(undefined);
          setEditingTransport(undefined);
        }}
      />
    </div>
  );
}
