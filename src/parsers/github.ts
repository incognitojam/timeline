import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getDb, initDb } from "../db/schema";
import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";

interface GitHubIssue {
  type: "issue";
  url: string;
  repository: string;
  user: string;
  title: string;
  body: string;
  created_at: string;
  closed_at?: string;
}

interface GitHubIssueComment {
  type: "issue_comment";
  url: string;
  issue?: string;
  pull_request?: string;
  user: string;
  body: string;
  created_at: string;
}

interface GitHubPullRequest {
  type: "pull_request";
  url: string;
  repository: string;
  user: string;
  title: string;
  body: string;
  created_at: string;
  merged_at?: string;
  closed_at?: string;
}

interface GitHubPullRequestReview {
  type: "pull_request_review";
  url: string;
  pull_request: string;
  user: string;
  body: string;
  state: number;
  created_at: string;
  submitted_at?: string;
}

interface GitHubCommitComment {
  type: "commit_comment";
  url: string;
  repository: string;
  user: string;
  body: string;
  commit_id: string;
  created_at: string;
}

type GitHubItem = GitHubIssue | GitHubIssueComment | GitHubPullRequest | GitHubPullRequestReview | GitHubCommitComment;

function extractUsername(userUrl: string): string {
  // "https://github.com/example-user" -> "example-user"
  return userUrl.split("/").pop() || "";
}

function extractRepoName(repoUrl: string): string {
  // "https://github.com/example-user/example-repo" -> "example-user/example-repo"
  const parts = repoUrl.split("github.com/");
  return parts[1] || repoUrl;
}

function truncate(text: string, maxLen: number): string {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

async function loadJsonFiles<T>(dir: string, prefix: string): Promise<T[]> {
  const files = await readdir(dir);
  const items: T[] = [];

  for (const file of files.filter(f => f.startsWith(prefix) && f.endsWith(".json"))) {
    const data: T[] = await Bun.file(join(dir, file)).json();
    items.push(...data);
  }

  return items;
}

async function importGitHubData(
  db: Database,
  importPath: string,
  sourceAccount: string
) {
  const importBatch = `github-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalImported = 0;
  let totalSkipped = 0;
  const typeCounts: Record<string, number> = {};

  // Collect all identities for batch upsert
  const allIdentities: UpsertIdentityOptions[] = [];

  const userUrl = `https://github.com/${sourceAccount}`;
  const userIdentifier = formatIdentifier("github", sourceAccount);

  // Add the current user's identity
  allIdentities.push({
    platform: "github",
    platformId: sourceAccount,
    username: sourceAccount,
  });

  // Load all data types
  const issues = await loadJsonFiles<GitHubIssue>(importPath, "issues_");
  const issueComments = await loadJsonFiles<GitHubIssueComment>(importPath, "issue_comments_");
  const pullRequests = await loadJsonFiles<GitHubPullRequest>(importPath, "pull_requests_");
  const prReviews = await loadJsonFiles<GitHubPullRequestReview>(importPath, "pull_request_reviews_");
  const commitComments = await loadJsonFiles<GitHubCommitComment>(importPath, "commit_comments_");

  console.log(`Loaded: ${issues.length} issues, ${issueComments.length} issue comments, ${pullRequests.length} PRs, ${prReviews.length} PR reviews, ${commitComments.length} commit comments`);

  const insertItem = (item: GitHubItem, eventType: string, title: string, content: string, tags: string[], people: string[] | null) => {
    const sourceId = item.url;
    const timestamp = item.created_at;

    try {
      insert.run(
        "github",
        sourceId,
        sourceAccount,
        eventType,
        timestamp,
        title,
        content,
        people ? JSON.stringify(people) : null,
        JSON.stringify(tags),
        JSON.stringify(item),
        importBatch
      );
      totalImported++;
      typeCounts[eventType] = (typeCounts[eventType] || 0) + 1;
    } catch {
      totalSkipped++;
    }
  };

  const insertMany = db.transaction(() => {
    // Issues (only created by user)
    for (const issue of issues) {
      if (issue.user !== userUrl) continue;
      const repo = extractRepoName(issue.repository);
      insertItem(
        issue,
        "github:issue",
        `Issue: ${issue.title}`,
        truncate(issue.body, 500),
        ["issue", `repo:${repo}`],
        [userIdentifier]
      );
    }

    // Issue comments (only by user)
    for (const comment of issueComments) {
      if (comment.user !== userUrl) continue;
      const target = comment.issue || comment.pull_request;
      if (!target) continue;
      const num = target.split("/").pop() || "";
      const repoMatch = target.match(/github\.com\/([^/]+\/[^/]+)/);
      const repo = repoMatch ? repoMatch[1] : "";
      const isPR = !!comment.pull_request;
      insertItem(
        comment,
        "github:issue_comment",
        `Comment on ${isPR ? "PR" : "issue"} #${num}`,
        truncate(comment.body, 500),
        ["comment", isPR ? "pull-request" : "issue", `repo:${repo}`],
        [userIdentifier]
      );
    }

    // Pull requests (only created by user, exclude bots)
    for (const pr of pullRequests) {
      if (pr.user !== userUrl) continue;
      const repo = extractRepoName(pr.repository);
      const tags = ["pull-request", `repo:${repo}`];
      if (pr.merged_at) tags.push("merged");
      insertItem(
        pr,
        "github:pull_request",
        `PR: ${pr.title}`,
        truncate(pr.body, 500),
        tags,
        [userIdentifier]
      );
    }

    // PR reviews (only by user)
    for (const review of prReviews) {
      if (review.user !== userUrl) continue;
      const prNum = review.pull_request.split("/").pop() || "";
      const repoMatch = review.pull_request.match(/github\.com\/([^/]+\/[^/]+)/);
      const repo = repoMatch ? repoMatch[1] : "";
      insertItem(
        review,
        "github:pr_review",
        `Review on PR #${prNum}`,
        truncate(review.body, 500),
        ["review", "pull-request", `repo:${repo}`],
        [userIdentifier]
      );
    }

    // Commit comments (only by user)
    for (const comment of commitComments) {
      if (comment.user !== userUrl) continue;
      const repo = extractRepoName(comment.repository);
      const shortSha = comment.commit_id.slice(0, 7);
      insertItem(
        comment,
        "github:commit_comment",
        `Comment on ${shortSha}`,
        truncate(comment.body, 500),
        ["comment", "commit", `repo:${repo}`],
        [userIdentifier]
      );
    }
  });

  insertMany();

  // Batch upsert all collected identities
  let identitiesUpserted = 0;
  if (allIdentities.length > 0) {
    // Deduplicate by platform:platformId
    const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
    for (const id of allIdentities) {
      const key = `${id.platform}:${id.platformId}`;
      if (!uniqueIdentities.has(key)) {
        uniqueIdentities.set(key, id);
      }
    }
    upsertIdentities(db, [...uniqueIdentities.values()]);
    identitiesUpserted = uniqueIdentities.size;
  }

  onImportComplete(db);

  // Get date range
  const dateRange = db
    .query(
      `
    SELECT MIN(timestamp) as min_date, MAX(timestamp) as max_date
    FROM events WHERE source = 'github' AND import_batch = ?
  `
    )
    .get(importBatch) as { min_date: string; max_date: string } | null;

  console.log(`\nImport complete:`);
  console.log(`  Total imported: ${totalImported}`);
  console.log(`  Identities: ${identitiesUpserted}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`  By type:`, typeCounts);
  if (dateRange?.min_date) {
    console.log(
      `  Date range: ${dateRange.min_date.split("T")[0]} to ${dateRange.max_date.split("T")[0]}`
    );
  }
  console.log(`  Batch ID: ${importBatch}`);
}

// CLI
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("Usage: bun run src/parsers/github.ts <import-path> [username]");
  console.log("");
  console.log("Import path should be the extracted GitHub export folder containing:");
  console.log("  - issues_*.json, issue_comments_*.json");
  console.log("  - pull_requests_*.json, pull_request_reviews_*.json");
  console.log("  - commit_comments_*.json");
  console.log("");
  console.log("Example: bun run src/parsers/github.ts /tmp/github-export example-user");
  process.exit(1);
}

const importPath = args[0];
const accountName = args[1] || "default";

console.log(`Importing GitHub data from ${importPath}`);
console.log(`Account: ${accountName}\n`);

const db = getDb();
initDb(db);

await importGitHubData(db, importPath, accountName);

db.close();
