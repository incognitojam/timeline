/**
 * Markdown Status Page Generator
 *
 * Generates a comprehensive status page in markdown format that can be:
 * - Served as raw markdown for agents and curl
 * - Converted to HTML for browser viewing
 */

import { marked } from "marked";
import { getAppStateDb } from "../db/app-state";
import { openReadonlyTimelineDb } from "../db/readonly";
import { listJobs } from "../jobs/store";
import { getRecentSyncLogs } from "../sync/log";
import { runningVersionInfo } from "../version";
import {
  formatInterval,
  getLastSyncForSource,
  getSchedulerSourceStatuses,
  getServiceState,
  type SchedulerSourceStatus,
} from "./status";
import { getStorageStatus, type StorageStatus } from "./storage-status";

// Configure marked for GitHub-flavored markdown
marked.setOptions({
  gfm: true,
  breaks: false,
});

/**
 * Format uptime in seconds to human-readable string
 */
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/**
 * Format duration in milliseconds
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format relative time from ISO date string
 */
function formatRelative(isoDate: string): string {
  const now = Date.now();
  const date = new Date(isoDate).getTime();
  const diff = now - date;
  const absDiff = Math.abs(diff);
  const isPast = diff > 0;

  if (absDiff < 60000) return isPast ? "just now" : "soon";

  let value: number, unit: string;
  if (absDiff < 3600000) {
    value = Math.floor(absDiff / 60000);
    unit = "m";
  } else if (absDiff < 86400000) {
    value = Math.floor(absDiff / 3600000);
    unit = "h";
  } else {
    value = Math.floor(absDiff / 86400000);
    unit = "d";
  }

  return isPast ? `${value}${unit} ago` : `in ${value}${unit}`;
}

/**
 * Format ISO date to readable date/time
 */
function formatDateTime(isoDate: string): string {
  const date = new Date(isoDate.includes("Z") ? isoDate : isoDate + "Z");
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * Format ISO date to short date (Jan 21 15:30)
 */
function formatShortDateTime(isoDate: string): string {
  const date = new Date(isoDate.includes("Z") ? isoDate : isoDate + "Z");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * Sanitize error text for display in markdown table cells.
 * Replaces newlines with spaces and escapes pipes.
 */
function sanitizeForTable(text: string): string {
  let sanitized = text
    .replace(/[\r\n]+/g, ' ')  // Replace newlines with space
    .replace(/&/g, '&amp;')    // Escape HTML entities (must be first)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|');    // Escape pipe characters
  if (sanitized.length > 200) {
    sanitized = sanitized.slice(0, 200) + "…";
  }
  return sanitized;
}

interface GroupedFailure {
  source: string;
  error: string | null;
  firstTime: string;
  lastTime: string;
  count: number;
  duration_ms: number;
}

/**
 * Group consecutive failures with identical source and error message.
 * Input should be sorted by time descending (most recent first).
 */
function groupConsecutiveFailures(
  failures: { source: string; started_at: string; error: string | null; duration_ms: number }[]
): GroupedFailure[] {
  const grouped: GroupedFailure[] = [];
  for (const f of failures) {
    const last = grouped[grouped.length - 1];
    if (last && last.source === f.source && last.error === f.error) {
      last.count++;
      last.lastTime = f.started_at;
    } else {
      grouped.push({
        source: f.source,
        error: f.error,
        firstTime: f.started_at,
        lastTime: f.started_at,
        count: 1,
        duration_ms: f.duration_ms,
      });
    }
  }
  return grouped;
}

/**
 * Render ASCII bar chart from bucket data using Unicode block characters
 * for higher resolution display
 */
function renderAsciiChart(
  buckets: { bucket: string; eventsAdded: number; syncs: number; failures: number; deferred: number }[],
  options: { mode: "hourly" | "daily" } = { mode: "hourly" }
): string {
  if (buckets.length === 0) {
    return "No activity data";
  }

  // Unicode block characters for 8 levels of fill (bottom to top)
  const blocks = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

  const max = Math.max(...buckets.map((b) => b.eventsAdded), 1);
  const height = 8; // 8 rows for good vertical resolution

  // Build rows from top to bottom
  const lines: string[] = [];

  for (let row = height; row >= 1; row--) {
    const rowBottom = ((row - 1) / height) * max;
    const rowTop = (row / height) * max;

    const bars = buckets
      .map((b) => {
        const value = b.eventsAdded;
        if (value >= rowTop) {
          // Full block
          return "█";
        } else if (value <= rowBottom) {
          // Empty
          return " ";
        } else {
          // Partial block - calculate which block character to use
          const fillRatio = (value - rowBottom) / (rowTop - rowBottom);
          const blockIndex = Math.round(fillRatio * 8);
          return blocks[blockIndex];
        }
      })
      .join("");

    // Add Y-axis label
    let label: string;
    if (row === height) {
      label = String(max).padStart(6);
    } else if (row === Math.ceil(height / 2)) {
      label = String(Math.ceil(max / 2)).padStart(6);
    } else if (row === 1) {
      label = "0".padStart(6);
    } else {
      label = "".padStart(6);
    }

    lines.push(`${label} │${bars}│`);
  }

  // X-axis
  const axisLine = "       └" + "─".repeat(buckets.length) + "┘";
  lines.push(axisLine);

  // Labels based on mode
  if (options.mode === "hourly") {
    // Hour labels - compact format for 24 buckets
    const labelLine = buckets
      .map((b, i) => {
        const hour = new Date(b.bucket).getUTCHours();
        if (i === 0 || i === 6 || i === 12 || i === 18 || i === 23) {
          return String(hour);
        }
        return "";
      });
    // Build label string with proper spacing
    let hourStr = "        ";
    for (let i = 0; i < buckets.length; i++) {
      if (labelLine[i]) {
        hourStr = hourStr.slice(0, 8 + i) + labelLine[i].padStart(1);
        if (labelLine[i].length === 2) {
          // Skip next position for 2-digit numbers
        }
      }
    }
    lines.push("        0     6    12    18   23");
  } else {
    // Day labels for 30-day view
    lines.push("        1        8       15       22      30");
  }

  return lines.join("\n");
}

/**
 * Gather all status data needed for markdown generation
 */
async function gatherStatusData() {
  const appDb = getAppStateDb();
  const serviceState = getServiceState();
  const db = openReadonlyTimelineDb();

  // Get event count
  let eventCount: number;
  try {
    eventCount = (
      db.prepare("SELECT COUNT(*) as count FROM events").get() as { count: number }
    ).count;
  } finally {
    db.close();
  }

  const schedulerSources = serviceState.schedulerEnabled ? await getSchedulerSourceStatuses() : [];

  // Get sync stats (last 7 days) for source cards
  const sourceStats = appDb
    .prepare(
      `SELECT
         source,
         COUNT(*) as syncs,
         SUM(CASE WHEN success = 1 AND skipped = 0 THEN 1 ELSE 0 END) as successes,
         SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) as deferred,
         SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
         COALESCE(SUM(events_added), 0) as events_added,
         AVG(CASE WHEN skipped = 0 THEN duration_ms ELSE NULL END) as avg_duration
       FROM sync_log
       WHERE started_at > datetime('now', '-7 days')
       GROUP BY source
       ORDER BY source`
    )
    .all() as {
    source: string;
    syncs: number;
    successes: number;
    deferred: number;
    failures: number;
    events_added: number;
    avg_duration: number | null;
  }[];

  // Get recent failures (last 30 days)
  const recentFailures = appDb
    .prepare(
      `SELECT source, started_at, error, duration_ms
       FROM sync_log
       WHERE success = 0
         AND started_at > datetime('now', '-30 days')
       ORDER BY started_at DESC
       LIMIT 10`
    )
    .all() as {
    source: string;
    started_at: string;
    error: string | null;
    duration_ms: number;
  }[];

  // Get hourly activity for last 24 hours
  const timeline = appDb
    .prepare(
      `SELECT
         strftime('%Y-%m-%dT%H:00:00Z', started_at) as bucket,
         COUNT(*) as syncs,
         COALESCE(SUM(events_added), 0) as events_added,
         SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
         SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) as deferred
       FROM sync_log
       WHERE started_at > datetime('now', '-24 hours')
       GROUP BY strftime('%Y-%m-%dT%H:00:00Z', started_at)
       ORDER BY bucket`
    )
    .all() as {
    bucket: string;
    syncs: number;
    events_added: number;
    failures: number;
    deferred: number;
  }[];

  // Fill in missing hourly buckets
  const now = new Date();
  const hourlyBuckets: { bucket: string; eventsAdded: number; syncs: number; failures: number; deferred: number }[] = [];
  for (let i = 23; i >= 0; i--) {
    const hour = new Date(now);
    hour.setMinutes(0, 0, 0);
    hour.setHours(hour.getHours() - i);
    const bucketStr = hour.toISOString().replace(/:\d{2}:\d{2}\.\d{3}Z$/, ":00:00Z");
    const existing = timeline.find((t) => t.bucket === bucketStr);
    hourlyBuckets.push({
      bucket: bucketStr,
      eventsAdded: existing?.events_added ?? 0,
      syncs: existing?.syncs ?? 0,
      failures: existing?.failures ?? 0,
      deferred: existing?.deferred ?? 0,
    });
  }

  // Get daily activity for last 30 days
  const dailyTimeline = appDb
    .prepare(
      `SELECT
         strftime('%Y-%m-%d', started_at) as bucket,
         COUNT(*) as syncs,
         COALESCE(SUM(events_added), 0) as events_added,
         SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
         SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) as deferred
       FROM sync_log
       WHERE started_at > datetime('now', '-30 days')
       GROUP BY strftime('%Y-%m-%d', started_at)
       ORDER BY bucket`
    )
    .all() as {
    bucket: string;
    syncs: number;
    events_added: number;
    failures: number;
    deferred: number;
  }[];

  // Fill in missing daily buckets
  const dailyBuckets: { bucket: string; eventsAdded: number; syncs: number; failures: number; deferred: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(now);
    day.setDate(day.getDate() - i);
    const bucketStr = day.toISOString().slice(0, 10);
    const existing = dailyTimeline.find((t) => t.bucket === bucketStr);
    dailyBuckets.push({
      bucket: bucketStr,
      eventsAdded: existing?.events_added ?? 0,
      syncs: existing?.syncs ?? 0,
      failures: existing?.failures ?? 0,
      deferred: existing?.deferred ?? 0,
    });
  }

  // Get recent sync history
  const syncHistory = getRecentSyncLogs(appDb, undefined, 15);

  // Get active jobs (queued + running) for the Queue section
  const queue = listJobs({ status: ["queued", "running"], limit: 200 }, appDb);

  // Get storage status
  const storage = await getStorageStatus();

  return {
    serviceState,
    version: runningVersionInfo,
    eventCount,
    schedulerSources,
    sourceStats,
    recentFailures,
    hourlyBuckets,
    dailyBuckets,
    syncHistory,
    queue,
    storage,
    generatedAt: new Date().toISOString(),
  };
}

export interface StatusMarkdownOptions {
  /** Whether the user is authenticated (shows full error details if true) */
  authenticated?: boolean;
}

/**
 * Generate the complete status markdown
 */
export async function generateStatusMarkdown(options: StatusMarkdownOptions = {}): Promise<string> {
  const { authenticated = false } = options;
  const data = await gatherStatusData();
  const lines: string[] = [];

  // Header with status
  const uptimeSeconds = Math.floor((Date.now() - data.serviceState.startTime) / 1000);

  lines.push("# Timeline Service Status");
  lines.push("");
  lines.push(`> Updated ${formatDateTime(data.generatedAt)}`);
  lines.push("");

  // Service section
  lines.push("## Service");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Uptime | ${formatUptime(uptimeSeconds)} |`);
  lines.push(`| Started | ${formatDateTime(new Date(data.serviceState.startTime).toISOString())} |`);
  if (data.version) {
    const release = data.version.version
      ? `${data.version.version}${data.version.build ? ` (build ${data.version.build})` : ""}`
      : data.version.commit;
    const message = data.version.message ? ` — ${sanitizeForTable(data.version.message)}` : "";
    lines.push(`| Version | ${release} |`);
    lines.push(`| Commit | ${data.version.commit}${message} |`);
  } else {
    lines.push("| Version | Unavailable |");
  }
  lines.push(`| Database | ${data.eventCount.toLocaleString()} events |`);
  lines.push("");

  // Queue section
  const queuedJobs = data.queue.filter((j) => j.status === "queued");
  const runningJobs = data.queue.filter((j) => j.status === "running");
  lines.push("## Queue");
  lines.push("");
  if (data.queue.length === 0) {
    lines.push("*Idle — 0 queued, 0 running*");
    lines.push("");
  } else {
    lines.push(`*${queuedJobs.length} queued, ${runningJobs.length} running*`);
    lines.push("");
    lines.push("| Status | Kind | Source | Trigger | Enqueued |");
    lines.push("|--------|------|--------|---------|----------|");
    const ordered = [...runningJobs, ...queuedJobs];
    for (const job of ordered) {
      lines.push(
        `| ${job.status} | ${job.kind} | ${job.source ?? "-"} | ${job.trigger} | ${formatRelative(job.enqueuedAt + "Z")} |`
      );
    }
    lines.push("");
  }

  // Sync Sources section (7 days)
  lines.push("## Sync Sources");
  lines.push("");
  lines.push("*Last 7 days*");
  lines.push("");

  if (data.sourceStats.length > 0) {
    lines.push("| Source | Syncs | Success | Deferred | Events | Avg Time |");
    lines.push("|--------|-------|---------|----------|--------|----------|");
    for (const s of data.sourceStats) {
      const completedRuns = s.successes + s.failures;
      const rate = completedRuns > 0 ? `${Math.round((s.successes / completedRuns) * 100)}%` : "-";
      const deferred = s.deferred > 0 ? String(s.deferred) : "-";
      const eventsStr = s.events_added > 0 ? `+${s.events_added.toLocaleString()}` : "-";
      const avgDuration = s.avg_duration !== null ? formatDuration(Math.round(s.avg_duration)) : "-";
      lines.push(
        `| ${s.source} | ${s.syncs} | ${rate} | ${deferred} | ${eventsStr} | ${avgDuration} |`
      );
    }
  } else {
    lines.push("*No sync data available*");
  }
  lines.push("");

  // Recent Failures section (grouped by consecutive identical errors)
  if (data.recentFailures.length > 0) {
    const groupedFailures = groupConsecutiveFailures(data.recentFailures);
    lines.push("### Recent Failures");
    lines.push("");
    lines.push("| Time | Source | Error |");
    lines.push("|------|--------|-------|");
    for (const f of groupedFailures) {
      const errorText = authenticated ? sanitizeForTable(f.error || "Unknown error") : "Error";
      const countSuffix = f.count > 1 ? ` (+${f.count - 1} more)` : "";
      lines.push(`| ${formatShortDateTime(f.firstTime)} | ${f.source} | ${errorText}${countSuffix} |`);
    }
    lines.push("");
  }

  // Sync Activity (24h ASCII chart)
  lines.push("## Sync Activity");
  lines.push("");
  lines.push("### Last 24 Hours");
  lines.push("");
  lines.push("```");
  lines.push(renderAsciiChart(data.hourlyBuckets, { mode: "hourly" }));
  lines.push("```");
  lines.push("");

  // 24h totals
  const totalEvents24h = data.hourlyBuckets.reduce((sum, b) => sum + b.eventsAdded, 0);
  const totalSyncs24h = data.hourlyBuckets.reduce((sum, b) => sum + b.syncs, 0);
  const totalFailures24h = data.hourlyBuckets.reduce((sum, b) => sum + b.failures, 0);
  const totalDeferred24h = data.hourlyBuckets.reduce((sum, b) => sum + b.deferred, 0);
  const totals24h = [
    `${totalSyncs24h} syncs`,
    `+${totalEvents24h.toLocaleString()} events`,
    `${totalFailures24h} failure${totalFailures24h !== 1 ? "s" : ""}`,
  ];
  if (totalDeferred24h > 0) totals24h.push(`${totalDeferred24h} deferred`);
  lines.push(`*${totals24h.join(", ")}*`);
  lines.push("");

  // Sync Activity (30d ASCII chart)
  lines.push("### Last 30 Days");
  lines.push("");
  lines.push("```");
  lines.push(renderAsciiChart(data.dailyBuckets, { mode: "daily" }));
  lines.push("```");
  lines.push("");

  // 30d totals
  const totalEvents30d = data.dailyBuckets.reduce((sum, b) => sum + b.eventsAdded, 0);
  const totalSyncs30d = data.dailyBuckets.reduce((sum, b) => sum + b.syncs, 0);
  const totalFailures30d = data.dailyBuckets.reduce((sum, b) => sum + b.failures, 0);
  const totalDeferred30d = data.dailyBuckets.reduce((sum, b) => sum + b.deferred, 0);
  const totals30d = [
    `${totalSyncs30d} syncs`,
    `+${totalEvents30d.toLocaleString()} events`,
    `${totalFailures30d} failure${totalFailures30d !== 1 ? "s" : ""}`,
  ];
  if (totalDeferred30d > 0) totals30d.push(`${totalDeferred30d} deferred`);
  lines.push(`*${totals30d.join(", ")}*`);
  lines.push("");

  // Scheduler section
  lines.push("## Scheduler");
  lines.push("");

  if (data.schedulerSources.length > 0) {
    lines.push("| Source | Interval | Last Run | Next Run | Action |");
    lines.push("|--------|----------|----------|----------|--------|");
    for (const s of data.schedulerSources) {
      const lastRunStr = s.lastRun ? formatRelative(s.lastRun.time) : "Never";
      const nextRunStr = s.nextRunAt ? formatRelative(s.nextRunAt) : "-";
      const actionLink = `[Run](/api/status/trigger-sync?source=${s.source})`;
      lines.push(
        `| ${s.source} | ${formatInterval(s.intervalMs)} | ${lastRunStr} | ${nextRunStr} | ${actionLink} |`
      );
    }
  } else {
    lines.push("*Scheduler not enabled*");
  }
  lines.push("");

  // Storage section
  lines.push("## Storage");
  lines.push("");

  // Database subsection
  lines.push("### Database");
  lines.push("");
  lines.push(`- **timeline.db**: ${formatBytes(data.storage.database.timeline.size)}`);
  lines.push(`- **app-state.db**: ${formatBytes(data.storage.database.appState.size)}`);
  lines.push(
    `- **Pages**: ${data.storage.database.sqlite.pageCount.toLocaleString()} x ${formatBytes(data.storage.database.sqlite.pageSize)}`
  );
  lines.push(`- **Freelist**: ${data.storage.database.sqlite.freelistCount.toLocaleString()} pages`);
  lines.push("");

  // Disk subsection
  lines.push("### Disk");
  lines.push("");
  lines.push(`- **Used**: ${data.storage.disk.usedPercent}%`);
  lines.push(`- **Available**: ${formatBytes(data.storage.disk.available)}`);
  lines.push(`- **Total**: ${formatBytes(data.storage.disk.total)}`);
  lines.push("");

  // ZFS Snapshots subsection
  if (data.storage.zfs.available && data.storage.zfs.snapshots.length > 0) {
    lines.push("### ZFS Snapshots");
    lines.push("");
    if (authenticated) {
      lines.push(`*Dataset: ${data.storage.zfs.dataset} (${data.storage.zfs.snapshots.length} snapshots)*`);
    } else {
      lines.push(`*${data.storage.zfs.snapshots.length} snapshots*`);
    }
    lines.push("");
    lines.push("| Snapshot | Time | Size |");
    lines.push("|----------|------|------|");
    // Show last 10 snapshots, newest first
    const recentSnapshots = data.storage.zfs.snapshots.slice(-10).reverse();
    for (const s of recentSnapshots) {
      const displayName = authenticated
        ? s.name
        : (s.name.includes("@") ? (s.name.split("@")[1] || "snapshot") : "snapshot");
      lines.push(`| ${displayName} | ${formatRelative(s.creation)} | ${s.used} |`);
    }
    lines.push("");
  }

  // Recent Sync History section (with grouped consecutive failures)
  lines.push("## Recent Sync History");
  lines.push("");

  if (data.syncHistory.length > 0) {
    // Group consecutive failures with same source and error
    type HistoryRow =
      | { type: "deferred"; entry: (typeof data.syncHistory)[0] }
      | { type: "success"; entry: (typeof data.syncHistory)[0] }
      | { type: "running"; entry: (typeof data.syncHistory)[0] }
      | { type: "failure"; source: string; error: string | null; firstTime: string; count: number };
    const rows: HistoryRow[] = [];

    for (const e of data.syncHistory) {
      if (e.skipped === 1) {
        rows.push({ type: "deferred", entry: e });
      } else if (e.success === 1) {
        rows.push({ type: "success", entry: e });
      } else if (e.finished_at === null) {
        // Running: not finished yet (success is NULL)
        rows.push({ type: "running", entry: e });
      } else {
        // Failed: finished but not successful
        const last = rows[rows.length - 1];
        if (last?.type === "failure" && last.source === e.source && last.error === e.error) {
          last.count++;
        } else {
          rows.push({ type: "failure", source: e.source, error: e.error, firstTime: e.started_at, count: 1 });
        }
      }
    }

    lines.push("| Time | Source | Result |");
    lines.push("|------|--------|--------|");
    for (const row of rows) {
      if (row.type === "deferred") {
        const e = row.entry;
        lines.push(`| ${formatShortDateTime(e.started_at)} | ${e.source} | deferred |`);
      } else if (row.type === "success") {
        const e = row.entry;
        let result: string;
        // Handle backup source with metadata
        if ((e.source === "backup" || e.source === "backup-app-state") && e.metadata) {
          try {
            const meta = JSON.parse(e.metadata) as {
              sizeMB?: number;
              deleted?: number;
            };
            const parts: string[] = [];
            if (meta.sizeMB !== undefined) {
              parts.push(meta.sizeMB >= 1024 ? `${(meta.sizeMB / 1024).toFixed(1)} GB` : `${meta.sizeMB} MB`);
            }
            if (meta.deleted) {
              parts.push(`${meta.deleted} deleted`);
            }
            const duration = e.duration_ms ? ` (${formatDuration(e.duration_ms)})` : "";
            result = parts.length > 0
              ? `OK ${parts.join(", ")}${duration}`
              : `OK backup complete${duration}`;
          } catch {
            // Fallback to default format if metadata parsing fails
            const duration = e.duration_ms ? ` (${formatDuration(e.duration_ms)})` : "";
            result = `OK backup complete${duration}`;
          }
        } else {
          const added = e.events_added > 0 ? `+${e.events_added}` : "0";
          const updated = e.events_updated > 0 ? `, ~${e.events_updated}` : "";
          const duration = e.duration_ms ? ` (${formatDuration(e.duration_ms)})` : "";
          result = `OK ${added}${updated} events${duration}`;
        }
        lines.push(`| ${formatShortDateTime(e.started_at)} | ${e.source} | ${result} |`);
      } else if (row.type === "running") {
        const e = row.entry;
        lines.push(`| ${formatShortDateTime(e.started_at)} | ${e.source} | ... Running |`);
      } else {
        const errorText = authenticated ? sanitizeForTable(row.error || "Error") : "Error";
        const countSuffix = row.count > 1 ? ` (+${row.count - 1} more)` : "";
        lines.push(`| ${formatShortDateTime(row.firstTime)} | ${row.source} | X ${errorText}${countSuffix} |`);
      }
    }
  } else {
    lines.push("*No sync history*");
  }
  lines.push("");

  // Footer
  lines.push("---");
  lines.push("*[View JSON API](/api/status) | [Storage](/api/status/storage)*");
  lines.push("");

  return lines.join("\n");
}

/**
 * Convert markdown to HTML with styling
 */
export function renderMarkdownToHtml(markdown: string): string {
  const htmlContent = marked.parse(markdown) as string;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="60">
  <title>Timeline Status</title>
  <style>
    :root {
      --bg: #0a0a0b;
      --fg: #fafafa;
      --border: #27272a;
      --muted: #a1a1aa;
      --success: #22c55e;
      --error: #ef4444;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #ffffff;
        --fg: #09090b;
        --border: #e4e4e7;
        --muted: #71717a;
      }
    }
    * { box-sizing: border-box; }
    body {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      background: var(--bg);
      color: var(--fg);
      max-width: 900px;
      margin: 0 auto;
      padding: 2rem 1rem;
      font-size: 14px;
      line-height: 1.6;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.1rem; margin: 2rem 0 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
    h3 { font-size: 1rem; margin: 1.5rem 0 0.75rem; color: var(--muted); }
    blockquote {
      margin: 0 0 1.5rem;
      padding: 0.75rem 1rem;
      border-left: 3px solid var(--success);
      background: color-mix(in srgb, var(--success) 10%, transparent);
    }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 13px; table-layout: auto; }
    th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { color: var(--muted); font-weight: 500; }
    tr:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
    /* Keep Time and Source columns from being squashed */
    td:first-child, th:first-child { white-space: nowrap; min-width: 100px; }
    td:nth-child(2), th:nth-child(2) { white-space: nowrap; min-width: 80px; }
    pre {
      background: color-mix(in srgb, var(--fg) 5%, transparent);
      padding: 1rem;
      overflow-x: auto;
      border: 1px solid var(--border);
      font-size: 12px;
      line-height: 1.4;
    }
    code { font-family: inherit; }
    ul { margin: 0.5rem 0; padding-left: 1.5rem; }
    li { margin: 0.25rem 0; }
    a { color: var(--fg); }
    a:hover { text-decoration: none; }
    hr { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }
    em { color: var(--muted); font-style: normal; }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`;
}
