#!/usr/bin/env bun
/**
 * Bootstrap Discord API sync state
 *
 * Seeds the sync state with all known channel IDs from existing Timeline events,
 * so hidden/closed DMs are included from day one. Also sets up channel cursors
 * from the latest message ID per channel.
 *
 * Usage: bun run src/scripts/bootstrap-discord-state.ts [--dry-run]
 */

import { getDb, initDb } from "../db/schema";
import { getAppStateDb, getSyncState, setSyncState } from "../db/app-state";

interface DiscordApiSyncState {
  userId: string;
  username: string;
  channelCursors: Record<string, string>;
  guildSparseCursors: Record<string, string>;
  threadsDiscoveredGuilds: string[];
  knownDMChannelIds: string[];
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = getDb();
  initDb(db);

  // Get all unique Discord channel IDs from existing events
  const channelRows = db
    .query<{ channel_id: string; channel_type: string }, []>(
      `SELECT DISTINCT
        json_extract(raw_data, '$._channel.id') as channel_id,
        json_extract(raw_data, '$._channel.type') as channel_type
      FROM events
      WHERE source = 'discord'
        AND json_extract(raw_data, '$._channel.id') IS NOT NULL`
    )
    .all();

  // Separate DM/group channels from guild channels
  const dmChannelIds: string[] = [];
  const allChannelIds: string[] = [];

  for (const row of channelRows) {
    if (!row.channel_id) continue;
    allChannelIds.push(row.channel_id);
    if (row.channel_type === "DirectMessage" || row.channel_type === "GroupDirectMessage") {
      dmChannelIds.push(row.channel_id);
    }
  }

  // Get latest message ID per channel for cursor bootstrapping
  const cursorRows = db
    .query<{ channel_id: string; max_source_id: string }, []>(
      `SELECT
        json_extract(raw_data, '$._channel.id') as channel_id,
        MAX(source_id) as max_source_id
      FROM events
      WHERE source = 'discord'
        AND json_extract(raw_data, '$._channel.id') IS NOT NULL
      GROUP BY channel_id`
    )
    .all();

  const channelCursors: Record<string, string> = {};
  for (const row of cursorRows) {
    if (row.channel_id && row.max_source_id) {
      channelCursors[row.channel_id] = row.max_source_id;
    }
  }

  console.log(`Found ${allChannelIds.length} total channels`);
  console.log(`  DM/group channels: ${dmChannelIds.length}`);
  console.log(`  Channel cursors: ${Object.keys(channelCursors).length}`);

  if (dryRun) {
    console.log("\n[dry run] Would set sync state with:");
    console.log(`  knownDMChannelIds: ${dmChannelIds.length}`);
    console.log(`  channelCursors: ${Object.keys(channelCursors).length}`);
    db.close();
    return;
  }

  const appDb = getAppStateDb();
  const existingState = getSyncState<DiscordApiSyncState>(appDb, "discord-api");

  if (existingState) {
    // Merge with existing state
    const mergedDMIds = new Set([...existingState.knownDMChannelIds, ...dmChannelIds]);
    const mergedCursors = { ...channelCursors };

    // Keep existing cursors if they're newer (higher snowflake)
    for (const [channelId, cursor] of Object.entries(existingState.channelCursors)) {
      if (!mergedCursors[channelId] || cursor > mergedCursors[channelId]) {
        mergedCursors[channelId] = cursor;
      }
    }

    existingState.knownDMChannelIds = [...mergedDMIds];
    existingState.channelCursors = mergedCursors;

    setSyncState(appDb, "discord-api", existingState);
    console.log(`\nMerged with existing state:`);
    console.log(`  knownDMChannelIds: ${existingState.knownDMChannelIds.length}`);
    console.log(`  channelCursors: ${Object.keys(existingState.channelCursors).length}`);
  } else {
    // Create new state - userId/username will be set on first sync
    const newState: DiscordApiSyncState = {
      userId: "",
      username: "",
      channelCursors,
      guildSparseCursors: {},
      threadsDiscoveredGuilds: [],
      knownDMChannelIds: dmChannelIds,
    };

    setSyncState(appDb, "discord-api", newState);
    console.log(`\nCreated new sync state`);
    console.log(`  Note: userId and username will be set on first sync`);
  }

  console.log("Done!");
  db.close();
}

main();
