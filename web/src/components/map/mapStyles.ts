// MapTiler style configuration
// Docs: https://docs.maptiler.com/maplibre-gl-js/

import type { StyleSpecification } from "maplibre-gl";

// Only a dev server can lack the key: vite.config.ts refuses to build without it.
const MAPTILER_API_KEY = import.meta.env.VITE_MAPTILER_API_KEY?.trim() || undefined;
export const HAS_MAP_TILES = MAPTILER_API_KEY !== undefined;

function offlineStyle(backgroundColor: string): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": backgroundColor } }],
  };
}

// Marker colors by event type
export const MARKER_COLORS: Record<string, string> = {
  "location:visit": "#3b82f6",     // Blue
  "location:transit": "#6b7280",   // Gray
  "transaction": "#22c55e",        // Green
  "activity": "#8b5cf6",           // Purple
  default: "#f97316",              // Orange (fallback)
};

export function getMarkerColor(eventType: string): string {
  // Check exact match first
  if (MARKER_COLORS[eventType]) {
    return MARKER_COLORS[eventType];
  }
  // Check prefix match (e.g., "transaction:food" matches "transaction")
  const prefix = eventType.split(":")[0];
  if (MARKER_COLORS[prefix]) {
    return MARKER_COLORS[prefix];
  }
  return MARKER_COLORS.default;
}

// Get map style based on color scheme
export function getMapStyle(colorScheme: "dark" | "light"): string | StyleSpecification {
  if (!MAPTILER_API_KEY) return offlineStyle(colorScheme === "dark" ? "#1f2937" : "#e5e7eb");
  const style = colorScheme === "dark" ? "dataviz-dark" : "streets-v2";
  return `https://api.maptiler.com/maps/${style}/style.json?key=${MAPTILER_API_KEY}`;
}

// Default map center (UK) - will be overridden by fitBounds
export const DEFAULT_CENTER: [number, number] = [-1.5, 53.5];
export const DEFAULT_ZOOM = 6;
