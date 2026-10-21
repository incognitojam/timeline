import { Show, For } from "solid-js";
import { sourceLabel } from "@shared/sources";
import type { TimelineEvent } from "../../lib/types";
import { getSourceColorStyle } from "../../lib/source-styles";
import { IconChevronRight } from "../../ui/icons";
import { formatTime } from "../../lib/format";
import SourceIcon from "../SourceIcon";

interface Props {
  events: TimelineEvent[];
  isHighlighted?: boolean;
  onToggleJournal?: () => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  activity: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  social: "bg-green-500/15 text-green-600 dark:text-green-400",
  media: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  work: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  open: "bg-gray-500/15 text-gray-600 dark:text-gray-400",
  gratitude: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  mood: "bg-pink-500/15 text-pink-600 dark:text-pink-400",
};

function parseCategory(event: TimelineEvent): string | null {
  try {
    const raw = typeof event.raw_data === "string" ? JSON.parse(event.raw_data) : event.raw_data;
    return raw?.journal?.question_category ?? null;
  } catch {
    return null;
  }
}

export default function JournalCard(props: Props) {
  const qaEvents = () => props.events.filter(e => e.type === "journal:qa");
  const reflectionCount = () => props.events.filter(e => e.type === "journal:reflection").length;
  const colorStyle = () => getSourceColorStyle("journal");

  const summary = () => {
    const qa = qaEvents().length;
    const ref = reflectionCount();
    const parts: string[] = [];
    if (qa > 0) parts.push(`${qa} Q&A${qa !== 1 ? "s" : ""}`);
    if (ref > 0) parts.push(`${ref} reflection${ref !== 1 ? "s" : ""}`);
    return parts.join(" + ");
  };

  const categories = () => {
    const cats = new Map<string, number>();
    for (const event of qaEvents()) {
      const cat = parseCategory(event);
      if (cat && cat !== "reflection") {
        cats.set(cat, (cats.get(cat) || 0) + 1);
      }
    }
    return Array.from(cats.entries()).sort((a, b) => b[1] - a[1]);
  };

  const firstTimestamp = () => props.events[0]?.timestamp ?? null;

  return (
    <div class={`relative pl-8 pb-4 ${props.isHighlighted ? "ring-2 ring-ring rounded-lg" : ""}`}>
      {/* Timeline spine */}
      <div class="absolute left-3 top-0 bottom-0 w-px bg-border timeline-spine" />

      {/* Event node */}
      <div
        class="absolute left-1 top-1 w-5 h-5 rounded-full flex items-center justify-center source-icon"
        style={colorStyle()}
      >
        <SourceIcon source="journal" class="w-3 h-3" />
      </div>

      {/* Card */}
      <button
        class={`w-full text-left rounded-lg bg-card p-3 transition-colors hover:bg-accent/30 cursor-pointer ${props.isHighlighted ? "bg-accent" : ""}`}
        onClick={() => props.onToggleJournal?.()}
      >
        {/* Header */}
        <div class="flex items-center gap-2 mb-2">
          <span class="text-xs text-muted-foreground shrink-0">
            {formatTime(firstTimestamp())}
          </span>
          <span class="text-xs px-1.5 py-0.5 rounded-sm source-badge" style={colorStyle()}>
            {sourceLabel("journal")}
          </span>
          <span class="text-xs text-muted-foreground">
            {summary()}
          </span>
          {/* Open pane hint */}
          <div class="ml-auto shrink-0 text-muted-foreground">
            <IconChevronRight class="w-4 h-4" />
          </div>
        </div>

        {/* Label */}
        <p class="text-sm font-medium">Journal</p>

        {/* Category badges */}
        <Show when={categories().length > 0}>
          <div class="flex flex-wrap gap-1 mt-2">
            <For each={categories()}>
              {([cat, count]) => (
                <span class={`text-xs px-1.5 py-0.5 rounded-sm ${CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.open}`}>
                  {cat}{count > 1 ? ` ×${count}` : ""}
                </span>
              )}
            </For>
          </div>
        </Show>
      </button>
    </div>
  );
}
