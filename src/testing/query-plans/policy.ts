// History, per-event fanout, unbounded caches, and retained operational history.
// Configuration tables (one row per source/setting) are deliberately absent.
const FTS_TABLES = ["events_fts", "events_fts_stemmed"];

export const LARGE_TABLES = new Set([
  "events", "event_versions", "event_people", "attachments", "attachment_descriptions",
  ...FTS_TABLES.flatMap(table => [table, ...["data", "idx", "docsize"].map(suffix => `${table}_${suffix}`)]),
  "file_import_checkpoints", "conversation_summaries", "conversation_summary_titles",
  "superseded_conversations", "coding_agent_conversations", "event_day_sources",
  "contacts", "contact_aliases", "contact_memories", "identities", "places",
  "skipped_aliases", "contact_match_suggestions", "cache", "discord_emojis", "discord_guild_emojis",
  "discord_guilds", "discord_reaction_observations", "discord_attachment_retry_pending",
  "spotify_playlist_observations", "spotify_playlist_meta", "spotify_resources",
  "day_summaries", "journal_sessions", "sync_log", "processed_files", "jobs",
  "mcp_sessions", "mcp_tool_calls", "eval_cases", "eval_queries", "eval_expectations",
]);

export const SMALL_TABLES: Record<string, string> = {
  render_sweep_state: "One row per render-sweep source.",
  file_import_epochs: "One row per importing source/account.",
  sync_sources: "One row per registered sync source.",
  app_settings: "One row per application setting.",
  scheduler_state: "One row per scheduled source.",
  sync_state: "One row per sync source.",
  ...Object.fromEntries(FTS_TABLES.map(table => [`${table}_config`, "FTS configuration, not document history."])),
};

export function validateTablePolicy(tables: Set<string>): void {
  for (const name of LARGE_TABLES) {
    if (Object.hasOwn(SMALL_TABLES, name)) throw new Error(`Table ${name} is classified as both large and small`);
  }
  for (const name of [...LARGE_TABLES, ...Object.keys(SMALL_TABLES)]) {
    if (!tables.has(name)) throw new Error(`Remove missing table ${name} from query-plans/policy.ts`);
  }
  for (const name of tables) {
    if (!LARGE_TABLES.has(name) && !(Object.hasOwn(SMALL_TABLES, name))) throw new Error(`Classify new table ${name} in query-plans/policy.ts`);
  }
}
