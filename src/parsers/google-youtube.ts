import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getDb, initDb, type Platform } from "../db/schema";
import {
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";

interface YouTubeActivity {
  type: "watch" | "search" | "like" | "subscribe" | "view" | "comment";
  title: string;
  url: string;
  channel?: string;
  channelUrl?: string;
  timestamp: string;
  videoId?: string;
}

function parseTimestamp(dateStr: string): string | null {
  // Format: "22 Dec 2025, 15:32:54 GMT" or "10 Jun 2018, 13:19:35 BST"
  try {
    // Convert BST/UTC to GMT for parsing
    let normalized = dateStr.replace(" BST", " GMT+0100").replace(" UTC", " GMT");
    const date = new Date(normalized);
    if (!isNaN(date.getTime())) {
      return date.toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

function extractVideoId(url: string): string | null {
  const match = url.match(/[?&]v=([^&]+)/) || url.match(/youtu\.be\/([^?]+)/);
  return match ? match[1] : null;
}

/**
 * Extract channel identifier from a channel URL.
 * Returns { platform, platformId } for identity upsert.
 *
 * Priority:
 * 1. /channel/<id> -> youtube:<id>
 * 2. /@handle -> youtube:handle:<handle>
 * 3. /c/<custom> or /user/<username> -> youtube:handle:<custom|username>
 */
function extractChannelIdentifier(channelUrl: string): { platform: Platform; platformId: string } | null {
  if (!channelUrl) return null;

  // /channel/<channelId> - the authoritative format
  const channelIdMatch = channelUrl.match(/\/channel\/([A-Za-z0-9_-]+)/);
  if (channelIdMatch) {
    return { platform: "youtube", platformId: channelIdMatch[1] };
  }

  // /@handle - modern handle format
  const handleMatch = channelUrl.match(/\/@([A-Za-z0-9_.-]+)/);
  if (handleMatch) {
    return { platform: "youtube", platformId: `handle:${handleMatch[1]}` };
  }

  // /c/<custom> - legacy custom URL format
  const customMatch = channelUrl.match(/\/c\/([A-Za-z0-9_.-]+)/);
  if (customMatch) {
    return { platform: "youtube", platformId: `handle:${customMatch[1]}` };
  }

  // /user/<username> - very old username format
  const userMatch = channelUrl.match(/\/user\/([A-Za-z0-9_.-]+)/);
  if (userMatch) {
    return { platform: "youtube", platformId: `handle:${userMatch[1]}` };
  }

  return null;
}

/**
 * Build channel identifier and identity for an activity.
 * Returns the qualified identifier string and identity to upsert.
 */
function buildChannelIdentity(
  channel: string | undefined,
  channelUrl: string | undefined,
  channelId?: string // Direct channel ID from subscriptions CSV
): { identifier: string; identity: UpsertIdentityOptions } | null {
  // If we have a direct channel ID (from subscriptions CSV), use it
  if (channelId) {
    return {
      identifier: formatIdentifier("youtube", channelId),
      identity: {
        platform: "youtube",
        platformId: channelId,
        displayName: channel || undefined,
      },
    };
  }

  // Try to extract from URL
  if (channelUrl) {
    const extracted = extractChannelIdentifier(channelUrl);
    if (extracted) {
      return {
        identifier: formatIdentifier(extracted.platform, extracted.platformId),
        identity: {
          platform: extracted.platform,
          platformId: extracted.platformId,
          displayName: channel || undefined,
        },
      };
    }
  }

  // Fallback to name-based identifier (last resort)
  if (channel) {
    return {
      identifier: formatIdentifier("youtube", `name:${channel}`),
      identity: {
        platform: "youtube",
        platformId: `name:${channel}`,
        displayName: channel,
      },
    };
  }

  return null;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, code) => {
      const num = Number(code);
      return num >= 0 && num <= 0x10ffff ? String.fromCodePoint(num) : match;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (match, code) => {
      const num = parseInt(code, 16);
      return num >= 0 && num <= 0x10ffff ? String.fromCodePoint(num) : match;
    })
    .replace(/&amp;/g, "&");
}

function parseYouTubeActivityHtml(html: string): YouTubeActivity[] {
  const activities: YouTubeActivity[] = [];

  // Match content cells containing activity data
  const contentCellRegex = /<div class="content-cell[^"]*mdl-typography--body-1">([\s\S]*?)<\/div>/g;

  let match;
  while ((match = contentCellRegex.exec(html)) !== null) {
    // Normalize non-breaking spaces (U+00A0) to regular spaces
    const content = match[1].replace(/\u00A0/g, " ");

    // Skip non-activity cells
    if (!content.trim() || content.includes("Products:") || content.includes("Why is this here?")) {
      continue;
    }

    // Extract timestamp - various formats:
    // "Mar 22, 2024, 12:10:16 PM GMT" or "22 Dec 2025, 15:32:54 GMT" or "27 Feb 2021, 22:24:57 BST"
    const timestampMatch = content.match(
      /(\w+\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?\s*(?:GMT|BST|UTC)|\d{1,2}\s+\w+\s+\d{4},\s+\d{1,2}:\d{2}:\d{2}\s+(?:GMT|BST|UTC))/
    );
    if (!timestampMatch) continue;

    const timestamp = parseTimestamp(timestampMatch[1]);
    if (!timestamp) continue;

    // Parse activity based on action word (handle both "Watched " and "Watched\n" formats)
    const trimmedContent = content.trim();
    if (trimmedContent.startsWith("Watched")) {
      // Match both "Watched <a" and "Watched\n<a" formats
      const urlMatch = content.match(/Watched[\s\n]*<a href="([^"]+)">([^<]*)<\/a>/);
      if (urlMatch) {
        const channelMatch = content.match(/<\/a><br><a href="(https:\/\/www\.youtube\.com\/channel\/[^"]+)">([^<]*)<\/a>/);
        activities.push({
          type: "watch",
          title: decodeHtmlEntities(urlMatch[2]),
          url: urlMatch[1],
          channel: channelMatch ? decodeHtmlEntities(channelMatch[2]) : undefined,
          channelUrl: channelMatch ? channelMatch[1] : undefined,
          timestamp,
          videoId: extractVideoId(urlMatch[1]) || undefined,
        });
      }
    } else if (trimmedContent.startsWith("Searched for")) {
      const searchMatch = content.match(/Searched for[\s\n]*<a href="([^"]+)">([^<]*)<\/a>/);
      if (searchMatch) {
        activities.push({
          type: "search",
          title: decodeHtmlEntities(searchMatch[2]),
          url: searchMatch[1],
          timestamp,
        });
      }
    } else if (trimmedContent.startsWith("Liked")) {
      const likeMatch = content.match(/Liked[\s\n]*<a href="([^"]+)">([^<]*)<\/a>/);
      if (likeMatch) {
        const channelMatch = content.match(/<\/a><br><a href="(https:\/\/www\.youtube\.com\/channel\/[^"]+)">([^<]*)<\/a>/);
        activities.push({
          type: "like",
          title: decodeHtmlEntities(likeMatch[2]),
          url: likeMatch[1],
          channel: channelMatch ? decodeHtmlEntities(channelMatch[2]) : undefined,
          channelUrl: channelMatch ? channelMatch[1] : undefined,
          timestamp,
          videoId: extractVideoId(likeMatch[1]) || undefined,
        });
      }
    } else if (trimmedContent.startsWith("Subscribed to")) {
      const subMatch = content.match(/Subscribed to[\s\n]*<a href="([^"]+)">([^<]*)<\/a>/);
      if (subMatch) {
        activities.push({
          type: "subscribe",
          title: decodeHtmlEntities(subMatch[2]),
          url: subMatch[1],
          channel: decodeHtmlEntities(subMatch[2]),
          channelUrl: subMatch[1],
          timestamp,
        });
      }
    } else if (trimmedContent.startsWith("Viewed")) {
      const viewMatch = content.match(/Viewed[\s\n]*<a href="([^"]+)">([^<]*)<\/a>/);
      if (viewMatch) {
        const channelMatch = content.match(/<\/a><br><a href="(https:\/\/www\.youtube\.com\/channel\/[^"]+)">([^<]*)<\/a>/);
        activities.push({
          type: "view",
          title: decodeHtmlEntities(viewMatch[2].substring(0, 200)),
          url: viewMatch[1],
          channel: channelMatch ? decodeHtmlEntities(channelMatch[2]) : undefined,
          channelUrl: channelMatch ? channelMatch[1] : undefined,
          timestamp,
        });
      }
    }
  }

  return activities;
}

function getTags(activity: YouTubeActivity): string[] {
  const tags: string[] = [activity.type];
  if (activity.videoId) tags.push("video");
  if (activity.channel) tags.push("has-channel");
  return tags;
}

export async function importYouTubeData(
  db: Database,
  importPath: string,
  sourceAccount: string
) {
  const importBatch = `youtube-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalImported = 0;
  let totalSkipped = 0;
  const typeCounts: Record<string, number> = {};

  // Collect all identities for batch upsert (keyed by identifier to deduplicate)
  const allIdentities = new Map<string, UpsertIdentityOptions>();

  // Look for activity HTML files in various locations (old and new export formats)
  const activityFiles = [
    // Old format: My Activity.html (with or without space)
    join(importPath, "My Activity.html"),
    join(importPath, "MyActivity.html"),
    join(importPath, "YouTube", "My Activity.html"),
    join(importPath, "YouTube", "MyActivity.html"),
    join(importPath, "My Activity", "YouTube", "My Activity.html"),
    join(importPath, "My Activity", "YouTube", "MyActivity.html"),
    // New format: separate watch-history.html and search-history.html
    join(importPath, "history", "watch-history.html"),
    join(importPath, "history", "search-history.html"),
  ];

  for (const filePath of activityFiles) {
    const file = Bun.file(filePath);
    if (!(await file.exists())) continue;

    console.log(`Processing: ${filePath}`);
    const html = await file.text();
    const activities = parseYouTubeActivityHtml(html);

    console.log(`Found ${activities.length} activities`);

    const insertMany = db.transaction((items: YouTubeActivity[]) => {
      for (const activity of items) {
        const sourceId = `${activity.type}-${activity.url}-${activity.timestamp}`;
        const eventType = `youtube:${activity.type}`;
        const tags = getTags(activity);

        // Build qualified identifier and identity from channel info
        const channelIdentity = buildChannelIdentity(activity.channel, activity.channelUrl);
        const people = channelIdentity ? [channelIdentity.identifier] : null;

        // Collect identity for batch upsert
        if (channelIdentity) {
          allIdentities.set(channelIdentity.identifier, channelIdentity.identity);
        }

        try {
          insert.run(
            "youtube",
            sourceId,
            sourceAccount,
            eventType,
            activity.timestamp,
            activity.title,
            activity.channel || null,
            people ? JSON.stringify(people) : null,
            JSON.stringify(tags),
            JSON.stringify(activity),
            importBatch
          );
          totalImported++;
          typeCounts[activity.type] = (typeCounts[activity.type] || 0) + 1;
        } catch {
          totalSkipped++;
        }
      }
    });

    insertMany(activities);
  }

  // Also import subscriptions CSV if available
  const subscriptionsFile = Bun.file(join(importPath, "subscriptions", "subscriptions.csv"));
  if (await subscriptionsFile.exists()) {
    console.log(`Processing subscriptions CSV`);
    const csv = await subscriptionsFile.text();
    const lines = csv.split("\n").slice(1); // Skip header

    for (const line of lines) {
      if (!line.trim()) continue;

      // CSV format: Channel ID,Channel URL,Channel title
      const match = line.match(/^([^,]+),([^,]+),(.+)$/);
      if (!match) continue;

      const [, channelId, channelUrl, channelTitle] = match;

      // Build qualified identifier using direct channel ID from CSV
      const channelIdentity = buildChannelIdentity(channelTitle, channelUrl, channelId);
      const people = channelIdentity ? [channelIdentity.identifier] : null;

      // Collect identity for batch upsert
      if (channelIdentity) {
        allIdentities.set(channelIdentity.identifier, channelIdentity.identity);
      }

      try {
        insert.run(
          "youtube",
          `subscription-${channelId}`,
          sourceAccount,
          "youtube:subscription",
          null, // No timestamp for current subscriptions
          channelTitle,
          null,
          people ? JSON.stringify(people) : null,
          JSON.stringify(["subscription", "channel"]),
          JSON.stringify({ channelId, channelUrl, channelTitle }),
          importBatch
        );
        totalImported++;
        typeCounts["subscription-csv"] = (typeCounts["subscription-csv"] || 0) + 1;
      } catch {
        totalSkipped++;
      }
    }
  }

  // Batch upsert all collected identities
  if (allIdentities.size > 0) {
    upsertIdentities(db, [...allIdentities.values()]);
  }

  console.log(`\nImport complete:`);
  console.log(`  Total imported: ${totalImported}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`  Identities: ${allIdentities.size}`);
  console.log(`  By type:`, typeCounts);
  console.log(`  Batch ID: ${importBatch}`);

  return totalImported;
}

// CLI
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("Usage: bun run src/parsers/google-youtube.ts <import-path> [account-name]");
  console.log("");
  console.log("Import path should contain:");
  console.log("  - My Activity.html or My Activity/YouTube/My Activity.html");
  console.log("  - subscriptions/subscriptions.csv (optional)");
  console.log("");
  console.log("Example: bun run src/parsers/google-youtube.ts ./imports/youtube my-account");
  process.exit(1);
}

const importPath = args[0];
const accountName = args[1] || "default";

const db = getDb();
initDb(db);

await importYouTubeData(db, importPath, accountName);

db.close();
