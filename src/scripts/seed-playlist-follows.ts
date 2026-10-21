#!/usr/bin/env bun
/**
 * Seed historical Spotify playlist follower counts from a CSV / Google Sheet.
 *
 * Spotify's API only returns a playlist's *current* follower count, so it can't
 * reconstruct history. This backfills the `spotify_playlist_observations` table
 * from a manually-maintained log (origin = 'seed'), after which the
 * spotify-playlists sync source continues the series going forward.
 *
 * The CSV needs a date column and a count column (defaults: "Date" and "Likes").
 * Dates may be YYYY/MM/DD, YYYY-MM-DD, or anything Date.parse understands.
 *
 * Usage:
 *   bun run src/scripts/seed-playlist-follows.ts \
 *     --playlist <id|url|uri> \
 *     --csv <path-or-url> \
 *     [--name "Playlist Name"] [--date-col Date] [--count-col Likes] [--dry-run]
 *
 * A Google Sheets "/edit" URL is rewritten to a CSV export URL automatically.
 * Writes to the database at TIMELINE_DB_PATH (defaults to ./timeline.db).
 */

import { parseArgs } from "util";
import { readFileSync } from "node:fs";
import { getDb, initDb } from "../db/schema";
import {
  recordPlaylistObservation,
  getPlaylistObservations,
  fillMissingPlaylistName,
} from "../db/playlist-follows";
import {
  extractPlaylistId,
  getValidSpotifyTokens,
  fetchPlaylistName,
} from "../parsers/spotify-api";

/** Rewrite a Google Sheets edit URL to a CSV export URL (preserving gid). */
function toCsvUrl(url: string): string {
  const sheetMatch = url.match(
    /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/,
  );
  if (!sheetMatch) return url;
  const id = sheetMatch[1];
  const gidMatch = url.match(/[#&?]gid=(\d+)/);
  const gid = gidMatch ? `&gid=${gidMatch[1]}` : "";
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid}`;
}

async function loadCsv(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const url = toCsvUrl(source);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Failed to fetch CSV (${res.status}) from ${url}`);
    }
    return res.text();
  }
  return readFileSync(source, "utf-8");
}

/** Minimal CSV parser handling quoted fields and CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Normalize a date string to YYYY-MM-DD, or null if unparseable. */
function normalizeDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const ymd = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (ymd) {
    const [, y, m, d] = ymd;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Parse a follower count, tolerating thousands separators (commas, spaces,
 * underscores). Returns null for anything that isn't a clean non-negative
 * integer, so malformed cells are skipped loudly rather than silently
 * truncated — e.g. Number.parseInt("1,234", 10) === 1.
 */
export function parseFollowerCount(raw: string): number | null {
  const cleaned = raw.trim().replace(/[,_\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  return Number.parseInt(cleaned, 10);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      playlist: { type: "string" },
      csv: { type: "string" },
      name: { type: "string" },
      "date-col": { type: "string", default: "Date" },
      "count-col": { type: "string", default: "Likes" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (!values.playlist || !values.csv) {
    console.error(
      'Usage: bun run src/scripts/seed-playlist-follows.ts --playlist <id|url> --csv <path-or-url> [--name "Playlist Name"] [--date-col Date] [--count-col Likes] [--dry-run]',
    );
    process.exit(1);
  }

  const playlistId = extractPlaylistId(values.playlist);
  if (!playlistId) {
    console.error(`Could not parse a playlist ID from: ${values.playlist}`);
    process.exit(1);
  }

  const csvText = await loadCsv(values.csv);
  const rows = parseCsv(csvText).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) {
    console.error("CSV is empty.");
    process.exit(1);
  }

  const header = rows[0].map((h) => h.trim());
  const dateIdx = header.indexOf(values["date-col"]);
  const countIdx = header.indexOf(values["count-col"]);
  if (dateIdx === -1 || countIdx === -1) {
    console.error(
      `CSV missing required columns. Looked for "${values["date-col"]}" and "${values["count-col"]}"; found: ${header.join(", ")}`,
    );
    process.exit(1);
  }

  const dryRun = values["dry-run"];
  const db = getDb();
  initDb(db);

  let imported = 0;
  let skipped = 0;

  const apply = db.transaction(() => {
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const observedDate = normalizeDate(row[dateIdx] ?? "");
      const rawCount = (row[countIdx] ?? "").trim();
      const count = parseFollowerCount(rawCount);

      if (!observedDate || count === null) {
        console.warn(
          `Skipped row ${i + 1}: date="${row[dateIdx] ?? ""}" count="${rawCount}"`,
        );
        skipped++;
        continue;
      }

      if (!dryRun) {
        recordPlaylistObservation(db, {
          playlistId,
          observedDate,
          observedAt: `${observedDate}T12:00:00.000Z`,
          followerCount: count,
          name: values.name ?? null,
          origin: "seed",
          rawData: Object.fromEntries(
            header.map((h, idx) => [h, row[idx] ?? ""]),
          ),
        });
      }
      imported++;
    }
  });

  apply();

  console.log(
    `${dryRun ? "[dry-run] would import" : "Imported"} ${imported} observation(s) for playlist ${playlistId} (${skipped} row(s) skipped).`,
  );

  // Resolve the real playlist name from Spotify (best-effort) unless one was
  // supplied. Requires Spotify auth; if unavailable (e.g. local dev), the name
  // fills in on the first live sync instead.
  if (!dryRun && !values.name) {
    try {
      const tokens = await getValidSpotifyTokens({ headless: true });
      const fetched = await fetchPlaylistName(tokens, playlistId);
      if (fetched) {
        const updated = fillMissingPlaylistName(db, playlistId, fetched);
        console.log(`Resolved playlist name "${fetched}" (applied to ${updated} row(s)).`);
      } else {
        console.warn(
          "Playlist name unavailable (deleted/private?); will resolve on first sync.",
        );
      }
    } catch (error) {
      console.warn(
        `Could not fetch playlist name (will resolve on first sync): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!dryRun) {
    const all = getPlaylistObservations(db, playlistId);
    const first = all[0];
    const last = all[all.length - 1];
    if (first && last) {
      console.log(
        `Series now spans ${first.observed_date} (${first.follower_count}) → ${last.observed_date} (${last.follower_count}), ${all.length} total observation(s).`,
      );
    }
  }

  db.close();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
