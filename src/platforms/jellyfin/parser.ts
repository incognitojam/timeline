import type { Database } from "bun:sqlite";

export const columns = [
  "RowId",
  "DateCreated",
  "UserId",
  "ItemId",
  "ItemType",
  "ItemName",
  "PlaybackMethod",
  "ClientName",
  "DeviceName",
  "PlayDuration",
] as const;
type Session = Record<(typeof columns)[number], string>;

export function sessionRow(values: unknown, user: string): Session {
  if (!Array.isArray(values) || values.length !== columns.length || !values.every((v) => typeof v === "string")) {
    throw new Error("Invalid Playback Reporting row");
  }
  const row = Object.fromEntries(columns.map((key, i) => [key, values[i]])) as Session;
  if (
    row.UserId !== user ||
    !/^[1-9]\d*$/.test(row.RowId) ||
    !/^[0-9a-f]{32}$/i.test(row.ItemId) ||
    !["Episode", "Movie"].includes(row.ItemType) ||
    !/^\d+$/.test(row.PlayDuration)
  )
    throw new Error("Unexpected Playback Reporting session");
  return row;
}

// Bun exposes Temporal; the project's TypeScript standard library predates its declarations.
declare const Temporal: {
  ZonedDateTime: {
    from(value: string, options: { disambiguation: "earlier" | "later" }): { epochMilliseconds: number };
  };
};

export interface Item {
  Id: string;
  Name?: string;
  SeriesName?: string;
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  ProviderIds?: Record<string, string>;
}

export function saveSession(db: Database, account: string, row: Session, zone: string, item?: Item) {
  const local = row.DateCreated.replace(" ", "T");
  const zoned = local + "[" + zone + "]";
  const earlier = Temporal.ZonedDateTime.from(zoned, { disambiguation: "earlier" }).epochMilliseconds;
  const later = Temporal.ZonedDateTime.from(zoned, { disambiguation: "later" }).epochMilliseconds;
  const timestamp = earlier === later ? new Date(earlier).toISOString() : null;
  const id = ["session", row.DateCreated, row.ItemId].join("/");
  const args = [account, id];
  const old = db
    .query<{ raw_data: string }, string[]>(
      "SELECT raw_data FROM events WHERE source='jellyfin' AND source_account=? AND source_id=?",
    )
    .get(...args);
  const metadata = item ?? (old ? JSON.parse(old.raw_data).item : undefined);
  const raw = JSON.stringify({ session: row, item: metadata });
  const type = row.ItemType === "Movie" ? "jellyfin:movie" : "jellyfin:episode";
  const title = row.ItemType === "Episode" ? row.ItemName : (metadata?.Name ?? row.ItemName);
  const duration = Number(row.PlayDuration) * 1000;
  const result = db.run(
    `INSERT INTO events (source, source_account, source_id, type, timestamp, title, duration_ms, raw_data)
    VALUES ('jellyfin',?,?,?,?,?,?,?) ON CONFLICT(source,source_id,source_account) DO UPDATE SET
    timestamp=excluded.timestamp,title=excluded.title,duration_ms=excluded.duration_ms,raw_data=excluded.raw_data
    WHERE events.raw_data IS NOT excluded.raw_data OR events.timestamp IS NOT excluded.timestamp`,
    [...args, type, timestamp, title, duration, raw],
  );
  return { added: old ? 0 : result.changes, updated: old ? result.changes : 0 };
}
