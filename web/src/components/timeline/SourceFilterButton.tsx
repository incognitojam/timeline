import { createSignal, createEffect, createMemo, onCleanup, For, Show } from "solid-js";
import { sourceLabel } from "@shared/sources";
import {
  hiddenSources as persistedHiddenSources,
  toggleHiddenSource,
  clearHiddenSources,
} from "../../lib/hiddenSourcesStore";
import { getSourceColorStyle } from "../../lib/source-styles";
import { IconFilterList } from "../../ui/icons";
import SourceIcon from "../SourceIcon";

interface BaseProps {
  bySource: { source: string; count: number }[] | undefined;
  /** Shown when no source has any events; defaults to the day-timeline copy. */
  emptyMessage?: string;
  /** Sizes the trigger down to sit inline with other filter controls. */
  compact?: boolean;
  /**
   * Edge the menu is anchored to. Defaults to "right" (the trigger sits at the
   * right edge of the day header); left-aligned triggers should pass "left" so
   * the menu cannot run off the viewport.
   */
  align?: "left" | "right";
}

interface ControlledProps extends BaseProps {
  hiddenSources: ReadonlySet<string>;
  onToggleSource: (source: string) => void;
  onClearSources: () => void;
}

interface PersistedProps extends BaseProps {
  hiddenSources?: never;
  onToggleSource?: never;
  onClearSources?: never;
}

type Props = ControlledProps | PersistedProps;

interface SourceRow {
  source: string;
  count: number;
  hidden: boolean;
}

export default function SourceFilterButton(props: Props) {
  const [showMenu, setShowMenu] = createSignal(false);
  let menuRef: HTMLDivElement | undefined;

  // Uncontrolled by default so DayTimeline keeps using the persisted store;
  // callers that pass `hiddenSources` own the state (and its handlers).
  const hidden = (): ReadonlySet<string> => props.hiddenSources ?? persistedHiddenSources();
  const toggleSource = (source: string) => {
    if (props.onToggleSource) props.onToggleSource(source);
    else toggleHiddenSource(source);
  };
  const clearSources = () => {
    if (props.onClearSources) props.onClearSources();
    else clearHiddenSources();
  };

  // Close on outside click (mirrors Add-event dropdown in DayTimeline)
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

  // Rows to show: union of today's sources and any currently-hidden sources
  // (so users can always un-hide even on days where the source has no events).
  const rows = createMemo<SourceRow[]>(() => {
    const counts = new Map<string, number>();
    for (const entry of props.bySource ?? []) {
      counts.set(entry.source, entry.count);
    }
    const hiddenNow = hidden();
    for (const source of hiddenNow) {
      if (!counts.has(source)) counts.set(source, 0);
    }
    return [...counts.entries()]
      .map(([source, count]) => ({ source, count, hidden: hiddenNow.has(source) }))
      .sort((a, b) => sourceLabel(a.source).localeCompare(sourceLabel(b.source)));
  });

  const hiddenCount = () => hidden().size;

  return (
    <div class="relative" ref={menuRef}>
      <button
        type="button"
        class={`relative flex items-center justify-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
          props.compact ? "h-9 w-9 rounded-md" : "h-12 w-12 rounded-xl"
        } ${
          hiddenCount() > 0
            ? "bg-secondary text-secondary-foreground"
            : "hover:bg-accent"
        }`}
        onClick={() => setShowMenu(!showMenu())}
        aria-label={hiddenCount() > 0 ? `Filter sources, ${hiddenCount()} hidden` : "Filter sources"}
        aria-expanded={showMenu()}
        aria-haspopup="menu"
        title={
          hiddenCount() > 0
            ? `Filter sources (${hiddenCount()} hidden)`
            : "Filter sources"
        }
      >
        <IconFilterList class="h-5 w-5" aria-hidden />
      </button>

      <Show when={showMenu()}>
        <div
          class={`absolute top-full z-20 mt-1 max-h-[70vh] min-w-[260px] overflow-auto rounded-xl border border-border bg-popover py-1 text-popover-foreground shadow-lg ${
            props.align === "left" ? "left-0" : "right-0"
          }`}
          role="menu"
        >
          <div class="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Hide sources
          </div>
          <Show
            when={rows().length > 0}
            fallback={
              <div class="px-3 py-2 text-sm text-muted-foreground">
                {props.emptyMessage ?? "No sources on this day."}
              </div>
            }
          >
            <For each={rows()}>
              {(row) => (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={row.hidden}
                  class="flex min-h-12 w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                  onClick={() => toggleSource(row.source)}
                >
                  <input
                    type="checkbox"
                    checked={row.hidden}
                    tabIndex={-1}
                    class="pointer-events-none"
                    readOnly
                  />
                  <span
                    class="w-5 h-5 rounded-full flex items-center justify-center source-icon shrink-0"
                    style={getSourceColorStyle(row.source)}
                  >
                    <SourceIcon source={row.source} class="w-3 h-3" />
                  </span>
                  <span
                    class={`flex-1 ${row.hidden ? "line-through text-muted-foreground" : ""}`}
                  >
                    {sourceLabel(row.source)}
                  </span>
                  <span class="text-xs text-muted-foreground tabular-nums">
                    {row.count}
                  </span>
                </button>
              )}
            </For>
          </Show>
          <Show when={hiddenCount() > 0}>
            <div class="border-t border-border mt-1 pt-1">
              <button
                type="button"
                role="menuitem"
                class="min-h-12 w-full px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent"
                onClick={() => clearSources()}
              >
                Clear all filters
              </button>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
