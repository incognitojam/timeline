// MapTiler style configuration
// Docs: https://docs.maptiler.com/maplibre-gl-js/

const MAPTILER_API_KEY = import.meta.env.VITE_MAPTILER_API_KEY;

if (!MAPTILER_API_KEY) {
  throw new Error(
    "VITE_MAPTILER_API_KEY is not set. Add it to web/.env"
  );
}

// Available MapTiler styles: streets-v2, satellite, hybrid, topo-v2, basic-v2, bright-v2, etc.
// Using streets-v2 as default - clean and readable
export const MAP_STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_API_KEY}`;

// Alternative styles for future use
export const MAP_STYLES = {
  streets: `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_API_KEY}`,
  satellite: `https://api.maptiler.com/maps/satellite/style.json?key=${MAPTILER_API_KEY}`,
  hybrid: `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_API_KEY}`,
  topo: `https://api.maptiler.com/maps/topo-v2/style.json?key=${MAPTILER_API_KEY}`,
  dark: `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${MAPTILER_API_KEY}`,
} as const;

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

// Get map style URL based on color scheme
export function getMapStyleUrl(colorScheme: "dark" | "light"): string {
  return colorScheme === "dark" ? MAP_STYLES.dark : MAP_STYLES.streets;
}

// Default map center (UK) - will be overridden by fitBounds
export const DEFAULT_CENTER: [number, number] = [-1.5, 53.5];
export const DEFAULT_ZOOM = 6;
