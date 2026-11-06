/**
 * Conversations whose events stay in `events` (raw data is never deleted)
 * but which conversation lists leave out:
 *
 * - `orchestrated`: the provider-native transcript (Claude Code session,
 *   Codex rollout, ...) of an agent session that an orchestrator drove. The
 *   orchestrator's thread (`canonical_*`, e.g. a T3 Code thread) is the
 *   canonical record and links back to it through raw_data.
 * - `title_generation`: a throwaway agent session an orchestrator spawned
 *   only to name a thread.
 *
 * Rows are scoped to an account: an orchestrator thread only supersedes
 * transcripts imported under its own account, i.e. from the same machine
 * (accounts name a host: "alice", "alice@laptop"). A session copied to
 * another machine and resumed there keeps its native id but diverges.
 */
import type { Database } from "bun:sqlite";
import { conversationSourceAccountKey } from "./schema";

export type SupersededConversation =
  | {
      source: string;
      sourceAccount: string;
      conversationId: string;
      reason: "orchestrated";
      canonical: { source: string; sourceAccount: string; conversationId: string };
    }
  | { source: string; sourceAccount: string; conversationId: string; reason: "title_generation" };

/**
 * The rows that differ from what's stored, keeping the last row for each
 * conversation as writing them all in order would. Read-only, so it needs no
 * write lock.
 */
export function changedSupersededConversations(db: Database, rows: SupersededConversation[]): SupersededConversation[] {
  const stored = db.prepare(`
    SELECT 1 FROM superseded_conversations
    WHERE source = ? AND source_account = ? AND conversation_id = ? AND reason = ?
      AND canonical_source IS ? AND canonical_source_account IS ? AND canonical_conversation_id IS ?
  `);
  const lastByKey = new Map(
    rows.map((row) => [JSON.stringify([row.source, row.sourceAccount, row.conversationId]), row])
  );
  return [...lastByKey.values()].filter((row) => {
    const canonical = row.reason === "orchestrated" ? row.canonical : null;
    return !stored.get(
      row.source, row.sourceAccount, row.conversationId, row.reason,
      canonical?.source ?? null, canonical?.sourceAccount ?? null, canonical?.conversationId ?? null,
    );
  });
}

export function markConversationsSuperseded(db: Database, rows: SupersededConversation[]): void {
  const upsert = db.prepare(`
    INSERT INTO superseded_conversations (
      source, source_account, conversation_id, reason,
      canonical_source, canonical_source_account, canonical_conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_account, conversation_id) DO UPDATE SET
      reason = excluded.reason,
      canonical_source = excluded.canonical_source,
      canonical_source_account = excluded.canonical_source_account,
      canonical_conversation_id = excluded.canonical_conversation_id,
      updated_at = datetime('now')
  `);
  db.transaction(() => {
    for (const row of rows) {
      const canonical = row.reason === "orchestrated" ? row.canonical : null;
      upsert.run(
        row.source,
        row.sourceAccount,
        row.conversationId,
        row.reason,
        canonical?.source ?? null,
        canonical?.sourceAccount ?? null,
        canonical?.conversationId ?? null,
      );
    }
  })();
}

/**
 * SQL condition excluding superseded conversations. `table` names the outer
 * row (e.g. "events", "cs"); it is required because a bare column inside
 * the subquery would resolve to superseded_conversations itself. An
 * orchestrated transcript stays hidden only while its canonical conversation
 * exists, so removing a thread's events brings the transcript back.
 */
export function notSupersededClause(table: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM superseded_conversations sc
    WHERE sc.source = ${table}.source
      AND sc.source_account = ${table}.source_account
      AND sc.conversation_id = ${table}.conversation_id
      AND (
        sc.reason = 'title_generation'
        OR EXISTS (
          SELECT 1 FROM conversation_summaries canonical
          WHERE canonical.source = sc.canonical_source
            AND canonical.source_account_key = '${conversationSourceAccountKey("")}' || sc.canonical_source_account
            AND canonical.conversation_id = sc.canonical_conversation_id
        )
      )
  )`;
}
