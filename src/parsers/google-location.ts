import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runParser } from "../lib/parser-cli";

interface PlaceVisit {
  location: {
    latitudeE7: number;
    longitudeE7: number;
    placeId?: string;
    address?: string;
    name?: string;
    semanticType?: string;
  };
  duration: {
    startTimestamp: string;
    endTimestamp: string;
  };
  placeConfidence?: string;
}

interface ActivitySegment {
  startLocation?: {
    latitudeE7: number;
    longitudeE7: number;
  };
  endLocation?: {
    latitudeE7: number;
    longitudeE7: number;
  };
  duration: {
    startTimestamp: string;
    endTimestamp: string;
  };
  distance?: number;
  activityType?: string;
  confidence?: string;
}

interface TimelineObject {
  placeVisit?: PlaceVisit;
  activitySegment?: ActivitySegment;
}

interface SemanticLocationFile {
  timelineObjects: TimelineObject[];
}

function e7ToDecimal(e7: number): number {
  return e7 / 1e7;
}

function getDurationMs(start: string, end: string): number {
  return new Date(end).getTime() - new Date(start).getTime();
}

export async function importGoogleLocation(
  db: Database,
  importPath: string,
  sourceAccount: string
) {
  const importBatch = `google-location-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp, duration_ms,
      title, content, latitude, longitude, location_name, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let stats = { visits: 0, transits: 0, skipped: 0 };

  // Find Semantic Location History folder
  const semanticPath = join(importPath, "Takeout", "Location History (Timeline)", "Semantic Location History");

  let years: string[];
  try {
    years = await readdir(semanticPath);
  } catch {
    console.error(`Could not find Semantic Location History at ${semanticPath}`);
    process.exit(1);
  }

  for (const year of years) {
    const yearPath = join(semanticPath, year);
    let months: string[];
    try {
      months = await readdir(yearPath);
    } catch {
      continue;
    }

    for (const monthFile of months) {
      if (!monthFile.endsWith(".json")) continue;

      const filePath = join(yearPath, monthFile);
      let data: SemanticLocationFile;
      try {
        data = await Bun.file(filePath).json();
      } catch {
        console.error(`Failed to parse ${filePath}`);
        continue;
      }

      console.log(`Processing ${year}/${monthFile}: ${data.timelineObjects?.length || 0} objects`);

      if (!data.timelineObjects) continue;

      const insertMany = db.transaction((objects: TimelineObject[]) => {
        for (const obj of objects) {
          try {
            if (obj.placeVisit) {
              const visit = obj.placeVisit;
              const loc = visit.location;
              const dur = visit.duration;

              const lat = e7ToDecimal(loc.latitudeE7);
              const lng = e7ToDecimal(loc.longitudeE7);
              const durationMs = getDurationMs(dur.startTimestamp, dur.endTimestamp);

              // Skip very short visits (< 1 minute)
              if (durationMs < 60000) {
                stats.skipped++;
                continue;
              }

              const locationName = loc.name || loc.address || null;
              const title = locationName
                ? `Visited ${locationName}`
                : `Location visit`;

              insert.run(
                "google-location",
                `visit:${dur.startTimestamp}:${loc.placeId || `${lat},${lng}`}`,
                sourceAccount,
                "location:visit",
                dur.startTimestamp,
                dur.endTimestamp,
                durationMs,
                title,
                loc.address || null,
                lat,
                lng,
                locationName,
                loc.semanticType ? JSON.stringify([loc.semanticType]) : null,
                JSON.stringify(visit),
                importBatch
              );
              stats.visits++;
            }

            if (obj.activitySegment) {
              const seg = obj.activitySegment;
              const dur = seg.duration;

              if (!seg.startLocation || !seg.endLocation) {
                stats.skipped++;
                continue;
              }

              const durationMs = getDurationMs(dur.startTimestamp, dur.endTimestamp);

              // Skip very short transits (< 1 minute)
              if (durationMs < 60000) {
                stats.skipped++;
                continue;
              }

              const activityType = seg.activityType?.toLowerCase().replace(/_/g, " ") || "transit";
              const distanceKm = seg.distance ? (seg.distance / 1000).toFixed(1) : null;

              const title = distanceKm
                ? `${activityType} ${distanceKm}km`
                : activityType;

              // Use midpoint for location
              const startLat = e7ToDecimal(seg.startLocation.latitudeE7);
              const startLng = e7ToDecimal(seg.startLocation.longitudeE7);

              insert.run(
                "google-location",
                `transit:${dur.startTimestamp}`,
                sourceAccount,
                "location:transit",
                dur.startTimestamp,
                dur.endTimestamp,
                durationMs,
                title,
                null,
                startLat,
                startLng,
                null,
                JSON.stringify([seg.activityType || "UNKNOWN"]),
                JSON.stringify(seg),
                importBatch
              );
              stats.transits++;
            }
          } catch (e) {
            stats.skipped++;
          }
        }
      });

      insertMany(data.timelineObjects);
    }
  }

  console.log(`\nImport complete:`);
  console.log(`  Place visits: ${stats.visits}`);
  console.log(`  Transits: ${stats.transits}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  return stats.visits + stats.transits;
}

// CLI
if (import.meta.main) {
  runParser(importGoogleLocation, {
    name: "google-location",
    examples: ["bun run src/parsers/google-location.ts ./imports/google my-account"],
  });
}
