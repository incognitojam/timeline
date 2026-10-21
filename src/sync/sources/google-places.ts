/**
 * Google Places Sync Source
 *
 * Resolves Google Place IDs to human-readable names via the Places API.
 * Processes unresolved place IDs from Google Timeline events and backfills
 * event titles/location names.
 */

import { getDb, initDb } from "../../db/schema";
import {
  findUnresolvedPlaceIds,
  resolvePlaces,
} from "../../scripts/resolve-places";
import type { SyncOptions, SyncResult, SyncSource } from "../types";

function getApiKey(): string | null {
  return process.env.GOOGLE_PLACES_API_KEY ?? null;
}

export const googlePlacesSyncSource: SyncSource = {
  name: "google-places",
  description: "Resolve Google Place IDs to names via Places API",
  enabled: true,

  async canSync(): Promise<string | null> {
    const apiKey = getApiKey();
    if (!apiKey) {
      return "GOOGLE_PLACES_API_KEY env var not set";
    }
    const db = getDb();
    try {
      initDb(db);
      return null;
    } finally {
      db.close();
    }
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const apiKey = getApiKey();

    if (!apiKey) {
      return {
        source: "google-places",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "GOOGLE_PLACES_API_KEY env var not set",
        durationMs: Date.now() - startTime,
      };
    }

    const db = getDb();
    try {
      initDb(db);

      const result = await resolvePlaces(db, {
        apiKey,
        verbose: options.verbose,
        signal: options.signal,
      });

      return {
        source: "google-places",
        success: true,
        eventsAdded: 0,
        eventsUpdated: result.eventsUpdated,
        durationMs: Date.now() - startTime,
        metadata: {
          resolved: result.resolved,
          failed: result.failed,
          skipped: result.skipped,
        },
      };
    } catch (err) {
      return {
        source: "google-places",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    } finally {
      db.close();
    }
  },
};
