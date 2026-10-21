/**
 * ZIP Extraction Utilities
 *
 * Handles extraction and detection of ZIP archive contents.
 */

import { spawn } from "child_process";
import { mkdtemp, rm, readdir, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { findChatGPTConversationFiles } from "../shared/chatgpt-export";
import { backgroundCommand } from "../lib/background-priority";

export interface ExtractResult {
  tempDir: string;
  files: string[];
}

/**
 * Extract a ZIP file to a temporary directory
 */
export async function extractZip(zipPath: string): Promise<ExtractResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "timeline-inbox-"));

  return new Promise((resolve, reject) => {
    const [command, ...args] = backgroundCommand(["unzip", "-q", zipPath, "-d", tempDir]);
    const proc = spawn(command, args, {
      stdio: "pipe",
    });

    let stderr = "";
    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (error) => {
      reject(new Error(`Failed to run unzip: ${error.message}`));
    });

    proc.on("close", async (code) => {
      if (code !== 0) {
        await rm(tempDir, { recursive: true, force: true });
        reject(new Error(`unzip failed: ${stderr}`));
        return;
      }

      try {
        const files = await listFilesRecursive(tempDir);
        resolve({ tempDir, files });
      } catch (error) {
        await rm(tempDir, { recursive: true, force: true });
        reject(error);
      }
    });
  });
}

/**
 * List all files recursively in a directory
 */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(fullPath)));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Clean up extracted temp directory
 */
export async function cleanupExtract(tempDir: string): Promise<void> {
  await rm(tempDir, { recursive: true, force: true });
}

/**
 * Detected ZIP content type
 */
export type ZipContentType =
  | "google-takeout"
  | "spotify"
  | "reddit"
  | "facebook"
  | "linkedin"
  | "instagram"
  | "claude"
  | "chatgpt"
  | "unknown";

/**
 * Detect what type of export a ZIP contains based on its contents
 */
export function detectZipContent(files: string[]): ZipContentType {
  const relativeFiles = files.map((f) => f.toLowerCase());

  // Google Takeout - has Takeout/ directory or characteristic files
  if (
    relativeFiles.some(
      (f) =>
        f.includes("/takeout/") ||
        f.includes("my activity") ||
        f.includes("/youtube/") ||
        f.includes("/chrome/") ||
        f.includes("/location history/") ||
        f.includes("/google keep/") ||
        f.includes("/google chat/")
    )
  ) {
    return "google-takeout";
  }

  // Spotify - has streaming history files
  if (
    relativeFiles.some(
      (f) =>
        f.includes("streaminghistory") ||
        f.includes("streaming_history") ||
        f.includes("endsong")
    )
  ) {
    return "spotify";
  }

  // Reddit - has specific reddit export files
  if (
    relativeFiles.some(
      (f) =>
        f.includes("comments.csv") ||
        f.includes("posts.csv") ||
        f.includes("saved_posts.csv") ||
        f.includes("statistics.csv")
    )
  ) {
    return "reddit";
  }

  // Instagram - has message_1.json in messages/inbox (check before Facebook!)
  // Instagram exports have your_instagram_activity folder or liked_posts.json
  if (
    relativeFiles.some(
      (f) =>
        (f.includes("/messages/inbox/") && f.includes("message_1.json")) ||
        f.includes("your_instagram_activity") ||
        f.includes("liked_posts.json")
    )
  ) {
    return "instagram";
  }

  // Facebook - has messages/inbox structure (without Instagram indicators)
  if (
    relativeFiles.some(
      (f) =>
        f.includes("/messages/inbox/") ||
        f.includes("/posts/your_posts") ||
        f.includes("your_facebook_activity")
    )
  ) {
    return "facebook";
  }

  // LinkedIn - has connections.csv or messages.csv
  if (
    relativeFiles.some(
      (f) =>
        (f.includes("connections.csv") && f.includes("linkedin")) ||
        f.includes("/messages/messages.csv") ||
        f.includes("profile.csv")
    )
  ) {
    return "linkedin";
  }

  // Claude - has memories.json or (conversations.json + projects.json)
  const hasMemories = relativeFiles.some((f) => f.endsWith("memories.json"));
  const hasProjects = relativeFiles.some((f) => f.endsWith("projects.json"));
  const hasConversations = findChatGPTConversationFiles(relativeFiles).length > 0;
  if (hasMemories || (hasConversations && hasProjects)) {
    return "claude";
  }

  // ChatGPT - has conversations.json but not Claude's distinctive files
  // Also may have user.json, model_comparisons.json, shared_conversations.json
  const hasUserJson = relativeFiles.some((f) => f.endsWith("user.json"));
  const hasModelComparisons = relativeFiles.some((f) =>
    f.endsWith("model_comparisons.json")
  );
  if (hasConversations && (hasUserJson || hasModelComparisons)) {
    return "chatgpt";
  }

  return "unknown";
}

/**
 * Get Google Takeout services present in extracted files
 */
export function detectTakeoutServices(files: string[]): string[] {
  const services: Set<string> = new Set();

  for (const file of files) {
    const lower = file.toLowerCase();

    if (lower.includes("/youtube/")) services.add("youtube");
    if (lower.includes("/chrome/")) services.add("chrome");
    if (lower.includes("/google keep/") || lower.includes("/keep/"))
      services.add("keep");
    if (lower.includes("/calendar/")) services.add("calendar");
    if (lower.includes("/location history/") || lower.includes("records.json"))
      services.add("location");
    if (lower.includes("/google chat/") || lower.includes("/chat/"))
      services.add("chat");
    if (lower.includes("/my activity/") && lower.includes("search"))
      services.add("search");
    if (lower.includes("/fit/")) services.add("fit");
    if (lower.includes("/fitbit/")) services.add("fitbit");
    if (lower.includes("timeline.json")) services.add("timeline");
  }

  return Array.from(services);
}

/**
 * Find files matching a pattern in extracted contents
 */
export function findFiles(
  files: string[],
  pattern: RegExp | ((path: string) => boolean)
): string[] {
  if (pattern instanceof RegExp) {
    return files.filter((f) => pattern.test(f));
  }
  return files.filter(pattern);
}
