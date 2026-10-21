#!/usr/bin/env bun
/**
 * Generate Discord sync config for config.toml
 *
 * Reads guild configurations from the discord-chat database and generates
 * TOML config for the new Discord API sync source.
 *
 * Usage: bun run src/scripts/generate-discord-config.ts [discord-chat-db-path]
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const DEFAULT_DISCORD_CHAT_DB = `${process.env.HOME}/.local/share/discord-chat/personal.db`;

interface GuildRow {
  id: string;
  name: string;
  sparse: number;
  skip_discovery: number;
}

function main() {
  const dbPath = process.argv[2] || DEFAULT_DISCORD_CHAT_DB;

  if (!existsSync(dbPath)) {
    console.error(`Discord-chat database not found at: ${dbPath}`);
    console.error(`Usage: bun run src/scripts/generate-discord-config.ts [path-to-personal.db]`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });

  try {
    // Get all guilds with their settings
    const guilds = db
      .query<GuildRow, []>(
        `SELECT id, name, sparse, COALESCE(skip_discovery, 0) as skip_discovery FROM guilds ORDER BY name`
      )
      .all();

    if (guilds.length === 0) {
      console.error("No guilds found in discord-chat database");
      process.exit(1);
    }

    // Generate TOML output
    const lines: string[] = [];
    lines.push(`[sync.discord]`);
    lines.push(`interval = "30m"`);
    lines.push(`# DISCORD_TOKEN env var must be set`);
    lines.push(``);

    for (const guild of guilds) {
      const mode = guild.sparse ? "sparse" : "full";
      const skipDiscovery = guild.skip_discovery ? true : false;

      lines.push(`[sync.discord.guilds.${guild.id}]`);
      lines.push(`name = ${JSON.stringify(guild.name)}`);
      lines.push(`mode = "${mode}"`);
      if (skipDiscovery) {
        lines.push(`skip_discovery = true`);
      }
      lines.push(``);
    }

    console.log(lines.join("\n"));

    // Print summary to stderr
    const fullGuilds = guilds.filter((g) => !g.sparse);
    const sparseGuilds = guilds.filter((g) => g.sparse);
    const skipGuilds = guilds.filter((g) => g.skip_discovery);

    console.error(`\n# Summary:`);
    console.error(`#   ${guilds.length} guilds total`);
    console.error(`#   ${fullGuilds.length} full, ${sparseGuilds.length} sparse`);
    if (skipGuilds.length > 0) {
      console.error(`#   ${skipGuilds.length} with skip_discovery`);
    }
    console.error(`#`);
    console.error(`# Paste the output above into your config.toml`);
  } finally {
    db.close();
  }
}

main();
