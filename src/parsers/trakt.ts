import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getDb, initDb } from "../db/schema";

interface TraktMovie {
  title: string;
  year: number;
  ids: {
    trakt: number;
    slug: string;
    imdb?: string;
    tmdb?: number;
  };
}

interface TraktShow {
  title: string;
  year: number;
  ids: {
    trakt: number;
    slug: string;
    tvdb?: number;
    imdb?: string;
    tmdb?: number;
  };
}

interface TraktEpisode {
  season: number;
  number: number;
  title: string;
  ids: {
    trakt: number;
    tvdb?: number;
    imdb?: string;
    tmdb?: number;
  };
}

interface TraktHistoryItem {
  id: number;
  watched_at: string;
  action: "watch" | "scrobble" | "checkin";
  type: "movie" | "episode";
  movie?: TraktMovie;
  episode?: TraktEpisode;
  show?: TraktShow;
  progress?: number;
  location?: string;
  duration?: number | null;
}

function formatEpisodeTitle(show: TraktShow, episode: TraktEpisode): string {
  const seasonEp = `S${String(episode.season).padStart(2, "0")}E${String(episode.number).padStart(2, "0")}`;
  return `${show.title} - ${seasonEp}: ${episode.title}`;
}

async function importTraktData(
  db: Database,
  importPath: string,
  sourceAccount: string
) {
  const importBatch = `trakt-${sourceAccount}-${Date.now()}`;

  // Note: Trakt's `location` field is IP-geolocated and frequently wrong, so we
  // don't persist it into `location_name`. The raw value is still preserved in
  // `raw_data` for anyone who wants to inspect it.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      duration_ms, title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalImported = 0;
  let totalSkipped = 0;
  const typeCounts: Record<string, number> = {};

  // Find all history files
  const historyFiles: string[] = [];
  for (let i = 1; i <= 100; i++) {
    const file = Bun.file(join(importPath, "watched", `history-${i}.json`));
    if (await file.exists()) {
      historyFiles.push(join(importPath, "watched", `history-${i}.json`));
    } else {
      break;
    }
  }

  console.log(`Found ${historyFiles.length} history files`);

  const insertMany = db.transaction((items: TraktHistoryItem[]) => {
    for (const item of items) {
      const sourceId = `${item.id}`;
      let eventType: string;
      let title: string;
      let content: string | null = null;
      const tags: string[] = [item.action];

      if (item.type === "movie" && item.movie) {
        eventType = "trakt:movie";
        title = `${item.movie.title} (${item.movie.year})`;
        tags.push("movie");
        if (item.movie.ids.imdb) {
          content = `IMDB: ${item.movie.ids.imdb}`;
        }
      } else if (item.type === "episode" && item.episode && item.show) {
        eventType = "trakt:episode";
        title = formatEpisodeTitle(item.show, item.episode);
        tags.push("tv", `show:${item.show.ids.slug}`);
        content = `${item.show.title}`;
      } else {
        totalSkipped++;
        continue;
      }

      // Duration is in minutes, convert to ms
      const durationMs = item.duration ? item.duration * 60 * 1000 : null;

      try {
        insert.run(
          "trakt",
          sourceId,
          sourceAccount,
          eventType,
          item.watched_at,
          durationMs,
          title,
          content,
          JSON.stringify(tags),
          JSON.stringify(item),
          importBatch
        );
        totalImported++;
        typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
      } catch {
        totalSkipped++;
      }
    }
  });

  for (const filePath of historyFiles) {
    console.log(`Processing: ${filePath}`);
    const items: TraktHistoryItem[] = await Bun.file(filePath).json();
    console.log(`  ${items.length} items`);
    insertMany(items);
  }

  // Get date range
  const dateRange = db
    .query(
      `
    SELECT MIN(timestamp) as min_date, MAX(timestamp) as max_date
    FROM events WHERE source = 'trakt' AND import_batch = ?
  `
    )
    .get(importBatch) as { min_date: string; max_date: string } | null;

  console.log(`\nImport complete:`);
  console.log(`  Total imported: ${totalImported}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`  By type:`, typeCounts);
  if (dateRange?.min_date) {
    console.log(
      `  Date range: ${dateRange.min_date.split("T")[0]} to ${dateRange.max_date.split("T")[0]}`
    );
  }
  console.log(`  Batch ID: ${importBatch}`);
}

// CLI
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("Usage: bun run src/parsers/trakt.ts <import-path> [account-name]");
  console.log("");
  console.log("Import path should be the extracted Trakt export folder containing:");
  console.log("  - watched/history-*.json");
  console.log("");
  console.log("Example: bun run src/parsers/trakt.ts /tmp/trakt-import/example-user example-user");
  process.exit(1);
}

const importPath = args[0];
const accountName = args[1] || "default";

console.log(`Importing Trakt data from ${importPath}`);
console.log(`Account: ${accountName}\n`);

const db = getDb();
initDb(db);

await importTraktData(db, importPath, accountName);

db.close();
