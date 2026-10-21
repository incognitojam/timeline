import { Database } from "bun:sqlite";
import type { TimelineEvent } from "./schema";


// =============================================================================
// Transport Modes & Types
// =============================================================================

export const TRANSPORT_MODES = [
  "train", "flight", "bus", "taxi", "car", "tube", "ferry", "tram",
] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

export interface TransportLocation {
  name?: string;
  code?: string;
}

export interface TransportEventInput {
  mode: TransportMode;
  origin: TransportLocation;
  destination: TransportLocation;
  departure: string;       // ISO 8601
  arrival?: string | null; // ISO 8601, null to clear
  service?: string | null; // Service/flight number, null to clear
  operator?: string | null;
  people?: number[] | null;
  notes?: string | null;
  source_account?: string;
}

/**
 * Generate a display label for a transport location.
 * Prefers name, falls back to code.
 */
function locationLabel(loc: TransportLocation): string {
  return loc.name || loc.code || "?";
}

/**
 * Generate the title for a transport event from its input.
 * Flights prefer codes (e.g. "XY123: LHR → CDG"), trains prefer names.
 */
export function generateTransportTitle(input: TransportEventInput): string {
  const isFlight = input.mode === "flight";

  let origin: string;
  let destination: string;

  if (isFlight && input.origin.code && input.destination.code) {
    origin = input.origin.code;
    destination = input.destination.code;
  } else {
    origin = locationLabel(input.origin);
    destination = locationLabel(input.destination);
  }

  const route = `${origin} → ${destination}`;
  return input.service ? `${input.service}: ${route}` : route;
}

/**
 * Create a transport event
 */
export function createTransportEvent(db: Database, input: TransportEventInput): TimelineEvent {
  const sourceId = generateManualSourceId();
  const sourceAccount = input.source_account ?? "user";
  const title = generateTransportTitle(input);
  const type = `transport:${input.mode}`;

  const people = input.people && input.people.length > 0
    ? contactIdsToIdentifiers(input.people)
    : null;

  let durationMs: number | null = null;
  let endTimestamp: string | null = null;
  if (input.arrival) {
    endTimestamp = input.arrival;
    durationMs = new Date(input.arrival).getTime() - new Date(input.departure).getTime();
    if (durationMs < 0) durationMs = null;
  }

  const rawData = {
    transport: {
      mode: input.mode,
      service: input.service || undefined,
      operator: input.operator || undefined,
      origin: input.origin,
      destination: input.destination,
    },
    origin: {
      type: sourceAccount,
      created_via: "web-ui",
      created_at: new Date().toISOString(),
    },
  };

  const tags = input.operator ? JSON.stringify([`operator:${input.operator}`]) : null;

  const result = db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp, duration_ms,
      title, content, people, tags, raw_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "manual",
    sourceId,
    sourceAccount,
    type,
    input.departure,
    endTimestamp,
    durationMs,
    title,
    input.notes || null,
    people ? JSON.stringify(people) : null,
    tags,
    JSON.stringify(rawData),
  );

  const eventId = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as TimelineEvent;
}

/**
 * Update a transport event
 */
export function updateTransportEvent(
  db: Database,
  id: number,
  input: Partial<TransportEventInput>,
): TimelineEvent | null {
  const existing = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as TimelineEvent | null;
  if (!existing) return null;
  if (existing.source !== "manual") {
    throw new Error("Cannot update non-manual events");
  }
  if (!existing.type.startsWith("transport:")) {
    throw new Error("Event is not a transport event");
  }

  // Merge with existing transport data
  const existingRawData = typeof existing.raw_data === "string"
    ? JSON.parse(existing.raw_data)
    : existing.raw_data ?? {};
  const existingTransport = existingRawData.transport ?? {};

  const merged: TransportEventInput = {
    mode: input.mode ?? existingTransport.mode,
    origin: input.origin ?? existingTransport.origin,
    destination: input.destination ?? existingTransport.destination,
    departure: input.departure ?? existing.timestamp ?? new Date().toISOString(),
    arrival: input.arrival !== undefined ? input.arrival : (existing.end_timestamp ?? undefined),
    service: input.service !== undefined ? input.service : existingTransport.service,
    operator: input.operator !== undefined ? input.operator : existingTransport.operator,
    people: input.people,
    notes: input.notes !== undefined ? input.notes : (existing.content ?? undefined),
  };

  const title = generateTransportTitle(merged);
  const type = `transport:${merged.mode}`;

  let durationMs: number | null = null;
  let endTimestamp: string | null = null;
  if (merged.arrival) {
    endTimestamp = merged.arrival;
    durationMs = new Date(merged.arrival).getTime() - new Date(merged.departure).getTime();
    if (durationMs < 0) durationMs = null;
  }

  const people = input.people !== undefined
    ? (input.people && input.people.length > 0 ? contactIdsToIdentifiers(input.people) : null)
    : (existing.people ? undefined : null); // undefined = don't update

  const tags = merged.operator ? JSON.stringify([`operator:${merged.operator}`]) : null;

  const updatedRawData = {
    ...existingRawData,
    transport: {
      mode: merged.mode,
      service: merged.service || undefined,
      operator: merged.operator || undefined,
      origin: merged.origin,
      destination: merged.destination,
    },
    origin: {
      ...existingRawData.origin,
      updated_at: new Date().toISOString(),
    },
  };

  const sets = [
    "type = ?", "timestamp = ?", "end_timestamp = ?", "duration_ms = ?",
    "title = ?", "content = ?", "tags = ?", "raw_data = ?",
  ];
  const params: (string | number | null)[] = [
    type, merged.departure, endTimestamp, durationMs,
    title, merged.notes || null, tags, JSON.stringify(updatedRawData),
  ];

  if (people !== undefined) {
    sets.push("people = ?");
    params.push(people ? JSON.stringify(people) : null);
  }

  params.push(id);
  db.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  return db.prepare("SELECT * FROM events WHERE id = ?").get(id) as TimelineEvent;
}


// =============================================================================
// Manual Event Management
// =============================================================================

export interface ManualEventInput {
  timestamp: string;
  title: string;
  content?: string;
  /** Contact IDs - stored as "contact:N" identifiers */
  people?: number[];
  /** Origin tracking - defaults to 'user' for UI-created events */
  source_account?: string;
  /** Additional metadata stored in raw_data.origin */
  origin?: Record<string, unknown>;
}

/**
 * Generate a unique source_id for manual events
 */
function generateManualSourceId(): string {
  return `manual_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Convert contact IDs to "contact:N" identifiers for storage in the people field.
 * The identity resolution system handles resolving these to display names.
 */
function contactIdsToIdentifiers(contactIds: number[]): string[] {
  return contactIds.map(id => `contact:${id}`);
}

/**
 * Create a manual event
 */
export function createManualEvent(db: Database, input: ManualEventInput): TimelineEvent {
  const sourceId = generateManualSourceId();
  const sourceAccount = input.source_account ?? "user";

  const people = input.people && input.people.length > 0
    ? contactIdsToIdentifiers(input.people)
    : null;

  // Build raw_data with origin metadata
  const rawData = {
    ...input,
    origin: {
      type: sourceAccount,
      created_via: "web-ui",
      created_at: new Date().toISOString(),
      ...input.origin,
    },
  };

  const result = db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, raw_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "manual",
    sourceId,
    sourceAccount,
    "note",
    input.timestamp,
    input.title,
    input.content ?? null,
    people ? JSON.stringify(people) : null,
    JSON.stringify(rawData)
  );

  const eventId = Number(result.lastInsertRowid);
  return db.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as TimelineEvent;
}

/**
 * Update a manual event (only works for source='manual')
 */
export function updateManualEvent(
  db: Database,
  id: number,
  input: Partial<Omit<ManualEventInput, "source_account" | "origin">>
): TimelineEvent | null {
  // Verify the event exists and is a manual event
  const existing = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as TimelineEvent | null;
  if (!existing) return null;
  if (existing.source !== "manual") {
    throw new Error("Cannot update non-manual events");
  }

  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.timestamp !== undefined) {
    sets.push("timestamp = ?");
    params.push(input.timestamp);
  }
  if (input.title !== undefined) {
    sets.push("title = ?");
    params.push(input.title);
  }
  if (input.content !== undefined) {
    sets.push("content = ?");
    params.push(input.content ?? null);
  }
  if (input.people !== undefined) {
    const people = input.people && input.people.length > 0
      ? contactIdsToIdentifiers(input.people)
      : null;
    sets.push("people = ?");
    params.push(people ? JSON.stringify(people) : null);
  }

  if (sets.length === 0) {
    return existing;
  }

  // Update raw_data to include update history
  const existingRawData = typeof existing.raw_data === "string"
    ? JSON.parse(existing.raw_data)
    : existing.raw_data ?? {};
  const updatedRawData = {
    ...existingRawData,
    ...input,
    origin: {
      ...existingRawData.origin,
      updated_at: new Date().toISOString(),
    },
  };
  sets.push("raw_data = ?");
  params.push(JSON.stringify(updatedRawData));

  params.push(id);
  db.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  return db.prepare("SELECT * FROM events WHERE id = ?").get(id) as TimelineEvent;
}

export interface JournalEventUpdateInput {
  type?: "journal:qa" | "journal:reflection";
  timestamp?: string;
  title?: string;
  content?: string | null;
  importBatch?: string | null;
  rawData?: Record<string, unknown>;
}

/**
 * Update a journal event in place.
 */
export function updateJournalEvent(
  db: Database,
  id: number,
  input: JournalEventUpdateInput,
): TimelineEvent | null {
  const existing = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as TimelineEvent | null;
  if (!existing) return null;
  if (existing.source !== "journal") {
    throw new Error("Cannot update non-journal events");
  }

  const existingRawData = typeof existing.raw_data === "string"
    ? JSON.parse(existing.raw_data)
    : existing.raw_data ?? {};
  const updatedRawData = {
    ...existingRawData,
    ...input.rawData,
    origin: {
      ...existingRawData.origin,
      updated_at: new Date().toISOString(),
    },
  };

  db.prepare(`
    UPDATE events
    SET type = ?, timestamp = ?, title = ?, content = ?, import_batch = ?, raw_data = ?
    WHERE id = ?
  `).run(
    input.type ?? existing.type,
    input.timestamp ?? existing.timestamp,
    input.title ?? existing.title,
    input.content ?? existing.content,
    input.importBatch ?? existing.import_batch,
    JSON.stringify(updatedRawData),
    id,
  );

  return db.prepare("SELECT * FROM events WHERE id = ?").get(id) as TimelineEvent;
}

/** Sources that the user can delete via the API */
const DELETABLE_SOURCES = new Set(["manual", "journal"]);

/**
 * Delete a manual or journal event
 */
export function deleteManualEvent(db: Database, id: number): boolean {
  const existing = db.prepare("SELECT source FROM events WHERE id = ?").get(id) as { source: string } | null;
  if (!existing) return false;
  if (!DELETABLE_SOURCES.has(existing.source)) {
    throw new Error("Cannot delete non-manual events");
  }

  db.prepare("DELETE FROM events WHERE id = ?").run(id);
  return true;
}
