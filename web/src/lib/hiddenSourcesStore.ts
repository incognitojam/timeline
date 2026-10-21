import { createLocalStorageSignal } from "./createLocalStorageSignal";

const STORAGE_KEY = "timeline:hiddenSources";

// Sources hidden by default when the user has no stored preference.
// Recall captures land every 30s, so showing them inline buries everything else.
const DEFAULT_HIDDEN_SOURCES: readonly string[] = ["recall"];

// Migration: any new entry added to DEFAULT_HIDDEN_SOURCES is auto-hidden once
// per user even if they already have a stored preference. Bump the version when
// adding entries so existing users get the same default behaviour.
const MIGRATION_KEY = "timeline:hiddenSources:defaultsApplied";
const MIGRATION_VERSION = "1";

// Apply default-hidden migration to existing preferences exactly once. Runs
// before the signal is created so the on-disk value matches the in-memory one.
function migrateExistingPreferences() {
  if (typeof window === "undefined") return;
  try {
    if (localStorage.getItem(MIGRATION_KEY) === MIGRATION_VERSION) return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const current = new Set<string>(JSON.parse(raw));
      let changed = false;
      for (const s of DEFAULT_HIDDEN_SOURCES) {
        if (!current.has(s)) {
          current.add(s);
          changed = true;
        }
      }
      if (changed) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...current]));
      }
    }
    localStorage.setItem(MIGRATION_KEY, MIGRATION_VERSION);
  } catch {
    // Storage unavailable — fall through with default behaviour
  }
}

migrateExistingPreferences();

// Module-level store so the hidden-sources state is shared across the app and
// persists across DayTimeline remounts when navigating between dates.
const [hiddenSources, setHiddenSources] = createLocalStorageSignal<Set<string>>(
  STORAGE_KEY,
  new Set<string>(DEFAULT_HIDDEN_SOURCES),
  {
    serialize: (value) => JSON.stringify([...value]),
    deserialize: (raw) => new Set<string>(JSON.parse(raw)),
  },
);

export { hiddenSources };

export function toggleHiddenSource(source: string) {
  const next = new Set(hiddenSources());
  if (next.has(source)) {
    next.delete(source);
  } else {
    next.add(source);
  }
  setHiddenSources(next);
}

export function clearHiddenSources() {
  setHiddenSources(new Set<string>());
}
