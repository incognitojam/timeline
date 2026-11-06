/**
 * Google Takeout ZIP processing: detects the account and services in a Takeout
 * ZIP and hands each service to its product's parser.
 */

import type { Database } from "bun:sqlite";
import { basename, dirname, join } from "path";
import { cleanupExtract, extractZip, findFiles } from "../../../inbox/zip";
import { detectFromRclone, detectGoogleAccount } from "./account-detection";
import { detectTakeoutServices } from "./services";

/**
 * Options for processing Google Takeout ZIPs
 */
export interface GoogleTakeoutOptions {
  /** rclone remote name (e.g., "gdrive") for fallback account detection */
  rcloneRemote?: string;
}

/**
 * Process a Google Takeout ZIP file
 * Auto-detects account from ZIP contents, with rclone API fallback.
 */
export async function processGoogleTakeoutZip(
  db: Database,
  zipPath: string,
  _sourceAccount: string | null, // Ignored - always auto-detect
  options?: GoogleTakeoutOptions
): Promise<{ eventsAdded: number; eventsUpdated: number }> {
  console.log(`  Extracting: ${basename(zipPath)}`);
  const { tempDir, files } = await extractZip(zipPath);

  try {
    // Try to detect account from ZIP contents first
    let detection = await detectGoogleAccount(tempDir, files);

    // If ZIP detection fails and we have an rclone remote, try Drive API
    if (!detection && options?.rcloneRemote) {
      console.log(`  ZIP detection failed, trying rclone remote: ${options.rcloneRemote}`);
      detection = await detectFromRclone(options.rcloneRemote);
    }

    if (!detection) {
      const services = detectTakeoutServices(files);
      throw new Error(
        `Could not auto-detect Google account from Takeout ZIP.\n` +
          `  Services found: ${services.join(", ") || "none"}\n` +
          `  For auto-detection, include Profile, Google Chat, or Calendar in your Takeout export.\n` +
          `  Or configure an rclone remote to enable Drive API detection.`
      );
    }

    const sourceAccount = detection.account;
    console.log(
      `  Auto-detected account: ${detection.email} (via ${detection.method})`
    );

    const services = detectTakeoutServices(files);
    console.log(`  Detected services: ${services.join(", ") || "none"}`);

    let totalAdded = 0;
    let totalUpdated = 0;

    for (const service of services) {
      const result = await processTakeoutService(
        db,
        tempDir,
        files,
        service,
        sourceAccount
      );
      if (result.eventsAdded > 0 || result.eventsUpdated > 0) {
        const parts = [`+${result.eventsAdded}`];
        if (result.eventsUpdated > 0) parts.push(`~${result.eventsUpdated} updated`);
        console.log(`    ${service}: ${parts.join(", ")} events`);
        totalAdded += result.eventsAdded;
        totalUpdated += result.eventsUpdated;
      }
    }

    return { eventsAdded: totalAdded, eventsUpdated: totalUpdated };
  } finally {
    await cleanupExtract(tempDir);
  }
}

/**
 * Process a specific Takeout service
 */
async function processTakeoutService(
  db: Database,
  tempDir: string,
  files: string[],
  service: string,
  sourceAccount: string
): Promise<{ eventsAdded: number; eventsUpdated: number }> {
  switch (service) {
    case "youtube": {
      // Find the YouTube directory or activity files
      const youtubeDir = files.find(
        (f) =>
          f.toLowerCase().includes("/youtube/") &&
          (f.endsWith(".html") || f.endsWith(".json"))
      );
      if (!youtubeDir) return { eventsAdded: 0, eventsUpdated: 0 };

      // Get the YouTube folder path
      const youtubePath = youtubeDir
        .split("/")
        .slice(0, -1)
        .join("/")
        .replace(/\/history$/, "");

      const { importYouTubeData } = await import("../youtube/parser");
      return { eventsAdded: await importYouTubeData(db, youtubePath, sourceAccount), eventsUpdated: 0 };
    }

    case "chrome": {
      // Find Chrome directory
      const chromeFile = files.find(
        (f) =>
          f.toLowerCase().includes("/chrome/") && f.endsWith("History.json")
      );
      if (!chromeFile) return { eventsAdded: 0, eventsUpdated: 0 };

      const chromePath = dirname(chromeFile);
      const { importChromeHistory } = await import("../chrome/parser");
      return { eventsAdded: await importChromeHistory(db, chromePath, sourceAccount), eventsUpdated: 0 };
    }

    case "search": {
      // Only web Search: My Activity also holds Image Search, Video Search, etc.
      const searchFile = files.find((f) => /\/my activity\/search\/[^/]*\.html$/i.test(f));
      if (!searchFile) return { eventsAdded: 0, eventsUpdated: 0 };

      const { importGoogleSearch } = await import("../search/parser");
      return { eventsAdded: await importGoogleSearch(db, searchFile, sourceAccount), eventsUpdated: 0 };
    }

    case "calendar": {
      // Find calendar directory with .ics files
      const icsFile = files.find((f) => f.endsWith(".ics"));
      if (!icsFile) return { eventsAdded: 0, eventsUpdated: 0 };

      const calendarPath = dirname(icsFile);
      const { importCalendarData } = await import("../calendar/parser");
      return { eventsAdded: await importCalendarData(db, calendarPath, sourceAccount), eventsUpdated: 0 };
    }

    case "keep": {
      // Find Keep directory
      const keepFile = files.find(
        (f) =>
          (f.toLowerCase().includes("/keep/") ||
            f.toLowerCase().includes("/google keep/")) &&
          f.endsWith(".json") &&
          !f.includes("Trash")
      );
      if (!keepFile) return { eventsAdded: 0, eventsUpdated: 0 };

      const keepPath = dirname(keepFile);
      const { importKeepData } = await import("../keep/parser");
      return { eventsAdded: await importKeepData(db, keepPath, sourceAccount), eventsUpdated: 0 };
    }

    case "location": {
      // The parser reads monthly Semantic Location History files, not Records.json.
      const semanticDirEnd = "/semantic location history";
      const semanticFile = files.find((f) => f.toLowerCase().includes(`${semanticDirEnd}/`));
      if (!semanticFile) {
        console.log("    location: no Semantic Location History, skipping");
        return { eventsAdded: 0, eventsUpdated: 0 };
      }

      const semanticPath = semanticFile.slice(
        0,
        semanticFile.toLowerCase().lastIndexOf(`${semanticDirEnd}/`) + semanticDirEnd.length
      );
      const { importSemanticLocationHistory } = await import("../location/parser");
      return { eventsAdded: await importSemanticLocationHistory(db, semanticPath, sourceAccount), eventsUpdated: 0 };
    }

    case "timeline": {
      // Find Timeline.json file
      const timelineFile = files.find((f) =>
        f.toLowerCase().endsWith("timeline.json")
      );
      if (!timelineFile) return { eventsAdded: 0, eventsUpdated: 0 };

      const { importTimelineData } = await import("../location/parser-timeline");
      return await importTimelineData(db, timelineFile, sourceAccount);
    }

    case "chat": {
      // Find Google Chat directory
      const chatFile = files.find(
        (f) =>
          (f.toLowerCase().includes("google chat") ||
            f.toLowerCase().includes("/chat/")) &&
          f.endsWith(".json")
      );
      if (!chatFile) return { eventsAdded: 0, eventsUpdated: 0 };

      // Navigate up to find the Chat root (contains Groups/ and Users/)
      let chatPath = dirname(chatFile);
      while (
        !chatPath.toLowerCase().endsWith("chat") &&
        !chatPath.toLowerCase().endsWith("google chat") &&
        chatPath.includes("/")
      ) {
        chatPath = dirname(chatPath);
      }

      const { importChatData } = await import("../chat/parser");
      return { eventsAdded: await importChatData(db, chatPath, sourceAccount), eventsUpdated: 0 };
    }

    case "fit": {
      const fitFile = files.find((f) => f.toLowerCase().includes("/fit/"));
      if (!fitFile) return { eventsAdded: 0, eventsUpdated: 0 };

      const fitPath = fitFile.slice(0, fitFile.toLowerCase().lastIndexOf("/fit/") + "/fit".length);
      const { importGoogleFit } = await import("../fit/parser");
      return { eventsAdded: await importGoogleFit(db, fitPath, sourceAccount), eventsUpdated: 0 };
    }

    case "fitbit": {
      // Find Fitbit directory
      const fitbitFile = files.find(
        (f) =>
          f.toLowerCase().includes("/fitbit/") &&
          (f.endsWith(".json") || f.endsWith(".csv"))
      );
      if (!fitbitFile) return { eventsAdded: 0, eventsUpdated: 0 };

      // Navigate up to find the Fitbit root
      let fitbitPath = dirname(fitbitFile);
      while (
        !fitbitPath.toLowerCase().endsWith("fitbit") &&
        fitbitPath.includes("/")
      ) {
        fitbitPath = dirname(fitbitPath);
      }

      const { importFitbitData } = await import("../fitbit/parser");
      return { eventsAdded: await importFitbitData(db, fitbitPath), eventsUpdated: 0 };
    }

    default:
      return { eventsAdded: 0, eventsUpdated: 0 };
  }
}
