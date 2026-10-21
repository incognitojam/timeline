/**
 * GitHub API Parser
 *
 * Syncs GitHub activity via REST API using a fine-grained Personal Access Token.
 * Tracks: events (push, star, fork, issues, PRs, etc.), stars with timestamps, and gists.
 *
 * Reads config from ~/.config/timeline/github.json:
 * {
 *   "token": "github_pat_...",
 *   "username": "example-user",
 *   "token_expires": "2026-04-06",
 *   "last_sync": { "events_etag": "...", "events_timestamp": "..." }
 * }
 */

import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import { getAppStateDb, getSyncState, setSyncState } from "../db/app-state";
import {
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Config
const CONFIG_DIR = join(homedir(), ".config", "timeline");
const CONFIG_PATH = join(CONFIG_DIR, "github.json");
const GITHUB_API_URL = "https://api.github.com";

interface GitHubConfig {
  token: string;
  username: string;
  token_expires?: string;
}

// Sync state stored in app-state.db
interface GitHubSyncState {
  events_etag?: string;
  events_timestamp?: string;
  stars_timestamp?: string;
  gists_timestamp?: string;
}

// GitHub API event types
interface GitHubEvent {
  id: string;
  type: string;
  actor: { login: string; avatar_url?: string };
  repo: { name: string };
  payload: Record<string, unknown>;
  created_at: string;
}

interface GitHubStar {
  starred_at: string;
  repo: {
    full_name: string;
    description: string | null;
    html_url: string;
    language: string | null;
  };
}

interface GitHubGist {
  id: string;
  description: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  files: Record<string, { filename: string; language: string | null }>;
  public: boolean;
}

export function loadConfig(): GitHubConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

// API helper
async function githubGet<T>(
  config: GitHubConfig,
  endpoint: string,
  options?: { etag?: string; params?: Record<string, string> }
): Promise<{ data: T | null; etag?: string; notModified: boolean; headers: Headers }> {
  const url = new URL(`${GITHUB_API_URL}${endpoint}`);
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${config.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (options?.etag) {
    headers["If-None-Match"] = options.etag;
  }

  const response = await fetch(url.toString(), { headers });

  if (response.status === 304) {
    return { data: null, notModified: true, headers: response.headers };
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${error}`);
  }

  return {
    data: await response.json(),
    etag: response.headers.get("etag") || undefined,
    notModified: false,
    headers: response.headers,
  };
}

// Process different event types
function processEvent(
  event: GitHubEvent,
  sourceAccount: string
): { type: string; title: string; content: string | null; tags: string[] } | null {
  const repo = event.repo.name;
  const payload = event.payload;

  switch (event.type) {
    case "PushEvent":
      // GitHub removed commits/size from Events API (2025-10-07)
      // See: https://github.blog/changelog/2025-08-08-upcoming-changes-to-github-events-api-payloads/
      return null;

    case "WatchEvent":
      return {
        type: "github:star",
        title: `Starred ${repo}`,
        content: null,
        tags: [`repo:${repo}`],
      };

    case "ForkEvent": {
      const forkee = payload.forkee as { full_name: string } | undefined;
      return {
        type: "github:fork",
        title: `Forked ${repo}`,
        content: forkee ? `Created ${forkee.full_name}` : null,
        tags: [`repo:${repo}`],
      };
    }

    case "IssuesEvent": {
      const action = payload.action as string;
      if (action !== "opened") return null;
      const issue = payload.issue as { number: number; title: string; body?: string };
      return {
        type: "github:issue",
        title: `Opened issue #${issue.number}: ${issue.title}`,
        content: issue.body?.slice(0, 500) || null,
        tags: [`repo:${repo}`, "issue"],
      };
    }

    case "IssueCommentEvent": {
      const issue = payload.issue as { number: number };
      const comment = payload.comment as { body: string };
      return {
        type: "github:issue_comment",
        title: `Commented on issue #${issue.number}`,
        content: comment.body?.slice(0, 500) || null,
        tags: [`repo:${repo}`, "comment"],
      };
    }

    case "PullRequestEvent": {
      const action = payload.action as string;
      if (action !== "opened") return null;
      // GitHub removed title from Events API (2025-10-07), use branch name as fallback
      const pr = payload.pull_request as { number: number; title?: string; body?: string; head?: { ref?: string } };
      const title = pr.title || pr.head?.ref || "(untitled)";
      return {
        type: "github:pr",
        title: `Opened PR #${pr.number}: ${title}`,
        content: pr.body?.slice(0, 500) || null,
        tags: [`repo:${repo}`, "pull-request"],
      };
    }

    case "PullRequestReviewEvent": {
      const pr = payload.pull_request as { number: number };
      const review = payload.review as { state: string; body?: string };
      return {
        type: "github:pr_review",
        title: `Reviewed PR #${pr.number} (${review.state})`,
        content: review.body?.slice(0, 500) || null,
        tags: [`repo:${repo}`, "review"],
      };
    }

    case "PullRequestReviewCommentEvent": {
      const pr = payload.pull_request as { number: number };
      const comment = payload.comment as { body: string };
      return {
        type: "github:pr_comment",
        title: `Commented on PR #${pr.number}`,
        content: comment.body?.slice(0, 500) || null,
        tags: [`repo:${repo}`, "comment"],
      };
    }

    case "CreateEvent": {
      const refType = payload.ref_type as string;
      const ref = payload.ref as string | null;
      if (refType === "repository") {
        return {
          type: "github:create",
          title: `Created repository ${repo}`,
          content: null,
          tags: [`repo:${repo}`],
        };
      }
      return {
        type: "github:create",
        title: `Created ${refType} ${ref} in ${repo}`,
        content: null,
        tags: [`repo:${repo}`],
      };
    }

    case "DeleteEvent": {
      const refType = payload.ref_type as string;
      const ref = payload.ref as string;
      return {
        type: "github:delete",
        title: `Deleted ${refType} ${ref} from ${repo}`,
        content: null,
        tags: [`repo:${repo}`],
      };
    }

    case "ReleaseEvent": {
      const action = payload.action as string;
      if (action !== "published") return null;
      const release = payload.release as { tag_name: string; name?: string; body?: string };
      return {
        type: "github:release",
        title: `Released ${release.tag_name} of ${repo}`,
        content: release.body?.slice(0, 500) || null,
        tags: [`repo:${repo}`, "release"],
      };
    }

    case "FollowEvent": {
      const target = payload.target as { login: string } | undefined;
      if (!target) return null;
      return {
        type: "github:follow",
        title: `Followed ${target.login}`,
        content: null,
        tags: [],
      };
    }

    case "MemberEvent": {
      const action = payload.action as string;
      const member = payload.member as { login: string };
      return {
        type: "github:member",
        title: `${action} ${member.login} to ${repo}`,
        content: null,
        tags: [`repo:${repo}`],
      };
    }

    case "PublicEvent":
      return {
        type: "github:public",
        title: `Made ${repo} public`,
        content: null,
        tags: [`repo:${repo}`],
      };

    case "GollumEvent": {
      const pages = payload.pages as Array<{ action: string; title: string }> | undefined;
      if (!pages || pages.length === 0) return null;
      return {
        type: "github:wiki",
        title: `Updated wiki in ${repo}`,
        content: pages.map((p) => `${p.action} ${p.title}`).join("\n"),
        tags: [`repo:${repo}`, "wiki"],
      };
    }

    default:
      // Unknown event type - skip
      return null;
  }
}

export interface GitHubSyncStats {
  events: number;
  stars: number;
  gists: number;
  skipped: number;
  identities: number;
}

// Fetch events with pagination
async function fetchEvents(
  config: GitHubConfig,
  sinceTimestamp?: string,
  cachedEtag?: string
): Promise<{ events: GitHubEvent[]; etag?: string }> {
  const allEvents: GitHubEvent[] = [];
  let page = 1;
  const perPage = 100;
  let etag: string | undefined;

  console.log(sinceTimestamp ? `Fetching events since ${sinceTimestamp}...` : "Fetching all events...");

  while (page <= 3) { // GitHub Events API only returns ~300 events max
    const result = await githubGet<GitHubEvent[]>(config, `/users/${config.username}/events`, {
      params: { page: String(page), per_page: String(perPage) },
      etag: page === 1 ? cachedEtag : undefined,
    });

    if (result.notModified) {
      console.log("No new events (304 Not Modified)");
      return { events: [], etag: cachedEtag };
    }

    if (page === 1) {
      etag = result.etag;
    }

    if (!result.data || result.data.length === 0) break;

    // Filter by timestamp if incremental sync
    if (sinceTimestamp) {
      const filtered = result.data.filter((e) => e.created_at > sinceTimestamp);
      allEvents.push(...filtered);
      if (filtered.length < result.data.length) break; // Hit old events
    } else {
      allEvents.push(...result.data);
    }

    if (result.data.length < perPage) break;
    page++;

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`Fetched ${allEvents.length} events`);
  return { events: allEvents, etag };
}

// Fetch stars with timestamps
async function fetchStars(
  config: GitHubConfig,
  sinceTimestamp?: string
): Promise<GitHubStar[]> {
  const allStars: GitHubStar[] = [];
  let page = 1;
  const perPage = 100;

  console.log(sinceTimestamp ? `Fetching stars since ${sinceTimestamp}...` : "Fetching all stars...");

  while (true) {
    const result = await githubGet<GitHubStar[]>(config, `/users/${config.username}/starred`, {
      params: { page: String(page), per_page: String(perPage) },
    });

    // Need special Accept header for starred_at timestamp
    const url = new URL(`${GITHUB_API_URL}/users/${config.username}/starred`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/vnd.github.star+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      console.error(`Stars API error: ${response.status}`);
      break;
    }

    const stars: GitHubStar[] = await response.json();
    if (stars.length === 0) break;

    // Filter by timestamp if incremental sync
    if (sinceTimestamp) {
      const filtered = stars.filter((s) => s.starred_at > sinceTimestamp);
      allStars.push(...filtered);
      if (filtered.length < stars.length) break;
    } else {
      allStars.push(...stars);
    }

    if (stars.length < perPage) break;
    page++;

    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`Fetched ${allStars.length} stars`);
  return allStars;
}

// Fetch gists
async function fetchGists(
  config: GitHubConfig,
  sinceTimestamp?: string
): Promise<GitHubGist[]> {
  const allGists: GitHubGist[] = [];
  let page = 1;
  const perPage = 100;

  console.log(sinceTimestamp ? `Fetching gists since ${sinceTimestamp}...` : "Fetching all gists...");

  while (true) {
    const result = await githubGet<GitHubGist[]>(config, "/gists", {
      params: { page: String(page), per_page: String(perPage) },
    });

    if (!result.data || result.data.length === 0) break;

    // Filter by timestamp (use created_at for new gists only)
    if (sinceTimestamp) {
      const filtered = result.data.filter((g) => g.created_at > sinceTimestamp);
      allGists.push(...filtered);
      if (filtered.length < result.data.length) break;
    } else {
      allGists.push(...result.data);
    }

    if (result.data.length < perPage) break;
    page++;

    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`Fetched ${allGists.length} gists`);
  return allGists;
}

export async function syncGitHub(
  sourceAccount?: string
): Promise<GitHubSyncStats> {
  const config = loadConfig();
  if (!config) {
    throw new Error("GitHub not configured. Add token to ~/.config/timeline/github.json");
  }

  sourceAccount = sourceAccount || config.username;
  console.log(`Syncing GitHub for ${sourceAccount}...`);

  const db = getDb();
  initDb(db);

  // Load sync state from app-state.db
  const appDb = getAppStateDb();
  let syncState = getSyncState<GitHubSyncState>(appDb, "github");

  // Migration: if no sync state in DB, check config file for existing last_sync
  if (!syncState) {
    try {
      const configContent = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      if (configContent.last_sync) {
        console.log("Migrating sync state from config file to database...");
        syncState = configContent.last_sync;
        setSyncState(appDb, "github", syncState);
      }
    } catch {
      // Ignore migration errors
    }
  }

  syncState = syncState || {};

  const stats: GitHubSyncStats = {
    events: 0,
    stars: 0,
    gists: 0,
    skipped: 0,
    identities: 0,
  };

  // Collect all identities for batch upsert
  const allIdentities: UpsertIdentityOptions[] = [];
  if (!sourceAccount) throw new Error("sourceAccount is required for GitHub sync");
  const userIdentifier = formatIdentifier("github", sourceAccount);

  const importBatch = `github-api-${sourceAccount}-${Date.now()}`;
  const sinceTimestamp = syncState.events_timestamp;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Sync events
  const { events, etag } = await fetchEvents(config, sinceTimestamp, syncState.events_etag);
  let latestTimestamp = sinceTimestamp;

  const insertEvents = db.transaction((eventsToInsert: GitHubEvent[]) => {
    for (const event of eventsToInsert) {
      // Track latest timestamp
      if (!latestTimestamp || event.created_at > latestTimestamp) {
        latestTimestamp = event.created_at;
      }

      const processed = processEvent(event, sourceAccount);
      if (!processed) {
        stats.skipped++;
        continue;
      }

      // Collect identity for actor
      if (event.actor?.login) {
        allIdentities.push({
          platform: "github",
          platformId: event.actor.login,
          username: event.actor.login,
          avatarUrl: event.actor.avatar_url,
        });
      }

      try {
        const result = insert.run(
          "github",
          `event:${event.id}`,
          sourceAccount,
          processed.type,
          event.created_at,
          processed.title,
          processed.content,
          JSON.stringify([userIdentifier]),
          JSON.stringify(processed.tags),
          JSON.stringify(event),
          importBatch
        );
        if (result.changes > 0) {
          stats.events++;
        } else {
          stats.skipped++;
        }
      } catch {
        stats.skipped++;
      }
    }
  });

  insertEvents(events);

  // Sync stars
  const stars = await fetchStars(config, syncState.stars_timestamp);
  let latestStarTimestamp = syncState.stars_timestamp;

  const insertStars = db.transaction((starsToInsert: GitHubStar[]) => {
    for (const star of starsToInsert) {
      if (!latestStarTimestamp || star.starred_at > latestStarTimestamp) {
        latestStarTimestamp = star.starred_at;
      }

      try {
        const result = insert.run(
          "github",
          `star:${star.repo.full_name}`,
          sourceAccount,
          "github:star",
          star.starred_at,
          `Starred ${star.repo.full_name}`,
          star.repo.description,
          JSON.stringify([userIdentifier]),
          JSON.stringify([`repo:${star.repo.full_name}`, star.repo.language].filter(Boolean)),
          JSON.stringify(star),
          importBatch
        );
        if (result.changes > 0) {
          stats.stars++;
        } else {
          stats.skipped++;
        }
      } catch {
        stats.skipped++;
      }
    }
  });

  insertStars(stars);

  // Sync gists
  const gists = await fetchGists(config, syncState.gists_timestamp);
  let latestGistTimestamp = syncState.gists_timestamp;

  const insertGists = db.transaction((gistsToInsert: GitHubGist[]) => {
    for (const gist of gistsToInsert) {
      if (!latestGistTimestamp || gist.created_at > latestGistTimestamp) {
        latestGistTimestamp = gist.created_at;
      }

      const files = Object.values(gist.files);
      const languages = [...new Set(files.map((f) => f.language).filter(Boolean))];

      try {
        const result = insert.run(
          "github",
          `gist:${gist.id}`,
          sourceAccount,
          "github:gist",
          gist.created_at,
          gist.description || `Gist with ${files.length} file(s)`,
          files.map((f) => f.filename).join(", "),
          JSON.stringify([userIdentifier]),
          JSON.stringify([...languages, gist.public ? "public" : "private"]),
          JSON.stringify(gist),
          importBatch
        );
        if (result.changes > 0) {
          stats.gists++;
        } else {
          stats.skipped++;
        }
      } catch {
        stats.skipped++;
      }
    }
  });

  insertGists(gists);

  // Batch upsert all collected identities
  if (allIdentities.length > 0) {
    // Deduplicate by platform:platformId, keeping the latest (most up-to-date profile info)
    const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
    for (const id of allIdentities) {
      const key = `${id.platform}:${id.platformId}`;
      uniqueIdentities.set(key, id);
    }
    upsertIdentities(db, [...uniqueIdentities.values()]);
    stats.identities = uniqueIdentities.size;
  }

  // Update sync state in app-state.db
  const newSyncState: GitHubSyncState = {
    events_etag: etag || syncState.events_etag,
    events_timestamp: latestTimestamp,
    stars_timestamp: latestStarTimestamp,
    gists_timestamp: latestGistTimestamp,
  };
  setSyncState(appDb, "github", newSyncState);

  console.log(`\nSync complete:`);
  console.log(`  Events: ${stats.events}`);
  console.log(`  Stars: ${stats.stars}`);
  console.log(`  Gists: ${stats.gists}`);
  console.log(`  Identities: ${stats.identities}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  db.close();
  return stats;
}

function showStatus(): void {
  const config = loadConfig();

  console.log("GitHub API Status");
  console.log("=".repeat(40));

  if (!config) {
    console.log("Not configured. Create ~/.config/timeline/github.json with:");
    console.log('  { "token": "github_pat_...", "username": "your-username" }');
    return;
  }

  console.log(`Username: ${config.username}`);
  console.log(`Token: ${config.token.substring(0, 20)}...`);
  if (config.token_expires) {
    const expires = new Date(config.token_expires);
    const daysLeft = Math.ceil((expires.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    console.log(`Expires: ${config.token_expires} (${daysLeft} days)`);
  }

  // Load sync state from app-state.db
  const appDb = getAppStateDb();
  let syncState = getSyncState<GitHubSyncState>(appDb, "github");

  // Migration: if no sync state in DB, check config file for existing last_sync
  if (!syncState) {
    try {
      const configContent = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      if (configContent.last_sync) {
        console.log("\nMigrating sync state from config file to database...");
        syncState = configContent.last_sync;
        setSyncState(appDb, "github", syncState);
      }
    } catch {
      // Ignore migration errors
    }
  }

  if (syncState) {
    console.log("\nLast sync:");
    if (syncState.events_timestamp) {
      console.log(`  Events: ${syncState.events_timestamp}`);
    }
    if (syncState.stars_timestamp) {
      console.log(`  Stars: ${syncState.stars_timestamp}`);
    }
    if (syncState.gists_timestamp) {
      console.log(`  Gists: ${syncState.gists_timestamp}`);
    }
  }
}

// CLI
if (import.meta.main) {
  const command = process.argv[2];

  if (command === "status") {
    showStatus();
  } else if (command === "test") {
    const config = loadConfig();
    if (!config) {
      console.error("Not configured. Create ~/.config/timeline/github.json with:");
      console.error('  { "token": "github_pat_...", "username": "your-username" }');
      process.exit(1);
    }

    console.log("Testing GitHub authentication...");
    const result = await githubGet<{ login: string; name: string | null }>(config, "/user");
    if (result.data) {
      console.log(`Authenticated as: ${result.data.login}${result.data.name ? ` (${result.data.name})` : ""}`);
    } else {
      console.error("Failed to authenticate");
      process.exit(1);
    }
  } else if (command === "help" || command === "-h" || command === "--help") {
    console.log(`GitHub API Parser

Usage:
  bun run src/parsers/github-api.ts              # Sync all GitHub activity
  bun run src/parsers/github-api.ts test         # Test PAT authentication
  bun run src/parsers/github-api.ts status       # Check config status
  bun run src/parsers/github-api.ts [username]   # Sync specific account

Requires ~/.config/timeline/github.json with PAT and username.
`);
  } else {
    const account = command || undefined;
    await syncGitHub(account);
  }
}
