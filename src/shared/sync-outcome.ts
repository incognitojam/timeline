import { isRecord } from "./guards";

/**
 * A skipped run that made requests (`metadata.requests`) ran and found nothing
 * new, such as a quiet Discord DM pass; any other skip was deferred without
 * running. Both are recorded as skips so quiet runs fold hourly (see
 * recordSkippedSync). `metadata` is a SyncResult's object or a sync_log row's JSON.
 */
export function foundNothingNew(skipped: boolean | number, metadata: unknown): boolean {
  if (!skipped) return false;
  let parsed = metadata;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return false;
    }
  }
  return isRecord(parsed) && typeof parsed.requests === "number" && parsed.requests > 0;
}

/** foundNothingNew for a sync_log row, as SQL that is never NULL. */
export const FOUND_NOTHING_NEW_SQL =
  "(skipped = 1 AND COALESCE(CASE WHEN json_valid(metadata) AND json_type(metadata, '$.requests') IN ('integer', 'real') THEN json_extract(metadata, '$.requests') END > 0, 0))";
