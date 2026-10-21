/**
 * ZIP File Handlers
 *
 * Processes different types of ZIP exports (Google Takeout, Spotify, etc.)
 */

import { Database } from "bun:sqlite";
import { basename, join, dirname } from "path";
import {
  extractZip,
  cleanupExtract,
  detectZipContent,
  detectTakeoutServices,
  findFiles,
  type ZipContentType,
} from "./zip";
import { detectGoogleAccount, detectFromRclone } from "./account-detection";

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

      const { importYouTubeData } = await import("../parsers/google-youtube");
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
      const { importChromeHistory } = await import("../parsers/google-chrome");
      return { eventsAdded: await importChromeHistory(db, chromePath, sourceAccount), eventsUpdated: 0 };
    }

    case "search": {
      // Find Search activity directory
      const searchFile = files.find(
        (f) =>
          f.toLowerCase().includes("my activity") &&
          f.toLowerCase().includes("search") &&
          f.endsWith(".html")
      );
      if (!searchFile) return { eventsAdded: 0, eventsUpdated: 0 };

      const searchPath = dirname(searchFile);
      const { importGoogleSearch } = await import("../parsers/google-search");
      return { eventsAdded: await importGoogleSearch(db, searchPath, sourceAccount), eventsUpdated: 0 };
    }

    case "calendar": {
      // Find calendar directory with .ics files
      const icsFile = files.find((f) => f.endsWith(".ics"));
      if (!icsFile) return { eventsAdded: 0, eventsUpdated: 0 };

      const calendarPath = dirname(icsFile);
      const { importCalendarData } = await import("../parsers/google-calendar");
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
      const { importKeepData } = await import("../parsers/google-keep");
      return { eventsAdded: await importKeepData(db, keepPath, sourceAccount), eventsUpdated: 0 };
    }

    case "location": {
      // Find Location History directory
      const recordsFile = files.find(
        (f) =>
          f.toLowerCase().includes("location history") &&
          f.toLowerCase().includes("records.json")
      );
      if (!recordsFile) return { eventsAdded: 0, eventsUpdated: 0 };

      const locationPath = dirname(recordsFile);
      const { importGoogleLocation } = await import(
        "../parsers/google-location"
      );
      return { eventsAdded: await importGoogleLocation(db, locationPath, sourceAccount), eventsUpdated: 0 };
    }

    case "timeline": {
      // Find Timeline.json file
      const timelineFile = files.find((f) =>
        f.toLowerCase().endsWith("timeline.json")
      );
      if (!timelineFile) return { eventsAdded: 0, eventsUpdated: 0 };

      const { importTimelineData } = await import("../parsers/google-timeline");
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

      const { importChatData } = await import("../parsers/google-chat");
      return { eventsAdded: await importChatData(db, chatPath, sourceAccount), eventsUpdated: 0 };
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

      const { importFitbitData } = await import("../parsers/fitbit");
      return { eventsAdded: await importFitbitData(db, fitbitPath), eventsUpdated: 0 };
    }

    default:
      return { eventsAdded: 0, eventsUpdated: 0 };
  }
}

/**
 * Parser result with detected type
 */
interface AutoDetectResult {
  eventsAdded: number;
  eventsUpdated: number;
  detectedType: string;
}

/**
 * Auto-detect ZIP type and process accordingly
 */
export async function processAutoDetectZip(
  db: Database,
  zipPath: string,
  sourceAccount: string | null
): Promise<AutoDetectResult> {
  console.log(`  Extracting: ${basename(zipPath)}`);
  const { tempDir, files } = await extractZip(zipPath);

  try {
    const contentType = detectZipContent(files);
    console.log(`  Detected type: ${contentType}`);

    let eventsAdded: number;
    let eventsUpdated = 0;

    switch (contentType) {
      case "google-takeout": {
        // Google Takeout auto-detects account, doesn't need config account
        const result = await processGoogleTakeoutZip(db, zipPath, null);
        eventsAdded = result.eventsAdded;
        eventsUpdated = result.eventsUpdated;
        break;
      }

      case "spotify":
        eventsAdded = await processSpotifyZip(db, tempDir, files, sourceAccount);
        break;

      case "reddit":
        eventsAdded = await processRedditZip(db, tempDir, files, sourceAccount);
        break;

      case "facebook":
        eventsAdded = await processFacebookZip(db, tempDir, files, sourceAccount);
        break;

      case "linkedin":
        eventsAdded = await processLinkedInZip(db, tempDir, files, sourceAccount);
        break;

      case "instagram":
        eventsAdded = await processInstagramZip(db, tempDir, files, sourceAccount);
        break;

      case "claude":
        eventsAdded = await processClaudeZip(db, zipPath, sourceAccount);
        break;

      case "chatgpt":
        eventsAdded = await processChatGPTZip(db, zipPath, sourceAccount);
        break;

      case "unknown":
      default:
        console.log(`  Unknown ZIP format, skipping`);
        eventsAdded = 0;
    }

    return { eventsAdded, eventsUpdated, detectedType: contentType };
  } finally {
    await cleanupExtract(tempDir);
  }
}

/**
 * Process Spotify export ZIP
 */
async function processSpotifyZip(
  db: Database,
  tempDir: string,
  files: string[],
  sourceAccount: string | null
): Promise<number> {
  if (!sourceAccount) {
    throw new Error("Spotify parser requires 'account' to be specified in config");
  }
  const { importSpotifyData } = await import("../parsers/spotify");
  return await importSpotifyData(db, tempDir, sourceAccount);
}

/**
 * Process Reddit export ZIP
 */
async function processRedditZip(
  db: Database,
  tempDir: string,
  files: string[],
  sourceAccount: string | null
): Promise<number> {
  if (!sourceAccount) {
    throw new Error("Reddit parser requires 'account' to be specified in config");
  }
  const { importRedditData } = await import("../parsers/reddit");
  return await importRedditData(db, tempDir, sourceAccount);
}

/**
 * Process Facebook export ZIP
 */
async function processFacebookZip(
  db: Database,
  tempDir: string,
  files: string[],
  sourceAccount: string | null
): Promise<number> {
  if (!sourceAccount) {
    throw new Error("Facebook parser requires 'account' to be specified in config");
  }
  const { importFacebookData } = await import("../parsers/facebook");
  return await importFacebookData(db, tempDir, sourceAccount);
}

/**
 * Process LinkedIn export ZIP
 */
async function processLinkedInZip(
  db: Database,
  tempDir: string,
  files: string[],
  sourceAccount: string | null
): Promise<number> {
  if (!sourceAccount) {
    throw new Error("LinkedIn parser requires 'account' to be specified in config");
  }
  const { importLinkedInData } = await import("../parsers/linkedin");
  return await importLinkedInData(db, tempDir, sourceAccount);
}

/**
 * Process Instagram export ZIP
 */
async function processInstagramZip(
  db: Database,
  tempDir: string,
  files: string[],
  sourceAccount: string | null
): Promise<number> {
  if (!sourceAccount) {
    throw new Error("Instagram parser requires 'account' to be specified in config");
  }

  // Find the messages folder - could be at different paths depending on export structure
  // Common paths: your_instagram_activity/messages, messages
  const messagesFile = files.find(
    (f) =>
      f.toLowerCase().includes("/messages/inbox/") &&
      f.includes("message_") &&
      f.endsWith(".json")
  );

  if (!messagesFile) {
    console.log("  No Instagram messages found");
    return 0;
  }

  // Navigate up to find the messages root (contains inbox/)
  let messagesPath = dirname(messagesFile);
  while (!messagesPath.toLowerCase().endsWith("/inbox") && messagesPath.includes("/")) {
    messagesPath = dirname(messagesPath);
  }
  // Go up one more to get the messages folder (parent of inbox)
  messagesPath = dirname(messagesPath);

  const { importInstagramData } = await import("../parsers/instagram");
  return await importInstagramData(db, messagesPath, sourceAccount);
}

/**
 * Process Claude export ZIP
 * Note: Claude parser handles extraction itself, so we pass zipPath
 */
async function processClaudeZip(
  db: Database,
  zipPath: string,
  sourceAccount: string | null
): Promise<number> {
  if (!sourceAccount) {
    throw new Error("Claude parser requires 'account' to be specified in config");
  }
  const { importClaudeExport } = await import("../parsers/claude");
  return await importClaudeExport(db, zipPath, sourceAccount);
}

/**
 * Process ChatGPT export ZIP
 * Note: ChatGPT parser handles extraction itself, so we pass zipPath
 */
async function processChatGPTZip(
  db: Database,
  zipPath: string,
  sourceAccount: string | null
): Promise<number> {
  if (!sourceAccount) {
    throw new Error("ChatGPT parser requires 'account' to be specified in config");
  }
  const { importChatGPTExport } = await import("../parsers/chatgpt");
  return await importChatGPTExport(db, zipPath, sourceAccount);
}
