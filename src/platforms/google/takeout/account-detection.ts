/**
 * Google Account Detection
 *
 * Detects the Google account email from Takeout ZIP contents.
 * Uses multiple detection methods in order of reliability.
 */

import { homedir } from "os";
import { join } from "path";

export interface DetectionResult {
  /** Account name for database (email prefix, e.g., "alice") */
  account: string;
  /** Full email address detected */
  email: string;
  /** Detection method used */
  method: "profile" | "google-chat" | "google-calendar" | "rclone-drive-api";
}

interface ProfileJson {
  emails?: Array<{ value: string }>;
}

interface ChatGroupInfo {
  name: string;
  members: Array<{
    name: string;
    email: string;
    user_type: string;
  }>;
}

/**
 * Convert email to account name format.
 * "alice@example.com" -> "alice"
 */
export function emailToAccountName(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return email.toLowerCase();
  return email.substring(0, atIndex).toLowerCase();
}

export function getRcloneConfigPath(): string {
  const configuredPath = process.env.RCLONE_CONFIG?.trim();
  if (configuredPath) {
    return configuredPath.startsWith("~/")
      ? join(homedir(), configuredPath.slice(2))
      : configuredPath;
  }

  const homeDir = process.env.HOME || homedir();
  return join(homeDir, ".config", "rclone", "rclone.conf");
}

/**
 * Detect Google account from extracted Takeout files.
 * Tries Profile.json first (most direct), then Chat, then Calendar.
 */
export async function detectGoogleAccount(
  tempDir: string,
  files: string[]
): Promise<DetectionResult | null> {
  // Try Profile.json first (most direct - contains email)
  const profileResult = await detectFromProfile(files);
  if (profileResult) return profileResult;

  // Try Google Chat (account owner appears in all groups)
  const chatResult = await detectFromGoogleChat(files);
  if (chatResult) return chatResult;

  // Try Google Calendar as fallback
  const calendarResult = await detectFromCalendar(files);
  if (calendarResult) return calendarResult;

  return null;
}

/**
 * Detect account from Profile/Profile.json.
 * This is the most direct source - contains email directly.
 */
async function detectFromProfile(
  files: string[]
): Promise<DetectionResult | null> {
  // Find Profile.json (files are already full paths)
  const profileFile = files.find(
    (f) => f.toLowerCase().endsWith("profile/profile.json")
  );

  if (!profileFile) return null;

  try {
    const data: ProfileJson = await Bun.file(profileFile).json();
    const email = data.emails?.[0]?.value?.toLowerCase();

    if (!email) return null;

    return {
      account: emailToAccountName(email),
      email,
      method: "profile",
    };
  } catch {
    return null;
  }
}

/**
 * Detect account from Google Chat group_info.json files.
 * The account owner appears as a member in all/most groups.
 */
async function detectFromGoogleChat(
  files: string[]
): Promise<DetectionResult | null> {
  // Find all group_info.json files (files are already full paths)
  const groupInfoFiles = files.filter(
    (f) =>
      f.toLowerCase().includes("google chat") && f.endsWith("group_info.json")
  );

  if (groupInfoFiles.length === 0) return null;

  // Count email occurrences across all groups
  const emailCounts = new Map<string, number>();

  for (const fullPath of groupInfoFiles) {
    try {
      const data: ChatGroupInfo = await Bun.file(fullPath).json();

      for (const member of data.members || []) {
        if (member.email) {
          const email = member.email.toLowerCase();
          emailCounts.set(email, (emailCounts.get(email) || 0) + 1);
        }
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  if (emailCounts.size === 0) return null;

  // Find the email that appears most frequently (the account owner)
  let maxEmail: string | null = null;
  let maxCount = 0;

  for (const [email, count] of emailCounts) {
    if (count > maxCount) {
      maxCount = count;
      maxEmail = email;
    }
  }

  if (!maxEmail) return null;

  return {
    account: emailToAccountName(maxEmail),
    email: maxEmail,
    method: "google-chat",
  };
}

/**
 * Detect account from Google Calendar ICS files.
 * Extracts ORGANIZER mailto: values from events.
 */
async function detectFromCalendar(
  files: string[]
): Promise<DetectionResult | null> {
  // Find ICS files in Calendar directory (files are already full paths)
  const icsFiles = files.filter(
    (f) => f.toLowerCase().includes("calendar") && f.endsWith(".ics")
  );

  if (icsFiles.length === 0) return null;

  // Count organizer email occurrences
  const emailCounts = new Map<string, number>();

  for (const fullPath of icsFiles) {
    try {
      const content = await Bun.file(fullPath).text();

      // Extract ORGANIZER mailto: values
      // Format: ORGANIZER;CN=Name:mailto:alice@example.com
      // or just: ORGANIZER:mailto:alice@example.com
      const matches = content.matchAll(/ORGANIZER[^:]*:mailto:([^\s\r\n]+)/gi);

      for (const match of matches) {
        const email = match[1].toLowerCase();
        emailCounts.set(email, (emailCounts.get(email) || 0) + 1);
      }
    } catch {
      // Skip files that can't be read
    }
  }

  if (emailCounts.size === 0) return null;

  // Find the most frequent organizer email
  let maxEmail: string | null = null;
  let maxCount = 0;

  for (const [email, count] of emailCounts) {
    if (count > maxCount) {
      maxCount = count;
      maxEmail = email;
    }
  }

  if (!maxEmail) return null;

  return {
    account: emailToAccountName(maxEmail),
    email: maxEmail,
    method: "google-calendar",
  };
}

/**
 * Detect Google account from an rclone remote by querying the Drive API.
 * Uses the rclone access token to call drive/v3/about?fields=user.
 *
 * @param remoteName - The rclone remote name (e.g., "gdrive" without the colon)
 */
export async function detectFromRclone(
  remoteName: string
): Promise<DetectionResult | null> {
  try {
    // Read the rclone config to get the access token
    // Note: We skip the token refresh step as it can timeout in service environments.
    // The token should still be valid if rclone was used recently (e.g., to copy files to inbox).
    const configPath = getRcloneConfigPath();
    const configFile = Bun.file(configPath);

    if (!(await configFile.exists())) {
      console.log(`    rclone config not found at: ${configPath}`);
      return null;
    }

    const configContent = await configFile.text();

    // Find the remote section and extract the token
    const remoteRegex = new RegExp(`\\[${remoteName}\\][\\s\\S]*?token\\s*=\\s*(.+?)\\n`, "i");
    const match = configContent.match(remoteRegex);

    if (!match) {
      console.log(`    rclone remote "${remoteName}" not found in config`);
      return null;
    }

    // Parse the token JSON to get the access_token
    const tokenJson = match[1].trim();
    let accessToken: string;

    try {
      const tokenData = JSON.parse(tokenJson);
      accessToken = tokenData.access_token;
    } catch (e) {
      console.log(`    Failed to parse rclone token JSON: ${e}`);
      return null;
    }

    if (!accessToken) {
      console.log(`    No access_token in rclone token`);
      return null;
    }

    // Query the Google Drive API for user info
    const response = await fetch(
      "https://www.googleapis.com/drive/v3/about?fields=user",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!response.ok) {
      console.log(`    Drive API returned ${response.status}: ${response.statusText}`);
      return null;
    }

    const data = await response.json() as {
      user?: {
        emailAddress?: string;
        displayName?: string;
      };
    };

    const email = data.user?.emailAddress?.toLowerCase();
    if (!email) {
      console.log(`    No emailAddress in Drive API response`);
      return null;
    }

    return {
      account: emailToAccountName(email),
      email,
      method: "rclone-drive-api",
    };
  } catch (e) {
    console.log(`    detectFromRclone error: ${e}`);
    return null;
  }
}
