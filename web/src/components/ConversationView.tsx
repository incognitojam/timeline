import { useLocation, useNavigate, useParams } from "@solidjs/router";
import { sourceLabel } from "@shared/sources";
import { useQueryClient } from "@tanstack/solid-query";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import {
  aggregateAIMeta,
  extractAIMeta,
  getCodingProjectName,
  getParentToolUseId,
  hasRenderableAIContent,
  isAIEventSource,
  parseAIContent,
} from "../lib/ai-events";
import { type Attachment, createTimelineEventCursor } from "../lib/api";
import type { ContentBlock } from "../lib/content-blocks";
import {
  CONVERSATION_AUTO_REFETCH_INTERVAL_MS,
  computeSenderHeaderIds,
  type ReplyTarget,
  reverseEventsChronologically,
} from "../lib/conversation";
import { getInclusiveLoadedRangeIds, getRangeVisualPositions, nextRangeEndpointState } from "../lib/conversation-range-selection";
import { createKeyedRecords, type KeyedRecord } from "../lib/createKeyedRecords";
import { createMessageScroller } from "../lib/createMessageScroller";
import { formatTokenCount, formatUsd } from "../lib/format";
import {
  navigateToIdentity,
  populateCacheFromParticipants,
} from "../lib/identities";
import { queryOptions, useConversationStats } from "../lib/queries";
import { APP_NAME, buildCodingProjectUrl, safeDecode } from "../lib/routes";
import type { TimelineEvent } from "../lib/types";
import { useScrollToAnchor } from "../lib/useScrollToAnchor";
import { IconArrowDownward, IconChevronLeft, IconInfo } from "../ui/icons";
import { AIEventRow } from "./conversation/AIEventRow";
import { AISidebarPanel } from "./conversation/AISidebarPanel";
import { ConversationMessage } from "./conversation/ConversationMessage";
import { ConversationRangeExportControls, ExportSelectionIcon } from "./conversation/ConversationRangeExportControls";
import { ConversationTranscript } from "./conversation/ConversationTranscript";
import { SubAgentGroup, type SubagentGroup } from "./conversation/SubAgentGroup";
import MediaGallery from "./MediaGallery";
import Avatar from "./Avatar";

// Convert timestamp to string (handles both string and Date from Eden)
function toTimestampString(ts: string | Date | null): string | null {
  if (!ts) return null;
  return ts instanceof Date ? ts.toISOString() : ts;
}

function formatShortDate(ts: string | null): string {
  if (!ts) return "";
  const date = new Date(ts);
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

// "claude-opus-4-5-20251101" -> "opus-4-5" for the per-model usage rows;
// full id stays available via the title attribute.
function shortModelName(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function formatMonthYear(monthStr: string): string {
  const [year, month] = monthStr.split("-");
  const date = new Date(parseInt(year), parseInt(month) - 1);
  return date.toLocaleDateString([], { month: "short", year: "numeric" });
}

// Number of days in a "YYYY-MM" month. Day 0 of the next month is this one's
// last day, so getUTCDate() yields the count (handles leap Februarys). UTC to
// match the strftime('%Y-%m') month buckets computed over the stored ...Z rows.
function daysInMonth(monthStr: string): number {
  const [year, month] = monthStr.split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// "YYYY-MM" for a timestamp, in UTC — matching the SQL month buckets.
function utcMonth(ts: string): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Messages/day for each month bucket, for the unlabelled activity sparkline. The
// first and last buckets are usually partial (the conversation starts/ends
// mid-month), so they're divided by the days actually elapsed within the month
// rather than the full calendar length; interior months use the full month.
function activityRatePerDay(
  buckets: { month: string; count: number }[],
  firstMessage: string | null,
  lastMessage: string | null,
): number[] {
  const lastIndex = buckets.length - 1;
  return buckets.map((b, i) => {
    let startDay = 1;
    let endDay = daysInMonth(b.month);
    if (i === 0 && firstMessage && utcMonth(firstMessage) === b.month) {
      startDay = new Date(firstMessage).getUTCDate();
    }
    if (i === lastIndex && lastMessage && utcMonth(lastMessage) === b.month) {
      endDay = new Date(lastMessage).getUTCDate();
    }
    const days = Math.max(1, endDay - startDay + 1);
    return b.count / days;
  });
}

// Attachment preview component - receives attachments as prop (no separate fetch)
// Simple sparkline component
function Sparkline(props: { data: number[]; width?: number; height?: number }) {
  const width = props.width ?? 120;
  const height = props.height ?? 24;

  const max = Math.max(...props.data, 1);
  const points = props.data.map((v, i) => {
    const x = (i / (props.data.length - 1)) * width;
    const y = height - (v / max) * height;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg width={width} height={height} class="text-primary">
      <polyline
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        points={points}
      />
    </svg>
  );
}

export default function ConversationView() {
  const queryClient = useQueryClient();
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  // Set when the user arrived here from /coding/project/<name>. Lets us show
  // a back arrow that pops back into that project page, preserving its scroll
  // position via history.back rather than a fresh navigation.
  const fromCodingProject = (): string | null => {
    const state = location.state as { fromCodingProject?: string } | null;
    return state?.fromCodingProject ?? null;
  };
  const highlightEventId = useScrollToAnchor();

  // Get conversation identity from URL params. Display title comes from the API.
  const source = () => safeDecode(params.source || "");
  const conversationId = () => safeDecode(params.conversationId || "");
  const [conversationTitle, setConversationTitle] = createSignal<string | null>(null);
  const displayTitle = () => conversationTitle() ?? sourceLabel(source());

  createEffect(() => {
    document.title = `${displayTitle()} · ${APP_NAME}`;
  });

  // Navigation helpers

  const [attachments, setAttachments] = createSignal<Record<string, Attachment[]>>({});
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [sidebarTab, setSidebarTab] = createSignal<"info" | "media" | "ai">("info");
  const [rangeMode, setRangeMode] = createSignal(false);
  const [rangeStartId, setRangeStartId] = createSignal<number | null>(null);
  const [rangeEndId, setRangeEndId] = createSignal<number | null>(null);

  // Handle clicking on a person's name to navigate to their contact or alias view
  const handlePersonClick = async (identifier: string, e: MouseEvent) => {
    e.stopPropagation();
    await navigateToIdentity(navigate, identifier, source());
  };

  const clearRangeSelection = () => {
    setRangeMode(false);
    setRangeStartId(null);
    setRangeEndId(null);
  };

  const handleRangeMessageClick = (eventId: number, e: MouseEvent) => {
    if (!rangeMode()) return;
    e.preventDefault();
    e.stopPropagation();
    const next = nextRangeEndpointState({ startEventId: rangeStartId(), endEventId: rangeEndId() }, eventId);
    setRangeStartId(next.startEventId);
    setRangeEndId(next.endEventId);
  };

  const setRangeSelection = (startEventId: number, endEventId: number) => {
    setRangeStartId(startEventId);
    setRangeEndId(endEventId);
  };

  // First/last message ids of the whole conversation, surfaced by stats. Lets
  // the export controls offer a one-click "select all" that the server resolves
  // into the full transcript — no need to load every message on the client.
  const statsQuery = useConversationStats(() => ({
    conversationId: conversationId(),
    source: source(),
  }));
  const stats = () =>
    statsQuery.isPending || statsQuery.isLoadingError
      ? null
      : statsQuery.data ?? null;
  const conversationBounds = createMemo(() => {
    const s = stats();
    if (!s || s.firstEventId === null || s.lastEventId === null) return null;
    return { startId: s.firstEventId, endId: s.lastEventId };
  });

  const mergeAttachments = (next: Record<string, Attachment[]> | undefined) => {
    setAttachments((prev) => ({ ...prev, ...(next ?? {}) }));
  };
  const attachmentsForEvent = (eventId: number): Attachment[] =>
    attachments()[String(eventId)] ?? [];
  const conversationKey = () => `${source()}\0${conversationId()}`;

  // Set when a reply-preview jump targets a message outside the loaded window
  // but in this same conversation: bumping `generation` reloads the scroller
  // with a window centered on `eventId` (the route doesn't change, so the
  // conversation key alone wouldn't reload). Mirrors the focusEventId
  // deep-link path.
  const [replyJump, setReplyJump] = createSignal<{ eventId: number; generation: number } | null>(null);
  // A jump only makes sense within the conversation it was made in — clear it
  // when navigating to another conversation so its target can't hijack that
  // conversation's initial load. Created before the scroller so it settles
  // first when both react to the same navigation.
  createEffect(on(conversationKey, () => setReplyJump(null), { defer: true }));

  // Transient highlight for a message the reader jumped to via a reply preview
  // (as opposed to the URL-hash target). Cleared after the same 1.5s the
  // deep-link highlight uses.
  const [replyHighlightId, setReplyHighlightId] = createSignal<number | null>(null);
  const flashReplyHighlight = (eventId: number) => {
    setReplyHighlightId(eventId);
    setTimeout(() => {
      setReplyHighlightId((current) => (current === eventId ? null : current));
    }, 1500);
  };

  const loadAfterPage = async (cursor: string, staleTime?: number) => {
    const key = conversationKey();
    const options = queryOptions.conversationPage({
      conversationId: conversationId(),
      source: source(),
      limit: 50,
      cursor,
      order: "asc",
    });
    const data = await queryClient.fetchQuery(
      staleTime === undefined ? options : { ...options, staleTime },
    );
    if (key === conversationKey()) {
      populateCacheFromParticipants(data.participants);
      mergeAttachments(data.attachments as Record<string, Attachment[]>);
    }
    return {
      items: data.events as TimelineEvent[],
      hasMore: !!data.nextCursor,
      nextCursor: data.nextCursor,
    };
  };

  const scroller = createMessageScroller<TimelineEvent>({
    key: () => `${conversationKey()}\0${replyJump()?.generation ?? 0}`,
    loadInitial: async () => {
      const key = conversationKey();
      setAttachments({});
      setConversationTitle(null);
      const targetEventId = replyJump()?.eventId ?? highlightEventId();

      // With a highlighted event, load a window centered on it; otherwise open
      // at the live edge: most recent messages first, then settle at the bottom.
      if (targetEventId) {
        const data = await queryClient.fetchQuery(queryOptions.conversationAround({
          conversationId: conversationId(),
          source: source(),
          eventId: targetEventId,
          before: 50,
          after: 50,
        }));
        if (key === conversationKey()) {
          setConversationTitle(data.title);
          populateCacheFromParticipants(data.participants);
          setAttachments((data.attachments as Record<string, Attachment[]>) || {});
        }
        return {
          items: data.events as TimelineEvent[],
          hasBefore: data.hasBefore,
          hasAfter: data.hasAfter,
          beforeCursor: data.beforeCursor,
          afterCursor: data.afterCursor,
        };
      }

      const data = await queryClient.fetchQuery(queryOptions.conversationPage({
        conversationId: conversationId(),
        source: source(),
        limit: 100,
        order: "desc",
      }));
      if (key === conversationKey()) {
        setConversationTitle(data.title);
        populateCacheFromParticipants(data.participants);
        setAttachments((data.attachments as Record<string, Attachment[]>) || {});
      }
      return {
        items: reverseEventsChronologically(data.events),
        hasBefore: !!data.nextCursor,
        hasAfter: false,
        beforeCursor: data.nextCursor,
        afterCursor: null,
      };
    },
    loadBefore: async (cursor) => {
      const key = conversationKey();
      const data = await queryClient.fetchQuery(queryOptions.conversationPage({
        conversationId: conversationId(),
        source: source(),
        limit: 50,
        cursor,
        order: "desc", // Get older messages
      }));
      if (key === conversationKey()) {
        populateCacheFromParticipants(data.participants);
        mergeAttachments(data.attachments as Record<string, Attachment[]>);
      }
      return {
        items: reverseEventsChronologically(data.events),
        hasMore: !!data.nextCursor,
        nextCursor: data.nextCursor,
      };
    },
    loadAfter: (cursor) => loadAfterPage(cursor),
    onInitialLoad: (s) => {
      const jumpTarget = replyJump()?.eventId;
      const eventId = jumpTarget ?? highlightEventId();
      if (eventId) {
        s.scrollToMessage(eventId);
        if (jumpTarget) flashReplyHighlight(jumpTarget);
      } else {
        s.scrollToEnd();
      }
    },
    messageElementId: (id) => `event-${id}`,
    autoRefetch: {
      intervalMs: CONVERSATION_AUTO_REFETCH_INTERVAL_MS,
      getCursor: createTimelineEventCursor,
      loadAfter: (cursor) => loadAfterPage(cursor, 0),
    },
  });

  // Jump to a replied-to message: scroll when it's loaded; when it isn't but
  // lives in this conversation, reload the scroller with a window centered on
  // it (see replyJump). Cross-conversation targets fall through to the href.
  const jumpToRepliedMessage = (reply: ReplyTarget): boolean => {
    const eventId = reply.eventId;
    if (eventId === null) return false;
    if (scroller.scrollToMessage(eventId, "smooth")) {
      flashReplyHighlight(eventId);
      return true;
    }
    if (reply.conversationId === conversationId() && reply.url) {
      // Keep the URL shareable/consistent with the deep-link path.
      navigate(reply.url);
      setReplyJump((prev) => ({ eventId, generation: (prev?.generation ?? 0) + 1 }));
      return true;
    }
    return false;
  };

  // Build a tool_use_id → tool_result map across the whole thread, so a
  // tool_use block on an assistant message can show its result from the
  // following user message.
  const toolResultMap = createMemo(() => {
    const map = new Map<string, ContentBlock>();
    for (const event of scroller.items()) {
      if (!isAIEventSource(event.source)) continue;
      for (const block of parseAIContent(event)) {
        if (block.type === "tool_result" && block.tool_use_id) {
          map.set(block.tool_use_id, block);
        }
      }
    }
    return map;
  });
  const resolveToolResult = (id: string) => toolResultMap().get(id);

  // Group sub-agent messages by the Task tool_use that spawned them, and
  // resolve which loaded event holds that spawning Task tool_use so the
  // group can be rendered as a sibling under its parent's message card.
  // Skip events whose only content is a tool_result already paired with a
  // tool_use shown elsewhere — they'd render as empty cards inside the
  // group; the main flow drops them via the same predicate.
  const derivedSubagentGroups = createMemo<Map<string, SubagentGroup>>(() => {
    const map = new Map<string, SubagentGroup>();
    const evs = scroller.items();
    for (const ev of evs) {
      const ptu = getParentToolUseId(ev);
      if (!ptu) continue;
      if (!hasRenderableAIContent(ev, resolveToolResult)) continue;
      let g = map.get(ptu);
      if (!g) {
        g = { parentToolUseId: ptu, events: [], subagentType: null, parentEventId: null };
        map.set(ptu, g);
      }
      g.events.push(ev);
    }
    // Resolve subagentType + parentEventId by scanning sub-agent-spawning
    // tool_use blocks. Claude Code names this tool "Task"; Conductor uses
    // "Agent". Both carry `subagent_type` in the input.
    for (const ev of evs) {
      if (!isAIEventSource(ev.source)) continue;
      for (const block of parseAIContent(ev)) {
        if (block.type !== "tool_use" || !block.id) continue;
        if (block.name !== "Task" && block.name !== "Agent") continue;
        const g = map.get(block.id);
        if (!g) continue;
        const sub = block.input?.subagent_type;
        g.subagentType = typeof sub === "string" ? sub : null;
        g.parentEventId = ev.id;
      }
    }
    return map;
  });
  type SubagentGroupRecord = KeyedRecord<string, SubagentGroup>;
  const subagentGroupRecords = createKeyedRecords(
    () => Array.from(derivedSubagentGroups().values()),
    (group) => group.parentToolUseId,
  );
  const subagentGroups = createMemo(() => new Map(
    subagentGroupRecords().map((record) => [record.key, record.value()] as const),
  ));

  // Set of event ids that belong to a sub-agent group; these are removed from
  // the main flat message list and rendered inside their group instead.
  const subagentEventIds = createMemo(() => {
    const ids = new Set<number>();
    for (const g of subagentGroups().values()) {
      for (const e of g.events) ids.add(e.id);
    }
    return ids;
  });

  // Resolved groups keyed by the parent message id (the message containing
  // the spawning Task tool_use). One parent can spawn multiple parallel Tasks.
  const groupRecordsByParentEvent = createMemo(() => {
    const m = new Map<number, SubagentGroupRecord[]>();
    for (const record of subagentGroupRecords()) {
      const g = record.value();
      if (g.parentEventId === null) continue;
      const arr = m.get(g.parentEventId);
      if (arr) arr.push(record);
      else m.set(g.parentEventId, [record]);
    }
    return m;
  });
  const groupRecordsForParent = (eventId: number) => groupRecordsByParentEvent().get(eventId) ?? [];

  // Orphan groups: events with a known `parent_tool_use_id` whose spawning
  // Task tool_use message isn't in the loaded window. Rendered in their own
  // section below the date-grouped flow. Note that sidechain messages whose
  // `parent_tool_use_id` couldn't be resolved at parse time (so it's null in
  // raw_data) don't end up here — they aren't added to subagentGroups at all
  // and fall through to the main flow as regular messages.
  const orphanGroupRecords = createMemo(() => {
    const out: SubagentGroupRecord[] = [];
    for (const record of subagentGroupRecords()) {
      const g = record.value();
      if (g.parentEventId === null && g.events.length > 0) out.push(record);
    }
    return out.sort((a, b) => {
      const firstA = a.value().events[0];
      const firstB = b.value().events[0];
      const ta = firstA?.timestamp ? String(firstA.timestamp) : "";
      const tb = firstB?.timestamp ? String(firstB.timestamp) : "";
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
  });

  // The set of group ids (parent_tool_use_id) on the chain from the target
  // event up to the top-level message. If the target sits inside a nested
  // sub-agent, EVERY ancestor group on the chain must default-expand so the
  // target's DOM node renders and scrollToMessage can find it.
  const groupsOnTargetChain = createMemo<Set<string>>(() => {
    const target = highlightEventId();
    if (target === undefined) return new Set();
    const groups = subagentGroups();
    // event id → containing group's parentToolUseId
    const groupOfEvent = new Map<number, string>();
    for (const [ptu, group] of groups) {
      for (const e of group.events) groupOfEvent.set(e.id, ptu);
    }
    const out = new Set<string>();
    let cursor: number | undefined = target;
    while (cursor !== undefined) {
      const ptu = groupOfEvent.get(cursor);
      if (ptu === undefined) break;
      out.add(ptu);
      const group = groups.get(ptu);
      cursor = group?.parentEventId ?? undefined;
    }
    return out;
  });

  function defaultSubagentExpanded(group: SubagentGroup): boolean {
    if (groupsOnTargetChain().has(group.parentToolUseId)) return true;
    return group.events.length <= 3;
  }

  // Hide AI events that would render nothing (e.g. a user message whose only
  // content is a tool_result already shown under its matching tool_use), and
  // remove sub-agent messages — they render inside their SubAgentGroup below
  // the parent message card rather than inline in the main flow.
  const visibleEvents = createMemo(() => {
    const subIds = subagentEventIds();
    return scroller.items().filter((e) => {
      if (subIds.has(e.id)) return false;
      return hasRenderableAIContent(e, resolveToolResult);
    });
  });
  const selectedRangeIds = createMemo(() => {
    return getInclusiveLoadedRangeIds(visibleEvents().map((event) => event.id), {
      startEventId: rangeStartId(),
      endEventId: rangeEndId(),
    });
  });
  const rangeVisualPositions = createMemo(() =>
    getRangeVisualPositions(visibleEvents().map((event) => event.id), selectedRangeIds())
  );
  const selectedLoadedCount = () => selectedRangeIds().size;
  // Map of event id → the model slug selected by the user at send time. Only
  // populated on the first visible user message and any subsequent user message
  // whose model differs from the previous one. Conductor-only because it's the
  // only source where the user-side model is a deliberate picker selection;
  // other sources just mirror the assistant's model on user messages.
  const userModelTransitions = createMemo<Map<number, string>>(() => {
    const transitions = new Map<number, string>();
    if (source() !== "conductor") return transitions;
    let lastModel: string | null = null;
    for (const ev of visibleEvents()) {
      if (!ev.type.endsWith(":user")) continue;
      const model = extractAIMeta(ev)?.model;
      if (!model) continue;
      if (model !== lastModel) {
        transitions.set(ev.id, model);
        lastModel = model;
      }
    }
    return transitions;
  });

  // Map of event id → the title it was renamed *to* (i.e. its own title),
  // populated only when the immediately-preceding loaded event had a different
  // title. Drives inline "Renamed to X" dividers between messages spanning a
  // channel/group rename.
  const titleTransitions = createMemo(() => {
    const boundaries = new Map<number, string>();
    const evs = visibleEvents();
    for (let i = 1; i < evs.length; i++) {
      const prev = evs[i - 1];
      const curr = evs[i];
      if (curr.title && prev.title && curr.title !== prev.title) {
        boundaries.set(curr.id, curr.title);
      }
    }
    return boundaries;
  });

  // Event ids that render a sender header; see computeSenderHeaderIds. The
  // inline "Renamed to X" / "User selected X" separators are drawn above their
  // event and cut the run visually, so those events are forced back into a
  // header.
  const senderHeaderIds = createMemo(() =>
    computeSenderHeaderIds(
      visibleEvents(),
      new Set([...titleTransitions().keys(), ...userModelTransitions().keys()]),
    )
  );

  // Aggregate AI meta for the whole thread. Returns null for non-AI sources.
  const aiAggregate = createMemo(() => {
    const src = source();
    if (!isAIEventSource(src)) return null;
    return aggregateAIMeta(src, scroller.items());
  });

  // Coding project name (e.g. "example-app") derived from the first loaded event.
  // Null when the conversation isn't from an AI coding source we recognize.
  const codingProject = createMemo(() => {
    const first = scroller.items()[0];
    if (!first) return null;
    return getCodingProjectName(first);
  });

  // Default to the AI tab when the conversation source is AI, and reset to
  // the info tab otherwise. Runs per-navigation.
  createEffect(on(source, (src) => {
    setSidebarTab(isAIEventSource(src) ? "ai" : "info");
  }));

  return (
    <div class="h-full flex">
      {/* Main content */}
      <div class="relative flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div class="border-b border-border bg-card px-4 py-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <Show when={fromCodingProject()}>
              {(name) => (
                <button
                  class="p-1 rounded hover:bg-accent text-muted-foreground shrink-0"
                  onClick={() => navigate(-1)}
                  title={`Back to ${name()}`}
                >
                  <IconChevronLeft class="w-5 h-5" />
                </button>
              )}
            </Show>
            <div class="min-w-0">
              <h2 class="font-display font-medium truncate">{displayTitle()}</h2>
              <p class="text-sm text-muted-foreground">
                {sourceLabel(source())}
                <Show when={codingProject()}>
                  {(name) => (
                    <>
                      {" · in "}
                      <a
                        href={buildCodingProjectUrl(name())}
                        class="text-foreground hover:underline"
                      >
                        {name()}
                      </a>
                    </>
                  )}
                </Show>
                {" · "}<span class="font-mono">{scroller.items().length}</span> messages loaded
              </p>
            </div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              class={`inline-flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors ${
                rangeMode() ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              title={rangeMode() ? "Cancel export selection" : "Select messages to export"}
              aria-label={rangeMode() ? "Cancel export selection" : "Select messages to export"}
              onClick={() => {
                if (rangeMode()) clearRangeSelection();
                else setRangeMode(true);
              }}
            >
              <ExportSelectionIcon />
              <span class="hidden sm:inline">Export</span>
            </button>
            <button
              class="p-2 rounded hover:bg-accent text-muted-foreground"
              onClick={() => setSidebarOpen(!sidebarOpen())}
              title={sidebarOpen() ? "Hide sidebar" : "Show sidebar"}
            >
              <IconInfo class="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div ref={scroller.viewportRef} class="relative flex-1 overflow-auto">
          <ConversationRangeExportControls
            rangeMode={rangeMode}
            startEventId={rangeStartId}
            endEventId={rangeEndId}
            selectedLoadedCount={selectedLoadedCount}
            conversationBounds={conversationBounds}
            sidebarOpen={sidebarOpen}
            onSelectRange={setRangeSelection}
            onClearSelection={clearRangeSelection}
          />
          <Show when={scroller.error()}>
            <div class="text-center py-8 px-4 text-red-500">Error: {scroller.error()}</div>
          </Show>

          <Show when={scroller.isLoading()}>
            <div class="text-center py-8 px-4 text-muted-foreground">Loading conversation...</div>
          </Show>

          <Show when={!scroller.isLoading() && scroller.items().length > 0}>
            {/* Top sentinel for loading older messages */}
            <div ref={scroller.topSentinelRef} class="h-1" />

            <Show when={scroller.isLoadingBefore()}>
              <div class="text-center py-2 px-4 text-muted-foreground text-sm">Loading older messages...</div>
            </Show>

            <Show when={!scroller.hasBefore() && !scroller.isLoadingBefore()}>
              <div class="text-center py-2 px-4 text-muted-foreground text-sm">Beginning of conversation</div>
            </Show>

            <ConversationTranscript
              events={visibleEvents()}
              density="full"
              renderMessage={(event) => {
                        const isTargetEvent = () =>
                          event.id === highlightEventId() || event.id === replyHighlightId();
                        const renamedTo = () => titleTransitions().get(event.id);
                        const userModel = () => userModelTransitions().get(event.id);
                        const isAI = isAIEventSource(event.source);
                        const rangeVisualPosition = () => rangeVisualPositions().get(event.id);
                        const showSenderHeader = () => senderHeaderIds().has(event.id);

                        return (
                          <>
                            <Show when={renamedTo()}>
                              {(newTitle) => (
                                <div class="flex items-center gap-2 py-2">
                                  <div class="flex-1 h-px bg-border" />
                                  <span class="text-sm font-medium text-muted-foreground px-2 bg-background rounded break-words text-center">
                                    Renamed to {newTitle()}
                                  </span>
                                  <div class="flex-1 h-px bg-border" />
                                </div>
                              )}
                            </Show>
                            <Show when={userModel()}>
                              {(model) => (
                                <div class="flex items-center gap-2 py-2">
                                  <div class="flex-1 h-px bg-border" />
                                  <span class="text-xs font-medium text-muted-foreground px-2 bg-background rounded break-words text-center">
                                    User selected <span class="font-mono">{model()}</span>
                                  </span>
                                  <div class="flex-1 h-px bg-border" />
                                </div>
                              )}
                            </Show>
                          <Show when={isAI} fallback={
                            <ConversationMessage
                              event={event}
                              conversationSource={source()}
                              attachments={attachmentsForEvent(event.id)}
                              showSenderHeader={showSenderHeader()}
                              density="full"
                              highlighted={isTargetEvent()}
                              rangeMode={rangeMode()}
                              rangeVisualPosition={rangeVisualPosition()}
                              onMessageClick={(e) => handleRangeMessageClick(event.id, e)}
                              onPersonClick={handlePersonClick}
                              onReplyJump={jumpToRepliedMessage}
                            />
                          }>
                            <div onClick={(e) => handleRangeMessageClick(event.id, e)} class={rangeMode() ? "cursor-crosshair" : ""}>
                            <AIEventRow
                              event={event}
                              showSenderHeader={senderHeaderIds().has(event.id)}
                              isTargetEvent={isTargetEvent()}
                              rangeVisualPosition={rangeVisualPosition()}
                              conversationSource={source()}
                              conversationTitle={displayTitle()}
                              attachments={attachmentsForEvent(event.id)}
                              resolveToolResult={resolveToolResult}
                              onPersonClick={handlePersonClick}
                            />
                            </div>
                          </Show>
                          <For each={groupRecordsForParent(event.id)}>
                            {(record) => (
                              <SubAgentGroup
                                group={record.value()}
                                resolveToolResult={resolveToolResult}
                                defaultExpandedFor={defaultSubagentExpanded}
                                highlightEventId={highlightEventId}
                                nestedGroupRecordsFor={groupRecordsForParent}
                                conversationSource={source()}
                                conversationTitle={displayTitle()}
                                attachmentsForEvent={attachmentsForEvent}
                              />
                            )}
                          </For>
                          </>
                        );
              }}
            />

            <Show when={orphanGroupRecords().length > 0}>
              <div class="px-4 mt-4">
                <div class="text-sm font-medium text-muted-foreground mb-2">
                  Sub-agents whose parent message isn't loaded
                </div>
                <For each={orphanGroupRecords()}>
                  {(record) => (
                    <SubAgentGroup
                      group={record.value()}
                      resolveToolResult={resolveToolResult}
                      defaultExpandedFor={defaultSubagentExpanded}
                      highlightEventId={highlightEventId}
                      nestedGroupRecordsFor={groupRecordsForParent}
                      conversationSource={source()}
                      conversationTitle={displayTitle()}
                      attachmentsForEvent={attachmentsForEvent}
                    />
                  )}
                </For>
              </div>
            </Show>

            {/* Bottom sentinel for loading newer messages */}
            <div ref={scroller.bottomSentinelRef} class="h-1" />

            <Show when={scroller.isLoadingAfter()}>
              <div class="text-center py-2 px-4 text-muted-foreground text-sm">Loading newer messages...</div>
            </Show>

            <Show when={!scroller.hasAfter() && !scroller.isLoadingAfter()}>
              <div class="text-center py-2 px-4 text-muted-foreground text-sm">End of conversation</div>
            </Show>
          </Show>

          <Show when={!scroller.isLoading() && scroller.items().length === 0 && !scroller.error()}>
            <div class="text-center py-8 px-4 text-muted-foreground">No messages found</div>
          </Show>
        </div>

        {/* Jump-to-latest control — shown when the reader has scrolled up off
            the live edge. Gated on !hasAfter(): scrollToEnd only reaches the
            bottom of the loaded window, so when newer pages are still unloaded
            it wouldn't actually reach the latest message. */}
        <Show when={!scroller.isLoading() && scroller.items().length > 0 && !scroller.isAtEnd() && !scroller.hasAfter()}>
          <button
            class="absolute bottom-4 right-4 z-20 flex items-center justify-center w-10 h-10 rounded-full bg-card shadow-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            onClick={() => scroller.scrollToEnd("smooth")}
            title="Jump to latest"
            aria-label="Jump to latest messages"
          >
            <IconArrowDownward class="w-5 h-5" />
          </button>
        </Show>
      </div>

      {/* Sidebar */}
      <Show when={sidebarOpen()}>
        <div class="w-64 border-l border-border bg-card flex flex-col shrink-0">
          {/* Tab bar */}
          <div class="flex border-b border-border shrink-0">
            <Show when={aiAggregate()}>
              <button
                class={`flex-1 px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
                  sidebarTab() === "ai"
                    ? "text-foreground border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setSidebarTab("ai")}
              >
                AI
              </button>
            </Show>
            <button
              class={`flex-1 px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
                sidebarTab() === "info"
                  ? "text-foreground border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setSidebarTab("info")}
            >
              Info
            </button>
            <button
              class={`flex-1 px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
                sidebarTab() === "media"
                  ? "text-foreground border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setSidebarTab("media")}
            >
              Media
            </button>
          </div>

          <div class="overflow-auto flex-1">
            {/* AI tab */}
            <Show when={sidebarTab() === "ai" && aiAggregate()}>
              {(agg) => <AISidebarPanel aggregated={agg()} />}
            </Show>

            {/* Info tab */}
            <Show when={sidebarTab() === "info"}>
              <div class="space-y-6 p-4">
                {/* Skeleton loading state */}
                <Show when={statsQuery.isPending}>
                  {/* Overview skeleton */}
                  <div>
                    <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Overview</h3>
                    <div class="space-y-2 text-sm">
                      <div class="flex justify-between">
                        <span class="text-muted-foreground">Messages</span>
                        <div class="h-4 w-12 bg-accent rounded animate-pulse" />
                      </div>
                      <div class="flex justify-between">
                        <span class="text-muted-foreground">Attachments</span>
                        <div class="h-4 w-8 bg-accent rounded animate-pulse" />
                      </div>
                      <div class="flex justify-between">
                        <span class="text-muted-foreground">Started</span>
                        <div class="h-4 w-20 bg-accent rounded animate-pulse" />
                      </div>
                      <div class="flex justify-between">
                        <span class="text-muted-foreground">Last message</span>
                        <div class="h-4 w-20 bg-accent rounded animate-pulse" />
                      </div>
                    </div>
                  </div>

                  {/* Participants skeleton */}
                  <div>
                    <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Participants</h3>
                    <div class="space-y-2">
                      <For each={[1, 2, 3]}>
                        {() => (
                          <div class="flex items-center justify-between">
                            <div class="h-4 w-24 bg-accent rounded animate-pulse" />
                            <div class="h-4 w-8 bg-accent rounded animate-pulse" />
                          </div>
                        )}
                      </For>
                    </div>
                  </div>

                  {/* Activity skeleton */}
                  <div>
                    <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Activity</h3>
                    <div class="h-8 w-full bg-accent rounded animate-pulse" />
                    <div class="flex justify-between mt-1">
                      <div class="h-3 w-16 bg-accent rounded animate-pulse" />
                      <div class="h-3 w-16 bg-accent rounded animate-pulse" />
                    </div>
                  </div>
                </Show>

                <Show when={statsQuery.isError}>
                  <div class="text-sm text-red-500">Failed to load conversation stats.</div>
                </Show>

                <Show when={stats()}>
                  {(s) => (
                    <>
                      {/* Overview */}
                      <div>
                        <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Overview</h3>
                        <div class="space-y-2 text-sm">
                          <div class="flex justify-between">
                            <span class="text-muted-foreground">Messages</span>
                            <span class="font-medium font-mono">{s().totalMessages.toLocaleString()}</span>
                          </div>
                          <div class="flex justify-between">
                            <span class="text-muted-foreground">Attachments</span>
                            <button
                              class="font-medium hover:text-primary hover:underline cursor-pointer"
                              onClick={() => setSidebarTab("media")}
                            >
                              <span class="font-mono">{s().attachmentCount.toLocaleString()}</span>
                            </button>
                          </div>
                          <div class="flex justify-between">
                            <span class="text-muted-foreground">Started</span>
                            <span class="font-medium font-mono">{formatShortDate(s().firstMessage)}</span>
                          </div>
                          <div class="flex justify-between">
                            <span class="text-muted-foreground">Last message</span>
                            <span class="font-medium font-mono">{formatShortDate(s().lastMessage)}</span>
                          </div>
                        </div>
                      </div>

                      {/* Token usage (AI session sources only) */}
                      <Show when={s().tokenUsage}>
                        {(u) => (
                          <div>
                            <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Usage</h3>
                            <div class="space-y-2 text-sm">
                              <div class="flex justify-between">
                                <span class="text-muted-foreground">Input</span>
                                <span class="font-medium font-mono">{formatTokenCount(u().inputTokens)}</span>
                              </div>
                              <div class="flex justify-between">
                                <span class="text-muted-foreground">Output</span>
                                <span class="font-medium font-mono">{formatTokenCount(u().outputTokens)}</span>
                              </div>
                              <div class="flex justify-between">
                                <span class="text-muted-foreground">Cache read</span>
                                <span class="font-medium font-mono">{formatTokenCount(u().cacheReadTokens)}</span>
                              </div>
                              <div class="flex justify-between">
                                <span class="text-muted-foreground">Cache write</span>
                                <span class="font-medium font-mono">{formatTokenCount(u().cacheCreationTokens)}</span>
                              </div>
                              <Show when={u().estimatedCostUsd !== null}>
                                <div class="flex justify-between">
                                  <span class="text-muted-foreground">Est. API cost</span>
                                  <span class="font-medium font-mono">{formatUsd(u().estimatedCostUsd ?? 0)}</span>
                                </div>
                              </Show>
                              <Show when={u().byModel.length > 1}>
                                <div class="space-y-1 pt-1 border-t border-border">
                                  <For each={u().byModel}>
                                    {(m) => (
                                      <div class="flex justify-between text-xs">
                                        <span class="text-muted-foreground truncate" title={m.model}>{shortModelName(m.model)}</span>
                                        <span class="font-mono ml-2 shrink-0">
                                          {m.costUsd !== null ? formatUsd(m.costUsd) : `${formatTokenCount(m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens)} tok`}
                                        </span>
                                      </div>
                                    )}
                                  </For>
                                </div>
                              </Show>
                            </div>
                            <p class="text-xs text-muted-foreground mt-2">
                              At pay-as-you-go API rates, not subscription spend
                              {u().byModel.some((m) => m.costUsd === null) && u().estimatedCostUsd !== null
                                ? "; excludes models without published pricing"
                                : ""}.
                            </p>
                          </div>
                        )}
                      </Show>

                      {/* Participants */}
                      <div>
                        <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                          Participants (<span class="font-mono">{s().participants.length}</span>)
                        </h3>
                        <div class="space-y-2">
                          <For each={s().participants}>
                            {(p) => (
                              <div class="flex items-center justify-between text-sm gap-2">
                                <div class="flex items-center gap-2 min-w-0">
                                  <Avatar url={p.avatarUrl} name={p.name} size="sm" />
                                  <button
                                    class="truncate text-left hover:text-primary hover:underline cursor-pointer"
                                    title={`View contact for ${p.name}`}
                                    onClick={(e) => handlePersonClick(p.identifier, e)}
                                  >
                                    {p.name}
                                  </button>
                                </div>
                                <span class="text-muted-foreground text-sm ml-2 shrink-0 font-mono">
                                  {p.count.toLocaleString()}
                                </span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>

                      {/* Activity chart — plotted as messages/day (count
                          normalised by elapsed days in each month, partial
                          first/last months included) so month length doesn't
                          distort the shape. Unlabelled, so the rate's absolute
                          scale is immaterial; only the relative shape matters. */}
                      <Show when={s().activityByMonth.length > 1}>
                        <div>
                          <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Activity</h3>
                          <Sparkline data={activityRatePerDay(s().activityByMonth, s().firstMessage, s().lastMessage)} width={200} height={32} />
                          <div class="flex justify-between text-sm text-muted-foreground mt-1">
                            <span class="font-mono">{formatMonthYear(s().activityByMonth[0].month)}</span>
                            <span class="font-mono">{formatMonthYear(s().activityByMonth[s().activityByMonth.length - 1].month)}</span>
                          </div>
                        </div>
                      </Show>

                      {/* Most active months */}
                      <Show when={s().activityByMonth.length > 0}>
                        <div>
                          <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Most Active</h3>
                          <div class="space-y-1">
                            <For each={s().activityByMonth.filter((m) => m.count > 0).sort((a, b) => b.count - a.count).slice(0, 5)}>
                              {(m) => (
                                <div class="flex items-center justify-between text-sm">
                                  <span class="font-mono">{formatMonthYear(m.month)}</span>
                                  <span class="text-muted-foreground text-sm font-mono">{m.count.toLocaleString()}</span>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>

                      <Show when={s().titles.filter((t) => t.title !== displayTitle()).length > 0}>
                        <div>
                          <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                            Also known as
                          </h3>
                          <div class="space-y-2 text-sm">
                            <For each={s().titles.filter((t) => t.title !== displayTitle())}>
                              {(t) => (
                                <div>
                                  <div class="break-words">{t.title}</div>
                                  <div class="text-sm text-muted-foreground">
                                    <span class="font-mono">{formatShortDate(t.firstSeen)}</span>
                                    <Show when={t.lastSeen !== t.firstSeen}>
                                      {" – "}<span class="font-mono">{formatShortDate(t.lastSeen)}</span>
                                    </Show>
                                    {" · "}<span class="font-mono">{t.messageCount.toLocaleString()}</span> {t.messageCount === 1 ? "message" : "messages"}
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                    </>
                  )}
                </Show>
              </div>
            </Show>

            {/* Media tab */}
            <Show when={sidebarTab() === "media"}>
              <MediaGallery conversationId={conversationId()} source={source()} />
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
