/**
 * ZIP File Handlers
 *
 * Processes different types of ZIP exports (Google Takeout, Spotify, etc.)
 */

import { Database } from "bun:sqlite";
import { basename, dirname } from "path";
import {
  extractZip,
  cleanupExtract,
  detectZipContent,
  type ZipContentType,
} from "./zip";
import { processGoogleTakeoutZip } from "../platforms/google/takeout/handler";

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
  const { importSpotifyData } = await import("../platforms/spotify/parser");
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
  const { importRedditData } = await import("../platforms/reddit/parser");
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
  const { importFacebookData } = await import("../platforms/facebook/parser");
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
  const { importLinkedInData } = await import("../platforms/linkedin/parser");
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

  const { importInstagramData } = await import("../platforms/instagram/parser");
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
