import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runParser } from "../lib/parser-cli";

interface SpotifyStreamingEntry {
  ts: string;
  platform: string;
  ms_played: number;
  conn_country: string;
  ip_addr: string;
  master_metadata_track_name: string | null;
  master_metadata_album_artist_name: string | null;
  master_metadata_album_album_name: string | null;
  spotify_track_uri: string | null;
  episode_name: string | null;
  episode_show_name: string | null;
  spotify_episode_uri: string | null;
  audiobook_title: string | null;
  audiobook_uri: string | null;
  audiobook_chapter_uri: string | null;
  audiobook_chapter_title: string | null;
  reason_start: string;
  reason_end: string;
  shuffle: boolean;
  skipped: boolean;
  offline: boolean;
  offline_timestamp: number | null;
  incognito_mode: boolean;
}

function determineType(entry: SpotifyStreamingEntry): string {
  if (entry.spotify_track_uri) return "listen:track";
  if (entry.spotify_episode_uri) return "listen:podcast";
  if (entry.audiobook_uri) return "listen:audiobook";
  return "listen:unknown";
}

function getTitle(entry: SpotifyStreamingEntry): string | null {
  if (entry.master_metadata_track_name) return entry.master_metadata_track_name;
  if (entry.episode_name) return entry.episode_name;
  if (entry.audiobook_chapter_title) return entry.audiobook_chapter_title;
  return null;
}

function getContent(entry: SpotifyStreamingEntry): string | null {
  const parts: string[] = [];

  if (entry.master_metadata_track_name) {
    parts.push(entry.master_metadata_track_name);
    if (entry.master_metadata_album_artist_name) {
      parts.push(`by ${entry.master_metadata_album_artist_name}`);
    }
    if (entry.master_metadata_album_album_name) {
      parts.push(`from ${entry.master_metadata_album_album_name}`);
    }
  } else if (entry.episode_name) {
    parts.push(entry.episode_name);
    if (entry.episode_show_name) {
      parts.push(`from ${entry.episode_show_name}`);
    }
  } else if (entry.audiobook_chapter_title) {
    parts.push(entry.audiobook_chapter_title);
    if (entry.audiobook_title) {
      parts.push(`from ${entry.audiobook_title}`);
    }
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

function getSourceId(entry: SpotifyStreamingEntry): string | null {
  // Use the URI + timestamp to make unique (same track can be played multiple times)
  const uri = entry.spotify_track_uri || entry.spotify_episode_uri || entry.audiobook_chapter_uri;
  if (uri) {
    return `${uri}@${entry.ts}`;
  }
  // For entries without URI, use timestamp + platform as fallback
  return `${entry.ts}@${entry.platform}`;
}

export async function importSpotifyData(
  db: Database,
  importPath: string,
  sourceAccount: string
) {
  const importBatch = `spotify-${sourceAccount}-${Date.now()}`;

  const people = JSON.stringify(["spotify:" + sourceAccount]);

  const upsert = db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, duration_ms,
      title, content, tags, raw_data, import_batch, people
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id, source_account) DO UPDATE SET
      type = excluded.type,
      timestamp = excluded.timestamp,
      duration_ms = excluded.duration_ms,
      title = excluded.title,
      content = excluded.content,
      tags = excluded.tags,
      raw_data = excluded.raw_data,
      import_batch = excluded.import_batch,
      people = excluded.people
    WHERE excluded.duration_ms IS NOT NULL
  `);

  // Find all JSON files in the streaming history directory
  const streamingDir = join(importPath, "Spotify Extended Streaming History");
  const files = await readdir(streamingDir);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  let totalImported = 0;
  let totalSkipped = 0;

  for (const file of jsonFiles) {
    const filePath = join(streamingDir, file);
    const data: SpotifyStreamingEntry[] = await Bun.file(filePath).json();

    console.log(`Processing ${file}: ${data.length} entries`);

    const insertMany = db.transaction((entries: SpotifyStreamingEntry[]) => {
      for (const entry of entries) {
        // Skip very short plays (< 3 seconds) - usually just previews/skips
        if (entry.ms_played < 3000) {
          totalSkipped++;
          continue;
        }

        const type = determineType(entry);
        const title = getTitle(entry);
        const content = getContent(entry);
        const sourceId = getSourceId(entry);

        // Build tags from metadata
        const tags: string[] = [];
        if (entry.shuffle) tags.push("shuffle");
        if (entry.skipped) tags.push("skipped");
        if (entry.offline) tags.push("offline");
        if (entry.incognito_mode) tags.push("incognito");
        tags.push(entry.platform.split(" ")[0].toLowerCase()); // First word of platform (windows, android, ios, etc.)

        // Add artist/album tags for grouping
        if (entry.master_metadata_album_artist_name) {
          tags.push(`artist:${entry.master_metadata_album_artist_name}`);
        }
        if (entry.master_metadata_album_album_name) {
          tags.push(`album:${entry.master_metadata_album_album_name}`);
        }

        try {
          upsert.run(
            "spotify",
            sourceId,
            sourceAccount,
            type,
            entry.ts,
            entry.ms_played,
            title,
            content,
            JSON.stringify(tags),
            JSON.stringify(entry),
            importBatch,
            people
          );
          totalImported++;
        } catch (e) {
          // Likely a duplicate, skip
          totalSkipped++;
        }
      }
    });

    insertMany(data);
  }

  console.log(`\nImport complete:`);
  console.log(`  Imported: ${totalImported}`);
  console.log(`  Skipped: ${totalSkipped} (duplicates or <3s plays)`);
  console.log(`  Batch ID: ${importBatch}`);

  return totalImported;
}

// CLI
if (import.meta.main) {
  runParser(importSpotifyData, {
    name: "spotify",
    examples: ["bun run src/parsers/spotify.ts ./imports/spotify my-account"],
  });
}
