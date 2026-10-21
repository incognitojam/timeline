/**
 * Resolve Google Place IDs to Names via Google Places API
 *
 * Fetches place details (name, address, coordinates) for unresolved place IDs
 * found in Google Timeline events, inserts results into the places table, then
 * backfills events that currently show as just "Visit".
 *
 * Usage: bun run src/scripts/resolve-places.ts [--dry-run] [--verbose] [--limit N]
 *
 * Requires GOOGLE_PLACES_API_KEY env var.
 */

import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";

export interface ResolveResult {
  resolved: number;
  failed: number;
  skipped: number;
  eventsUpdated: number;
}

interface PlaceDetails {
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

/**
 * Find place IDs that haven't been resolved via the Google Places API yet.
 * Includes place IDs with no row in places AND those with rows from other
 * sources (e.g. google-location address-only data) that need upgrading.
 * Excludes place IDs already attempted via google-places-api (including
 * sentinel rows with name=NULL for deleted places).
 */
export function findUnresolvedPlaceIds(db: Database): string[] {
  const rows = db
    .prepare(
      `
      SELECT DISTINCT json_extract(raw_data, '$.visit.topCandidate.placeId') as place_id
      FROM events
      WHERE source = 'google-location'
        AND type = 'location:visit'
        AND json_extract(raw_data, '$.visit.topCandidate.placeId') IS NOT NULL
        AND json_extract(raw_data, '$.visit.topCandidate.placeId') NOT IN (
          SELECT place_id FROM places WHERE source = 'google-places-api' OR (name IS NOT NULL AND name != '')
        )
      `
    )
    .all() as Array<{ place_id: string }>;

  return rows.map((r) => r.place_id);
}

/**
 * Fetch place details from the Google Places API (New).
 * Returns null on 404 (place not found) or throws on auth/network errors.
 */
async function fetchPlaceDetails(
  placeId: string,
  apiKey: string
): Promise<PlaceDetails | null> {
  const url = `https://places.googleapis.com/v1/places/${placeId}`;
  const response = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "displayName,formattedAddress,location",
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    throw new RateLimitError(
      `Rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`
    );
  }

  if (response.status === 401 || response.status === 403) {
    const body = await response.text();
    throw new AuthError(`API key error (${response.status}): ${body}`);
  }

  if (!response.ok) {
    throw new Error(
      `Places API error ${response.status}: ${await response.text()}`
    );
  }

  const data = (await response.json()) as {
    displayName?: { text: string };
    formattedAddress?: string;
    location?: { latitude: number; longitude: number };
  };

  return {
    name: data.displayName?.text ?? "Unknown",
    address: data.formattedAddress ?? null,
    lat: data.location?.latitude ?? null,
    lng: data.location?.longitude ?? null,
  };
}

class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Update visit events with place names from API-resolved entries in the places table.
 * Handles both fresh "Visit" events and events previously backfilled with
 * address-only data (e.g. "Visited 5 Example Road...").
 * Returns the number of events updated.
 */
export function backfillEventsFromPlaces(db: Database): number {
  const result = db
    .prepare(
      `
      UPDATE events
      SET
        title = 'Visited ' || p.name,
        content = COALESCE(p.address, 'Place ID: ' || json_extract(events.raw_data, '$.visit.topCandidate.placeId')),
        location_name = p.name
      FROM places p
      WHERE events.source = 'google-location'
        AND events.type = 'location:visit'
        AND json_extract(events.raw_data, '$.visit.topCandidate.placeId') = p.place_id
        AND p.name IS NOT NULL AND p.name != ''
        AND COALESCE(events.location_name, '') != p.name
      `
    )
    .run();

  return result.changes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve unresolved place IDs via the Google Places API and backfill events.
 */
export async function resolvePlaces(
  db: Database,
  options: {
    apiKey: string;
    limit?: number;
    dryRun?: boolean;
    verbose?: boolean;
    signal?: AbortSignal;
  }
): Promise<ResolveResult> {
  const placeIds = findUnresolvedPlaceIds(db);

  const toProcess =
    options.limit != null ? placeIds.slice(0, options.limit) : placeIds;

  if (toProcess.length === 0) {
    if (options.verbose) console.log("No unresolved place IDs found");
    return { resolved: 0, failed: 0, skipped: 0, eventsUpdated: 0 };
  }

  console.log(
    `${options.dryRun ? "DRY RUN: " : ""}Resolving ${toProcess.length} place IDs${placeIds.length > toProcess.length ? ` (of ${placeIds.length} total)` : ""}...`
  );

  // Upsert: overwrite existing rows (e.g. address-only data) with API results
  const upsertPlace = options.dryRun
    ? null
    : db.prepare(`
        INSERT INTO places (place_id, name, address, lat, lng, source)
        VALUES (?, ?, ?, ?, ?, 'google-places-api')
        ON CONFLICT(place_id) DO UPDATE SET
          name = excluded.name,
          address = excluded.address,
          lat = excluded.lat,
          lng = excluded.lng,
          source = excluded.source
      `);

  // Sentinel: only insert if no row exists (don't overwrite existing data with NULL)
  const insertSentinel = options.dryRun
    ? null
    : db.prepare(`
        INSERT OR IGNORE INTO places (place_id, name, address, lat, lng, source)
        VALUES (?, NULL, NULL, NULL, NULL, 'google-places-api')
      `);

  let resolved = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  for (let i = 0; i < toProcess.length; i++) {
    if (options.signal?.aborted) {
      console.log("Aborted, stopping resolution");
      break;
    }

    const placeId = toProcess[i];

    try {
      const details = await fetchPlaceDetails(placeId, options.apiKey);

      if (details) {
        upsertPlace?.run(
          placeId,
          details.name,
          details.address,
          details.lat,
          details.lng
        );
        resolved++;
        consecutiveFailures = 0;
        if (options.verbose || options.dryRun) {
          console.log(
            `  [${i + 1}/${toProcess.length}] ${details.name} — ${details.address ?? "no address"}`
          );
        }
      } else {
        // Place not found — insert sentinel only if no row exists
        insertSentinel?.run(placeId);
        failed++;
        consecutiveFailures = 0;
        if (options.verbose || options.dryRun) {
          console.log(
            `  [${i + 1}/${toProcess.length}] NOT FOUND (${placeId.slice(0, 20)}...)`
          );
        }
      }
    } catch (err) {
      if (err instanceof AuthError) {
        throw err;
      }
      if (err instanceof RateLimitError) {
        console.log(`Rate limited after ${resolved} resolved, stopping`);
        break;
      }
      consecutiveFailures++;
      failed++;
      if (options.verbose || options.dryRun) {
        console.log(
          `  [${i + 1}/${toProcess.length}] ERROR: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (consecutiveFailures >= 5) {
        console.log(
          `5 consecutive failures, stopping (likely network issue)`
        );
        break;
      }
    }

    // Courtesy delay between requests
    if (i < toProcess.length - 1) {
      await sleep(100);
    }
  }

  console.log(`Resolved: ${resolved}, failed: ${failed}`);

  // Backfill events with newly resolved place names (skip in dry run)
  let eventsUpdated = 0;
  if (!options.dryRun) {
    eventsUpdated = backfillEventsFromPlaces(db);
    if (eventsUpdated > 0) {
      console.log(`Updated ${eventsUpdated} events with place names`);
    }
  }

  return {
    resolved,
    failed,
    skipped: placeIds.length - toProcess.length,
    eventsUpdated,
  };
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx !== -1 ? Number.parseInt(args[limitIdx + 1], 10) : undefined;

  if (limit != null && Number.isNaN(limit)) {
    console.error("--limit requires a number");
    process.exit(1);
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey && !dryRun) {
    console.error(
      "GOOGLE_PLACES_API_KEY env var required. Get one from https://console.cloud.google.com/apis/credentials"
    );
    process.exit(1);
  }

  const db = getDb();
  try {
    initDb(db);

    if (dryRun) {
      const unresolved = findUnresolvedPlaceIds(db);
      console.log(`${unresolved.length} unresolved place IDs`);
      if (verbose) {
        for (const id of unresolved) {
          console.log(`  ${id}`);
        }
      }
      process.exit(0);
    }

    const result = await resolvePlaces(db, {
      apiKey: apiKey as string,
      limit,
      dryRun: false,
      verbose,
    });

    console.log("\nSummary:");
    console.log(`  Resolved: ${result.resolved}`);
    console.log(`  Failed/not found: ${result.failed}`);
    console.log(`  Skipped (over limit): ${result.skipped}`);
    console.log(`  Events updated: ${result.eventsUpdated}`);
  } finally {
    db.close();
  }
}
