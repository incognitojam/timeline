/**
 * WakaTime session aggregation shared by the file-based parser
 * (parsers/wakatime.ts) and the API sync parser (parsers/wakatime-api.ts).
 *
 * WakaTime sends "heartbeats" every ~2 minutes while coding; these helpers
 * group them into sessions based on time gaps.
 *
 * Session boundary: 15 minutes of inactivity
 * Duration calculation: Sum of gaps between heartbeats, capped at 2 min each
 */

// The subset of heartbeat fields the session logic reads. The file-export
// and API heartbeat shapes both satisfy this.
export interface SessionHeartbeat {
  id: string;
  time: number; // Unix timestamp
  entity: string;
  project: string | null;
  language: string | null;
  branch: string | null;
  category: string;
  machine_name_id: string;
}

export interface Session<H extends SessionHeartbeat = SessionHeartbeat> {
  id: string; // Generated from first heartbeat ID
  startTime: number;
  endTime: number;
  durationMs: number;
  heartbeats: H[];
  projects: Map<string, number>; // project -> heartbeat count
  languages: Map<string, number>; // language -> heartbeat count
  files: Set<string>;
  branches: Set<string>;
  categories: Set<string>;
  machines: Set<string>;
}

// Configuration
export const SESSION_TIMEOUT_MINUTES = 15;
const HEARTBEAT_INTERVAL_SECONDS = 2 * 60; // 2 minutes

/**
 * Aggregate heartbeats into sessions using a timeout-based approach.
 * A gap of > SESSION_TIMEOUT_MINUTES between heartbeats starts a new session.
 */
export function aggregateIntoSessions<H extends SessionHeartbeat>(heartbeats: H[]): Session<H>[] {
  if (heartbeats.length === 0) return [];

  const sorted = [...heartbeats].sort((a, b) => a.time - b.time);
  const timeoutSeconds = SESSION_TIMEOUT_MINUTES * 60;
  const sessions: Session<H>[] = [];

  let current: Session<H> | null = null;

  for (const hb of sorted) {
    if (!current || hb.time - current.endTime > timeoutSeconds) {
      // Start new session
      if (current) {
        current.durationMs = calculateDuration(current.heartbeats);
        sessions.push(current);
      }
      current = {
        id: hb.id, // Use first heartbeat's ID as session ID
        startTime: hb.time,
        endTime: hb.time,
        durationMs: 0,
        heartbeats: [hb],
        projects: new Map(),
        languages: new Map(),
        files: new Set(),
        branches: new Set(),
        categories: new Set(),
        machines: new Set(),
      };
    } else {
      // Continue current session
      current.endTime = hb.time;
      current.heartbeats.push(hb);
    }

    // Track metadata
    if (hb.project) {
      current.projects.set(hb.project, (current.projects.get(hb.project) || 0) + 1);
    }
    if (hb.language) {
      current.languages.set(hb.language, (current.languages.get(hb.language) || 0) + 1);
    }
    if (hb.entity) {
      current.files.add(hb.entity);
    }
    if (hb.branch) {
      current.branches.add(hb.branch);
    }
    if (hb.category) {
      current.categories.add(hb.category);
    }
    if (hb.machine_name_id) {
      current.machines.add(hb.machine_name_id);
    }
  }

  if (current) {
    current.durationMs = calculateDuration(current.heartbeats);
    sessions.push(current);
  }

  return sessions;
}

/**
 * Calculate session duration from heartbeats.
 * Uses WakaTime's approach: sum of gaps between heartbeats, capped at 2 min each,
 * plus one interval for the last heartbeat.
 */
function calculateDuration(heartbeats: { time: number }[]): number {
  if (heartbeats.length === 0) return 0;
  if (heartbeats.length === 1) return HEARTBEAT_INTERVAL_SECONDS * 1000;

  const sorted = heartbeats.sort((a, b) => a.time - b.time);
  let durationSeconds = 0;

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].time - sorted[i - 1].time;
    // Cap each gap at heartbeat interval
    durationSeconds += Math.min(gap, HEARTBEAT_INTERVAL_SECONDS);
  }

  // Add one interval for the last heartbeat
  durationSeconds += HEARTBEAT_INTERVAL_SECONDS;

  return durationSeconds * 1000; // Return in ms
}

/**
 * Get the primary (most frequent) item from a frequency map
 */
function getPrimary(map: Map<string, number>): string | null {
  let maxCount = 0;
  let primary: string | null = null;
  for (const [key, count] of map) {
    if (count > maxCount) {
      maxCount = count;
      primary = key;
    }
  }
  return primary;
}

/**
 * Get items sorted by frequency
 */
function getSortedByFrequency(map: Map<string, number>): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
}

/**
 * Generate a title for a session based on its primary project and language
 */
export function generateSessionTitle(session: Session): string {
  const project = getPrimary(session.projects) || "Unknown project";
  const language = getPrimary(session.languages);
  return language ? `${project} (${language})` : project;
}

/**
 * Generate content/description for a session
 */
export function generateSessionContent(session: Session): string {
  const parts: string[] = [];

  const projects = getSortedByFrequency(session.projects);
  if (projects.length > 0) {
    parts.push(`Projects: ${projects.join(", ")}`);
  }

  const languages = getSortedByFrequency(session.languages);
  if (languages.length > 0) {
    parts.push(`Languages: ${languages.join(", ")}`);
  }

  parts.push(`Files touched: ${session.files.size}`);
  parts.push(`Heartbeats: ${session.heartbeats.length}`);

  const branches = [...session.branches];
  if (branches.length > 0 && branches.length <= 5) {
    parts.push(`Branches: ${branches.join(", ")}`);
  }

  return parts.join("\n");
}

/**
 * Build session metadata for raw_data storage
 */
export function buildSessionMetadata(session: Session): Record<string, unknown> {
  return {
    session_id: session.id,
    heartbeat_count: session.heartbeats.length,
    projects: Object.fromEntries(session.projects),
    languages: Object.fromEntries(session.languages),
    file_count: session.files.size,
    branches: [...session.branches],
    categories: [...session.categories],
    machines: [...session.machines],
    first_heartbeat_id: session.heartbeats[0]?.id,
    last_heartbeat_id: session.heartbeats[session.heartbeats.length - 1]?.id,
  };
}
