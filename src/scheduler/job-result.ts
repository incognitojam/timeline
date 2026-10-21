import type { SyncResult } from "../sync/types";

export function syncJobResult(result: SyncResult): Record<string, unknown> {
  return {
    source: result.source,
    skipped: result.skipped === true,
    eventsAdded: result.eventsAdded,
    eventsUpdated: result.eventsUpdated,
    durationMs: result.durationMs,
    metadata: result.metadata ?? null,
  };
}
