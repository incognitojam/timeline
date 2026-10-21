import { getDb } from "../../db/schema";
import {
  removeFromHistory,
  addToHistory,
  fetchHistoryWindow,
  insertTraktEvent,
  type TraktHistoryAddEpisode,
} from "../../parsers/trakt-api";
import type { Outlier } from "./detect";
import type { InterpolationResult } from "./interpolate";

export interface CorrectionResult {
  success: boolean;
  outlier: Outlier;
  oldTimestamp: string;
  newTimestamp: string;
  error?: string;
}

/**
 * Apply a correction to a single episode:
 * 1. Remove the old history entry from Trakt
 * 2. Add a new entry with the corrected timestamp
 * 3. Delete the old entry from local timeline DB
 * 4. Fetch the new entry from Trakt and insert into local DB
 */
export async function applyCorrection(
  result: InterpolationResult
): Promise<CorrectionResult> {
  const { outlier, suggestedTimestamp } = result;

  if (!suggestedTimestamp) {
    return {
      success: false,
      outlier,
      oldTimestamp: outlier.timestamp,
      newTimestamp: "",
      error: `Cannot correct: ${result.reason}`,
    };
  }

  const historyId = parseInt(outlier.source_id, 10);
  const rawData = JSON.parse(outlier.raw_data);

  // Get episode IDs from raw data
  const episodeIds = rawData.episode?.ids;
  if (!episodeIds) {
    return {
      success: false,
      outlier,
      oldTimestamp: outlier.timestamp,
      newTimestamp: suggestedTimestamp,
      error: "No episode IDs in raw data",
    };
  }

  try {
    // Get source_account before deleting the old entry
    const db = getDb();
    const existingEvent = db.query<{ source_account: string }, [string]>(
      "SELECT source_account FROM events WHERE source = 'trakt' AND source_id = ?"
    ).get(outlier.source_id);
    if (!existingEvent?.source_account) {
      db.close();
      return {
        success: false,
        outlier,
        oldTimestamp: outlier.timestamp,
        newTimestamp: suggestedTimestamp,
        error: `Trakt event ${outlier.source_id} has no source account`,
      };
    }
    const sourceAccount = existingEvent.source_account;

    // Step 1: Remove the old history entry from Trakt
    console.log(`  Removing history entry ${historyId} from Trakt...`);
    const removeResult = await removeFromHistory([historyId]);

    if (removeResult.not_found.ids.length > 0) {
      db.close();
      return {
        success: false,
        outlier,
        oldTimestamp: outlier.timestamp,
        newTimestamp: suggestedTimestamp,
        error: `History entry ${historyId} not found on Trakt`,
      };
    }

    // Step 2: Add new entry with corrected timestamp
    console.log(`  Adding new entry with timestamp ${suggestedTimestamp}...`);
    const addItem: TraktHistoryAddEpisode = {
      ids: episodeIds,
      watched_at: suggestedTimestamp,
    };
    const addResult = await addToHistory({ episodes: [addItem] });

    if (addResult.added.episodes === 0) {
      db.close();
      return {
        success: false,
        outlier,
        oldTimestamp: outlier.timestamp,
        newTimestamp: suggestedTimestamp,
        error: "Failed to add episode to Trakt history",
      };
    }

    // Step 3: Delete old entry from local timeline DB
    console.log(`  Removing old entry from local DB...`);
    db.run(
      "DELETE FROM events WHERE source = 'trakt' AND source_id = ?",
      [outlier.source_id]
    );

    // Step 4: Fetch the new entry from Trakt and insert into local DB
    console.log(`  Fetching new entry from Trakt...`);
    const targetTime = new Date(suggestedTimestamp).getTime();
    const windowMs = 30_000; // 30 second window
    const startAt = new Date(targetTime - windowMs).toISOString();
    const endAt = new Date(targetTime + windowMs).toISOString();

    const entries = await fetchHistoryWindow(startAt, endAt);

    // Find matching entry by episode trakt ID
    const match = entries.find(
      (e) => e.episode?.ids.trakt === episodeIds.trakt
    );

    if (match) {
      const importBatch = `trakt-correct-${Date.now()}`;
      const inserted = insertTraktEvent(db, match, sourceAccount, importBatch);
      if (inserted) {
        console.log(`  Inserted new entry (history ID: ${match.id})`);
      } else {
        console.log(`  Warning: Could not insert new entry (may be duplicate)`);
      }
    } else {
      console.log(
        `  Warning: Could not find new entry on Trakt. Trigger a trakt sync from the /status page to import.`
      );
    }

    db.close();

    return {
      success: true,
      outlier,
      oldTimestamp: outlier.timestamp,
      newTimestamp: suggestedTimestamp,
    };
  } catch (e) {
    return {
      success: false,
      outlier,
      oldTimestamp: outlier.timestamp,
      newTimestamp: suggestedTimestamp,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Apply corrections to multiple episodes.
 */
export async function applyCorrections(
  results: InterpolationResult[]
): Promise<CorrectionResult[]> {
  const correctionResults: CorrectionResult[] = [];

  for (const result of results) {
    const correctionResult = await applyCorrection(result);
    correctionResults.push(correctionResult);
  }

  return correctionResults;
}

export interface DeleteResult {
  success: boolean;
  outlier: Outlier;
  error?: string;
}

/**
 * Delete outlier entries from Trakt (for removing duplicates).
 * Only removes from Trakt and local DB - doesn't add anything back.
 */
export async function deleteFromTrakt(outliers: Outlier[]): Promise<DeleteResult[]> {
  const results: DeleteResult[] = [];

  // Collect all history IDs to delete
  const historyIds = outliers.map((o) => parseInt(o.source_id, 10));

  try {
    console.log(`  Removing ${historyIds.length} entries from Trakt...`);
    const removeResult = await removeFromHistory(historyIds);

    const notFoundIds = new Set(removeResult.not_found.ids);

    // Delete from local DB and record results
    const db = getDb();
    for (const outlier of outliers) {
      const historyId = parseInt(outlier.source_id, 10);

      if (notFoundIds.has(historyId)) {
        results.push({
          success: false,
          outlier,
          error: `History entry ${historyId} not found on Trakt`,
        });
      } else {
        // Delete from local DB
        db.run(
          "DELETE FROM events WHERE source = 'trakt' AND source_id = ?",
          [outlier.source_id]
        );
        results.push({
          success: true,
          outlier,
        });
      }
    }
    db.close();
  } catch (e) {
    // If the API call failed, mark all as failed
    for (const outlier of outliers) {
      results.push({
        success: false,
        outlier,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return results;
}
