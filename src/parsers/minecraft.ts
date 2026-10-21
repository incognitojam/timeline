import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import { onImportComplete } from "../db/queries";
import { Glob } from "bun";
import { gunzipSync } from "zlib";
import { basename } from "path";

interface Stats {
  files: number;
  joins: number;
  leaves: number;
  chats: number;
  advancements: number;
  deaths: number;
  skipped: number;
}

// Parse log line timestamp - handles multiple formats
// Paper: [15:36:46] with date from filename
// Forge: [27Oct2024 14:21:47.734]
function parseTimestamp(
  line: string,
  filenameDate: Date | null
): { timestamp: Date; rest: string } | null {
  // Try Forge format first: [DDMonYYYY HH:MM:SS.mmm]
  const forgeMatch = line.match(
    /^\[(\d{2})([A-Z][a-z]{2})(\d{4}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/
  );
  if (forgeMatch) {
    const [, day, monthStr, year, hour, min, sec, ms] = forgeMatch;
    const months: Record<string, number> = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
    };
    const month = months[monthStr];
    if (month !== undefined) {
      const timestamp = new Date(
        parseInt(year),
        month,
        parseInt(day),
        parseInt(hour),
        parseInt(min),
        parseInt(sec),
        parseInt(ms)
      );
      const rest = line.slice(forgeMatch[0].length).trim();
      return { timestamp, rest };
    }
  }

  // Try Paper format: [HH:MM:SS] - requires date from filename
  const paperMatch = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/);
  if (paperMatch && filenameDate) {
    const [, hour, min, sec] = paperMatch;
    const timestamp = new Date(filenameDate);
    timestamp.setHours(parseInt(hour), parseInt(min), parseInt(sec), 0);
    const rest = line.slice(paperMatch[0].length).trim();
    return { timestamp, rest };
  }

  return null;
}

// Extract date from filename like 2024-07-27-3.log.gz
function parseDateFromFilename(filename: string): Date | null {
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
  }
  return null;
}

// Parse the rest of the log line to extract event info
function parseLogEvent(rest: string): {
  type: string;
  player: string | null;
  content: string;
  advancement?: string;
} | null {
  // Remove thread/level prefix: [Server thread/INFO]: or [Async Chat Thread - #1/INFO]:
  const prefixMatch = rest.match(/^\[([^\]]+)\](?:\s*\[[^\]]+\])?:\s*/);
  if (!prefixMatch) return null;

  const message = rest.slice(prefixMatch[0].length);

  // Chat message: <player> message
  const chatMatch = message.match(/^<([^>]+)>\s*(.*)$/);
  if (chatMatch) {
    return {
      type: "minecraft:chat",
      player: chatMatch[1],
      content: chatMatch[2],
    };
  }

  // Join: player joined the game
  const joinMatch = message.match(/^(\S+) joined the game$/);
  if (joinMatch) {
    return {
      type: "minecraft:join",
      player: joinMatch[1],
      content: `${joinMatch[1]} joined the game`,
    };
  }

  // Leave: player left the game
  const leaveMatch = message.match(/^(\S+) left the game$/);
  if (leaveMatch) {
    return {
      type: "minecraft:leave",
      player: leaveMatch[1],
      content: `${leaveMatch[1]} left the game`,
    };
  }

  // Advancement: player has made the advancement [Name]
  const advMatch = message.match(/^(\S+) has made the advancement \[(.+)\]$/);
  if (advMatch) {
    return {
      type: "minecraft:advancement",
      player: advMatch[1],
      content: `${advMatch[1]} earned advancement: ${advMatch[2]}`,
      advancement: advMatch[2],
    };
  }

  // Challenge: player has completed the challenge [Name]
  const challengeMatch = message.match(/^(\S+) has completed the challenge \[(.+)\]$/);
  if (challengeMatch) {
    return {
      type: "minecraft:advancement",
      player: challengeMatch[1],
      content: `${challengeMatch[1]} completed challenge: ${challengeMatch[2]}`,
      advancement: challengeMatch[2],
    };
  }

  // Death messages - various patterns
  const deathPatterns = [
    /^(\S+) was slain by (.+)$/,
    /^(\S+) was shot by (.+)$/,
    /^(\S+) was killed by (.+)$/,
    /^(\S+) drowned$/,
    /^(\S+) experienced kinetic energy$/,
    /^(\S+) hit the ground too hard$/,
    /^(\S+) fell from a high place$/,
    /^(\S+) fell out of the world$/,
    /^(\S+) went up in flames$/,
    /^(\S+) burned to death$/,
    /^(\S+) tried to swim in lava$/,
    /^(\S+) suffocated in a wall$/,
    /^(\S+) starved to death$/,
    /^(\S+) was pricked to death$/,
    /^(\S+) blew up$/,
    /^(\S+) was blown up by (.+)$/,
    /^(\S+) withered away$/,
    /^(\S+) was squashed by (.+)$/,
  ];

  for (const pattern of deathPatterns) {
    const deathMatch = message.match(pattern);
    if (deathMatch) {
      return {
        type: "minecraft:death",
        player: deathMatch[1],
        content: message,
      };
    }
  }

  return null;
}

async function importMinecraftLogs(
  db: Database,
  logsDir: string,
  serverName: string,
  sourceAccount: string
) {
  const importBatch = `minecraft-${serverName}-${Date.now()}`;

  const stats: Stats = {
    files: 0,
    joins: 0,
    leaves: 0,
    chats: 0,
    advancements: 0,
    deaths: 0,
    skipped: 0,
  };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Find all log files (both .log and .log.gz)
  const glob = new Glob("**/*.log{,.gz}");
  const files: string[] = [];

  for await (const file of glob.scan(logsDir)) {
    files.push(file);
  }

  // Sort files by name (chronological)
  files.sort();

  console.log(`Found ${files.length} log files in ${logsDir}`);

  for (const relPath of files) {
    const fullPath = `${logsDir}/${relPath}`;
    const filename = basename(relPath);

    // Skip latest.log as it's a duplicate of the most recent dated log
    if (filename === "latest.log") continue;

    stats.files++;

    // Get date from filename
    const filenameDate = parseDateFromFilename(filename);

    // Read file content
    let content: string;
    try {
      const fileData = await Bun.file(fullPath).arrayBuffer();
      if (filename.endsWith(".gz")) {
        content = gunzipSync(Buffer.from(fileData)).toString("utf-8");
      } else {
        content = new TextDecoder().decode(fileData);
      }
    } catch (e) {
      console.error(`  Failed to read ${filename}: ${e}`);
      continue;
    }

    const lines = content.split("\n");
    let fileEvents = 0;

    for (const line of lines) {
      const parsed = parseTimestamp(line, filenameDate);
      if (!parsed) continue;

      const event = parseLogEvent(parsed.rest);
      if (!event) continue;

      // Generate unique ID from timestamp + player + type
      const sourceId = `${serverName}-${parsed.timestamp.getTime()}-${event.player}-${event.type}`;

      const title = serverName;
      const tags = event.advancement ? JSON.stringify([event.advancement]) : null;

      const result = insert.run(
        "minecraft",
        sourceId,
        sourceAccount,
        event.type,
        parsed.timestamp.toISOString(),
        title,
        event.content,
        event.player ? JSON.stringify([event.player]) : null,
        tags,
        JSON.stringify({ server: serverName, raw: line }),
        importBatch
      );

      if (result.changes > 0) {
        fileEvents++;
        switch (event.type) {
          case "minecraft:join": stats.joins++; break;
          case "minecraft:leave": stats.leaves++; break;
          case "minecraft:chat": stats.chats++; break;
          case "minecraft:advancement": stats.advancements++; break;
          case "minecraft:death": stats.deaths++; break;
        }
      } else {
        stats.skipped++;
      }
    }

    if (fileEvents > 0) {
      console.log(`  ${filename}: ${fileEvents} events`);
    }
  }

  // Print summary
  console.log(`\n${"=".repeat(50)}`);
  console.log("Import complete:");
  console.log(`  Files processed: ${stats.files}`);
  console.log(`  Joins: ${stats.joins}`);
  console.log(`  Leaves: ${stats.leaves}`);
  console.log(`  Chat messages: ${stats.chats}`);
  console.log(`  Advancements: ${stats.advancements}`);
  console.log(`  Deaths: ${stats.deaths}`);
  console.log(`  Skipped (duplicates): ${stats.skipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  onImportComplete(db);
}

// CLI
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log(
    "Usage: bun run src/parsers/minecraft.ts <logs-directory> <server-name> [account-name]"
  );
  console.log("");
  console.log(
    "Imports Minecraft server logs (chat, joins, leaves, deaths, advancements) into timeline."
  );
  console.log("");
  console.log("Examples:");
  console.log(
    "  bun run src/parsers/minecraft.ts ./minecraft-server/logs my-server my-account"
  );
  console.log(
    "  bun run src/parsers/minecraft.ts /mnt/pool/games/minecraft/paper-1.21/logs paper-1.21"
  );
  console.log("");
  console.log("Supports both Paper (.log.gz with date in filename) and Forge (date in log line) formats.");
  process.exit(1);
}

const logsDir = args[0];
const serverName = args[1];
const accountName = args[2] || "default";

console.log(`Importing Minecraft logs from ${logsDir}`);
console.log(`Server: ${serverName}`);
console.log(`Account: ${accountName}\n`);

const db = getDb();
initDb(db);

await importMinecraftLogs(db, logsDir, serverName, accountName);

db.close();
