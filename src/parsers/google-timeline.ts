import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";

interface LatLng {
  latLng: string; // "50.0000000°, -1.0000000°"
}

interface PlaceCandidate {
  placeId: string;
  semanticType: string;
  probability: number;
  placeLocation: LatLng;
}

interface Visit {
  hierarchyLevel: number;
  probability: number;
  topCandidate: PlaceCandidate;
}

interface ActivityCandidate {
  type: string; // "IN_PASSENGER_VEHICLE", "WALKING", etc.
  probability: number;
}

interface Activity {
  start: LatLng;
  end: LatLng;
  distanceMeters: number;
  topCandidate: ActivityCandidate;
}

interface TimelinePathPoint {
  point: string; // "50.0001000°, -1.0001000°"
  time: string;
}

interface TripDestination {
  identifier: {
    placeId: string;
  };
}

interface TimelineMemory {
  trip?: {
    distanceFromOriginKms: number;
    destinations: TripDestination[];
  };
}

interface SemanticSegment {
  startTime: string;
  endTime: string;
  startTimeTimezoneUtcOffsetMinutes?: number;
  endTimeTimezoneUtcOffsetMinutes?: number;
  visit?: Visit;
  activity?: Activity;
  timelinePath?: TimelinePathPoint[];
  timelineMemory?: TimelineMemory;
}

interface TimelineExport {
  semanticSegments: SemanticSegment[];
}

function parseLatLng(str: string): { lat: number; lng: number } | null {
  // Format: "50.0000000°, -1.0000000°"
  const match = str.match(/([-\d.]+)°,\s*([-\d.]+)°/);
  if (!match) return null;
  return {
    lat: parseFloat(match[1]),
    lng: parseFloat(match[2]),
  };
}

function activityTypeToReadable(type: string): string {
  const map: Record<string, string> = {
    IN_PASSENGER_VEHICLE: "in passenger vehicle",
    IN_VEHICLE: "driving",
    IN_BUS: "bus",
    IN_TRAIN: "train",
    IN_TRAM: "tram",
    IN_SUBWAY: "subway",
    IN_FERRY: "ferry",
    WALKING: "walking",
    RUNNING: "running",
    CYCLING: "cycling",
    FLYING: "flying",
    MOTORCYCLING: "motorcycle",
    SKIING: "skiing",
    SNOWBOARDING: "snowboarding",
    SAILING: "sailing",
  };
  return map[type] || type.toLowerCase().replace(/_/g, " ");
}

function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)}m`;
  }
  return `${(meters / 1000).toFixed(1)}km`;
}

export async function importTimelineData(
  db: Database,
  importPath: string,
  sourceAccount: string
): Promise<{ eventsAdded: number; eventsUpdated: number }> {
  const importBatch = `google-timeline-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp, duration_ms,
      title, content, latitude, longitude, location_name, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, source_id, source_account) DO UPDATE SET
      type = excluded.type,
      timestamp = excluded.timestamp,
      end_timestamp = excluded.end_timestamp,
      duration_ms = excluded.duration_ms,
      title = excluded.title,
      content = excluded.content,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      location_name = excluded.location_name,
      tags = excluded.tags,
      raw_data = excluded.raw_data,
      import_batch = excluded.import_batch
    WHERE raw_data != excluded.raw_data
      OR title != excluded.title
      OR content != excluded.content
      OR location_name IS NOT excluded.location_name
  `);

  // Lookup place names from the places table
  const lookupPlace = db.prepare(`
    SELECT name, address FROM places WHERE place_id = ?
  `);

  console.log("Loading Timeline.json...");
  const data: TimelineExport = await Bun.file(importPath).json();
  console.log(`Found ${data.semanticSegments.length} segments`);

  let inserted = 0;
  let updated = 0;
  let visitsWithNames = 0;
  let skipped = 0;

  const exists = db.prepare(`
    SELECT 1 FROM events WHERE source = ? AND source_id = ? AND source_account = ?
  `);

  const processSegments = db.transaction((segments: SemanticSegment[]) => {
    for (const segment of segments) {
      // Skip timeline paths and memories - they're supplementary data
      if (!segment.visit && !segment.activity) {
        skipped++;
        continue;
      }

      const startTime = new Date(segment.startTime).toISOString();
      const endTime = new Date(segment.endTime).toISOString();
      const durationMs = new Date(segment.endTime).getTime() - new Date(segment.startTime).getTime();

      if (segment.visit) {
        const visit = segment.visit;
        const placeId = visit.topCandidate.placeId;
        const coords = parseLatLng(visit.topCandidate.placeLocation.latLng);

        // Use placeId + startTime as unique ID
        const sourceId = `visit-${placeId}-${segment.startTime}`;

        const tags: string[] = [];
        if (visit.topCandidate.semanticType !== "UNKNOWN") {
          tags.push(visit.topCandidate.semanticType.toLowerCase());
        }

        // Look up place name from places table
        const place = lookupPlace.get(placeId) as { name: string; address: string } | null;
        const title = place?.name ? `Visited ${place.name}` : "Visit";
        const content = place?.address || `Place ID: ${placeId}`;
        const locationName = place?.name || null;

        try {
          const existed = exists.get("google-location", sourceId, sourceAccount);
          const result = insert.run(
            "google-location",
            sourceId,
            sourceAccount,
            "location:visit",
            startTime,
            endTime,
            durationMs,
            title,
            content,
            coords?.lat ?? null,
            coords?.lng ?? null,
            locationName,
            JSON.stringify(tags),
            JSON.stringify(segment),
            importBatch
          );
          if (result.changes > 0) {
            if (existed) {
              updated++;
            } else {
              inserted++;
            }
            if (place?.name) visitsWithNames++;
          }
        } catch {
          skipped++;
        }
      }

      if (segment.activity) {
        const activity = segment.activity;
        const activityType = activityTypeToReadable(activity.topCandidate.type);
        const distance = formatDistance(activity.distanceMeters);

        const startCoords = parseLatLng(activity.start.latLng);
        const endCoords = parseLatLng(activity.end.latLng);

        // Use activity type + startTime as unique ID
        const sourceId = `activity-${segment.startTime}`;

        try {
          const existed = exists.get("google-location", sourceId, sourceAccount);
          const result = insert.run(
            "google-location",
            sourceId,
            sourceAccount,
            "location:transit",
            startTime,
            endTime,
            durationMs,
            `${activityType} ${distance}`,
            `${activityType} from (${startCoords?.lat}, ${startCoords?.lng}) to (${endCoords?.lat}, ${endCoords?.lng})`,
            startCoords?.lat ?? null,
            startCoords?.lng ?? null,
            null,
            JSON.stringify([activityType]),
            JSON.stringify(segment),
            importBatch
          );
          if (result.changes > 0) {
            if (existed) {
              updated++;
            } else {
              inserted++;
            }
          }
        } catch {
          skipped++;
        }
      }
    }
  });

  // Process in batches to avoid memory issues
  const batchSize = 10000;
  for (let i = 0; i < data.semanticSegments.length; i += batchSize) {
    const batch = data.semanticSegments.slice(i, i + batchSize);
    processSegments(batch);
    console.log(`Processed ${Math.min(i + batchSize, data.semanticSegments.length)} / ${data.semanticSegments.length} segments`);
  }

  console.log(`\nImport complete:`);
  console.log(`  Inserted: ${inserted} (${visitsWithNames} visits with place names)`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped} (paths, memories, unchanged)`);
  console.log(`  Batch ID: ${importBatch}`);

  return { eventsAdded: inserted, eventsUpdated: updated };
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: bun run src/parsers/google-timeline.ts <Timeline.json> [account-name]");
    console.log("Example: bun run src/parsers/google-timeline.ts ~/Downloads/Timeline.json my-account");
    process.exit(1);
  }

  const importPath = args[0];
  const accountName = args[1] || "default";

  const db = getDb();
  initDb(db);

  await importTimelineData(db, importPath, accountName);

  db.close();
}
