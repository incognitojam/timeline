import type { Map as MapLibreMap } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { createEffect, createSignal, For, on, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { sourceLabel } from "@shared/sources";
import type { MapEvent } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { useMapEventsForDay } from "../../lib/queries";
import { getSourceCssColors } from "../../lib/source-styles";
import { staleContentClass } from "../../lib/stale-content";
import { createColorSchemeSignal } from "../../lib/theme";
import { IconClose } from "../../ui/icons";
import Map from "../map/Map";
import { getMapStyleUrl, getMarkerColor } from "../map/mapStyles";
import SourceIcon from "../SourceIcon";

interface Props {
  date: string;
  onClose: () => void;
  onEventClick?: (eventId: number) => void;
}

// Event types that can have location data
const EVENT_TYPE_FILTERS = [
  { key: "location:visit", label: "Visits", defaultEnabled: true },
  { key: "location:transit", label: "Transit", defaultEnabled: true },
  { key: "transaction", label: "Transactions", defaultEnabled: true },
  { key: "activity", label: "Activities", defaultEnabled: true },
] as const;

// Get initial filter state from localStorage or defaults
function getInitialFilters(): Set<string> {
  const stored = localStorage.getItem("timeline:mapFilters");
  if (stored) {
    try {
      return new Set(JSON.parse(stored));
    } catch {
      // Fall through to defaults
    }
  }
  return new Set(EVENT_TYPE_FILTERS.filter((f) => f.defaultEnabled).map((f) => f.key));
}

export default function MapPane(props: Props) {
  const [map, setMap] = createSignal<MapLibreMap | null>(null);
  const [enabledTypes, setEnabledTypes] = createSignal<Set<string>>(getInitialFilters());

  // Track color scheme for map style
  const colorScheme = createColorSchemeSignal();
  const mapStyle = () => getMapStyleUrl(colorScheme());

  // Persist filter changes
  createEffect(on(enabledTypes, (types) => {
    localStorage.setItem("timeline:mapFilters", JSON.stringify([...types]));
  }));

  // Derive types array for query
  const typesArray = () => [...enabledTypes()];

  // Fetch map events for the selected date
  const eventsQuery = useMapEventsForDay(() => props.date, typesArray);

  // Derived: events from query
  const events = () => eventsQuery.data?.events ?? [];
  const mapEventsAreStale = () => eventsQuery.isPlaceholderData;

  // Store markers for cleanup
  let markers: maplibregl.Marker[] = [];
  let popupDisposers: Array<() => void> = [];

  const clearMarkers = () => {
    markers.forEach((marker) => marker.remove());
    markers = [];
    popupDisposers.forEach((dispose) => dispose());
    popupDisposers = [];
  };

  onCleanup(clearMarkers);

  // Key that should trigger refitting bounds — user-initiated changes only.
  // We deliberately do NOT include `events` here: background refetches (every
  // staleTime) can return updated data that would otherwise snap the map back
  // to fit all markers, wiping the user's pan/zoom.
  const fitKey = () => `${props.date}\0${[...enabledTypes()].sort().join(",")}`;
  let lastFitKey: string | null = null;

  // Update markers when map is ready or events change. fitBounds runs only
  // when `fitKey` changes (date or filter), not on background refetches.
  createEffect(on([map, events, mapEventsAreStale], ([mapInstance, eventList, stale]) => {
    if (!mapInstance) return;
    if (stale) return;

    // Clear existing markers
    clearMarkers();

    if (eventList.length === 0) return;

    // Create markers for each event
    const bounds = new maplibregl.LngLatBounds();

    for (const event of eventList) {
      const color = getMarkerColor(event.type);

      // Create popup with HTML content
      const popupContent = createPopupContent(event);
      popupDisposers.push(popupContent.dispose);
      const popup = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "300px",
        offset: 25,
      }).setDOMContent(popupContent.element);

      // Add click handler for "View in timeline" button when popup opens
      popup.on("open", () => {
        const viewBtn = document.getElementById(`map-event-view-${event.id}`);
        if (viewBtn) {
          viewBtn.onclick = () => {
            props.onEventClick?.(event.id);
          };
        }
      });

      // Create marker with popup attached
      const marker = new maplibregl.Marker({ color })
        .setLngLat([event.longitude, event.latitude])
        .setPopup(popup)
        .addTo(mapInstance);

      // Make marker look clickable
      const el = marker.getElement();
      el.style.cursor = "pointer";

      markers.push(marker);
      bounds.extend([event.longitude, event.latitude]);
    }

    // Fit bounds only when the user-facing inputs change, not on every
    // background refetch that produces a fresh events array.
    const key = fitKey();
    if (key !== lastFitKey) {
      lastFitKey = key;
      mapInstance.fitBounds(bounds, {
        padding: { top: 50, bottom: 50, left: 50, right: 50 },
        maxZoom: 15,
      });
    }
  }));

  // Toggle a filter type
  const toggleFilter = (key: string) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div class="h-full flex flex-col">
      {/* Header with inline filters */}
      <div class="shrink-0 px-3 py-2 border-b border-border bg-card">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <h2 class="font-medium text-foreground text-sm">Map</h2>
            <span class="text-xs text-muted-foreground">
              <span class={staleContentClass(mapEventsAreStale())} aria-busy={mapEventsAreStale()}>
                {events().length}
              </span>
            </span>
          </div>
          <button
            onClick={props.onClose}
            class="text-muted-foreground hover:text-foreground p-1 -mr-1"
            title="Close map"
          >
            <IconClose class="w-4 h-4" />
          </button>
        </div>

        {/* Inline filter toggles */}
        <div class="flex items-center gap-3 flex-wrap">
          <For each={EVENT_TYPE_FILTERS}>
            {(filter) => (
              <button
                onClick={() => toggleFilter(filter.key)}
                disabled={mapEventsAreStale()}
                class={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full transition-colors ${
                  enabledTypes().has(filter.key)
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span
                  class="w-2 h-2 rounded-full"
                  style={{
                    "background-color": getMarkerColor(filter.key),
                    opacity: enabledTypes().has(filter.key) ? 1 : 0.4,
                  }}
                />
                <span>{filter.label}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Map container */}
      <div class={`flex-1 min-h-0 ${staleContentClass(mapEventsAreStale())}`} aria-busy={mapEventsAreStale()}>
        <Map
          class="w-full h-full"
          style={mapStyle()}
          onMapReady={setMap}
        />
      </div>
    </div>
  );
}

// Create popup HTML content for an event
function createPopupContent(event: MapEvent): { element: HTMLElement; dispose: () => void } {
  const time = formatTime(event.timestamp);

  const colors = getSourceCssColors(event.source);

  const title = event.title
    ? `<p style="font-size: 0.875rem; font-weight: 500; color: var(--color-foreground); margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 250px;">${escapeHtml(event.title)}</p>`
    : "";

  const locationName = event.location_name
    ? `<p style="font-size: 0.75rem; color: var(--color-muted-foreground); margin: 0.25rem 0 0 0;">@ ${escapeHtml(event.location_name)}</p>`
    : "";

  const element = document.createElement("div");
  element.innerHTML = `
    <div style="padding: 0.25rem;">
      <div style="display: flex; align-items: flex-start; gap: 0.5rem;">
        <span style="font-size: 0.75rem; color: var(--color-muted-foreground); flex-shrink: 0; width: 3rem;">
          ${time}
        </span>
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
            <span style="display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.75rem; padding: 0.125rem 0.375rem; border-radius: 0.25rem; color: ${colors.text}; background: ${colors.bg};">
              <span data-source-icon style="display: inline-flex;"></span>
              ${escapeHtml(sourceLabel(event.source))}
            </span>
            <span style="font-size: 0.75rem; color: var(--color-muted-foreground);">${escapeHtml(event.type)}</span>
          </div>
          ${title}
          ${locationName}
        </div>
      </div>
      <button
        id="map-event-view-${event.id}"
        style="margin-top: 0.5rem; padding: 0.25rem 0.5rem; font-size: 0.75rem; color: var(--color-foreground); border-radius: 0.25rem; border: 1px solid var(--color-border); background: transparent; cursor: pointer; transition: background 0.15s; width: 100%;"
        onmouseover="this.style.background='var(--color-accent)'"
        onmouseout="this.style.background='transparent'"
      >
        View in timeline
      </button>
    </div>
  `;

  const iconMount = element.querySelector<HTMLElement>("[data-source-icon]");
  if (!iconMount) throw new Error("Map popup source icon mount is missing");
  const dispose = render(() => <SourceIcon source={event.source} class="w-3 h-3" />, iconMount);
  return { element, dispose };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
