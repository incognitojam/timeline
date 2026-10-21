import type { QueryExecutor } from "./pool";
import type { TimelineEvent } from "./schema";
import { transformEvents } from "./events";

/**
 * Search events by location
 */
export async function searchByLocation(
  db: QueryExecutor,
  options: { latitude?: number; longitude?: number; radiusKm?: number; locationName?: string; limit?: number }
): Promise<TimelineEvent[]> {
  const { latitude, longitude, radiusKm = 1, locationName, limit = 50 } = options;

  if (locationName) {
    // Search by location name using FTS
    // Wrap in double quotes for literal matching
    const escapedName = '"' + locationName.replace(/"/g, '""') + '"';
    const sql = `
      SELECT * FROM events
      WHERE id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)
        AND location_name IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    return transformEvents(await db.query<TimelineEvent>(sql, escapedName, limit));
  }

  if (latitude !== undefined && longitude !== undefined) {
    // Approximate distance using Haversine-like bounding box
    // 1 degree latitude ≈ 111km
    // 1 degree longitude ≈ 111km * cos(latitude)
    const latDelta = radiusKm / 111;
    const lonDelta = radiusKm / (111 * Math.cos((latitude * Math.PI) / 180));

    const sql = `
      SELECT * FROM events
      WHERE latitude BETWEEN ? AND ?
        AND longitude BETWEEN ? AND ?
      ORDER BY timestamp ASC
      LIMIT ?
    `;

    return transformEvents(await db.query<TimelineEvent>(sql, latitude - latDelta, latitude + latDelta, longitude - lonDelta, longitude + lonDelta, limit));
  }

  return [];
}

// Lightweight event structure for map display
export interface MapEvent {
  id: number;
  latitude: number;
  longitude: number;
  location_name: string | null;
  title: string | null;
  type: string;
  source: string;
  timestamp: string;
}

/**
 * Get events with location data for a specific day (for map display)
 * Returns lightweight MapEvent structure optimized for map rendering
 */
export async function getMapEventsForDay(
  db: QueryExecutor,
  date: string,
  options?: { types?: string[] }
): Promise<MapEvent[]> {
  const dayStart = date + "T00:00:00";
  const dayEnd = date + "T24:00:00";

  let sql = `
    SELECT id, latitude, longitude, location_name, title, type, source, timestamp
    FROM events
    WHERE timestamp >= ? AND timestamp < ?
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
  `;
  const params: (string | number)[] = [dayStart, dayEnd];

  // Filter by event types if specified
  if (options?.types && options.types.length > 0) {
    const placeholders = options.types.map(() => "?").join(", ");
    sql += ` AND (type IN (${placeholders})`;
    // Also match type prefixes (e.g., "transaction" matches "transaction:food")
    const prefixConditions = options.types.map(() => "type LIKE ?").join(" OR ");
    sql += ` OR ${prefixConditions})`;
    params.push(...options.types);
    params.push(...options.types.map((t) => t + ":%"));
  }

  sql += " ORDER BY timestamp ASC";

  return await db.query<MapEvent>(sql, ...params);
}
