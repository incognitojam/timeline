/**
 * The `cube-acr` inbox parser: one Cube ACR recording per file.
 *
 * File-name times are the phone's local time, read in this host's time zone.
 * A recording that has to wait for its call is reported as `waiting`, which
 * leaves the file unprocessed for the next run of its inbox source.
 */
import type { Database } from "../../db/sqlite";
import type { ParserResult } from "../../inbox/process";
import { afconvert, EVENT_SOURCE, importRecordingFile } from "./parser";

export async function processRecordingFile(db: Database, filePath: string, sourceAccount: string | null): Promise<ParserResult> {
  if (!sourceAccount) throw new Error("The cube-acr parser requires 'account' in its inbox source config");
  const outcome = await importRecordingFile(db, filePath, {
    sourceAccount,
    importBatch: `${EVENT_SOURCE}-${sourceAccount}-${Date.now()}`,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    convert: afconvert,
  });
  switch (outcome.status) {
    case "imported":
      return { eventsAdded: 1, detectedType: EVENT_SOURCE };
    case "duplicate":
      return { eventsAdded: 0, detectedType: EVENT_SOURCE, skipReason: `already imported as event ${outcome.eventId}` };
    case "waiting":
      return { eventsAdded: 0, waiting: outcome.reason };
  }
}
