import { Database } from "bun:sqlite";
import { initDb } from "./schema";

const CONVERSATION_SUMMARY_TRIGGERS = [
  "conversation_summaries_ai",
  "conversation_summaries_ad",
  "conversation_summaries_au",
];

/**
 * Run a bulk write against `events` with the per-row conversation-summary
 * triggers dropped, then rebuild the summaries once at the end.
 *
 * The AFTER UPDATE trigger recomputes the updated row's whole conversation
 * group, so trigger cost grows with group size × rows written and becomes
 * quadratic for bulk operations. Rebuilding once after the write avoids that
 * cost.
 *
 * Emptying the summary tables doubles as a durable crash marker: initDb()
 * recreates missing triggers and rebuilds the summaries whenever these
 * tables are empty, so an interrupted run self-heals on the next service
 * start or script run instead of leaving triggers dropped and summaries
 * stale. Trade-off: summaries read as empty for the duration of the run.
 */
export async function withBulkSummaryRebuild<T>(
  db: Database,
  fn: () => T | Promise<T>
): Promise<T> {
  for (const trigger of CONVERSATION_SUMMARY_TRIGGERS) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  db.exec(`DELETE FROM conversation_summary_titles`);
  db.exec(`DELETE FROM conversation_summaries`);
  try {
    return await fn();
  } finally {
    initDb(db);
  }
}
