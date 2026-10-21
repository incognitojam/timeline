import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseCSV } from "../lib/csv";
import { extractConversationId } from "../db/conversation-id";
import { runParser } from "../lib/parser-cli";
import { normalizeRedditParticipant } from "../lib/reddit";
import {
  upsertIdentities,
  type UpsertIdentityOptions,
} from "../db/queries";

// Convert Reddit's date format to ISO 8601
function toISO(dateStr: string): string | null {
  if (!dateStr) return null;
  // Reddit uses "2017-04-11 21:24:12 UTC"
  return dateStr.replace(" UTC", "Z").replace(" ", "T");
}

export async function importRedditData(
  db: Database,
  importPath: string,
  sourceAccount: string
) {
  const importBatch = `reddit-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Message rows are the only reddit rows with a conversation identity.
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, tags, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let stats = { posts: 0, comments: 0, messages: 0, votes: 0, skipped: 0, identitiesUpserted: 0 };

  // Collect identities for batch upsert
  const allIdentities: UpsertIdentityOptions[] = [];

  // Import posts
  const postsFile = Bun.file(join(importPath, "posts.csv"));
  if (await postsFile.exists()) {
    const posts = parseCSV(await postsFile.text());
    console.log(`Processing posts.csv: ${posts.length} entries`);

    for (const post of posts) {
      if (!post.id) continue;
      try {
        insert.run(
          "reddit",
          `post:${post.id}`,
          sourceAccount,
          "post",
          toISO(post.date),
          post.title || null,
          post.body || post.title || null,
          null,
          JSON.stringify([post.subreddit]),
          JSON.stringify(post),
          importBatch
        );
        stats.posts++;
      } catch {
        stats.skipped++;
      }
    }
  }

  // Import comments
  const commentsFile = Bun.file(join(importPath, "comments.csv"));
  if (await commentsFile.exists()) {
    const comments = parseCSV(await commentsFile.text());
    console.log(`Processing comments.csv: ${comments.length} entries`);

    for (const comment of comments) {
      if (!comment.id) continue;
      try {
        // Truncate body for title field
        const title = comment.body
          ? comment.body.slice(0, 100) + (comment.body.length > 100 ? "..." : "")
          : null;

        insert.run(
          "reddit",
          `comment:${comment.id}`,
          sourceAccount,
          "comment",
          toISO(comment.date),
          title,
          comment.body || null,
          null,
          JSON.stringify([comment.subreddit]),
          JSON.stringify(comment),
          importBatch
        );
        stats.comments++;
      } catch {
        stats.skipped++;
      }
    }
  }

  // Import messages
  const messagesFile = Bun.file(join(importPath, "messages_archive.csv"));
  if (await messagesFile.exists()) {
    const messages = parseCSV(await messagesFile.text());
    console.log(`Processing messages_archive.csv: ${messages.length} entries`);

    for (const msg of messages) {
      if (!msg.id) continue;
      try {
        const title = msg.subject || (msg.body ? msg.body.slice(0, 100) : null);

        // Build qualified identifiers for message participants
        const people: string[] = [];
        for (const username of [msg.from, msg.to]) {
          if (!username) continue;
          const normalized = normalizeRedditParticipant(username);
          if (!normalized) continue;
          people.push(normalized.identifier);

          // Collect identity for batch upsert
          allIdentities.push({
            platform: "reddit",
            platformId: normalized.platformId,
            displayName: normalized.displayName,
            username: normalized.platformId,
          });
        }

        insertMessage.run(
          "reddit",
          `message:${msg.id}`,
          sourceAccount,
          "message",
          toISO(msg.date),
          title,
          msg.body || null,
          people.length > 0 ? JSON.stringify(people) : null,
          null,
          JSON.stringify(msg),
          importBatch,
          // Derived from the same object persisted to raw_data, so this
          // matches what extractConversationId reads back off the row.
          extractConversationId("reddit", msg)
        );
        stats.messages++;
      } catch {
        stats.skipped++;
      }
    }
  }

  // Import comment votes (no timestamps)
  const commentVotesFile = Bun.file(join(importPath, "comment_votes.csv"));
  if (await commentVotesFile.exists()) {
    const votes = parseCSV(await commentVotesFile.text());
    console.log(`Processing comment_votes.csv: ${votes.length} entries`);

    for (const vote of votes) {
      if (!vote.id) continue;
      try {
        insert.run(
          "reddit",
          `vote:comment:${vote.id}`,
          sourceAccount,
          vote.direction === "up" ? "vote:up" : "vote:down",
          null, // No timestamp for votes
          null,
          vote.permalink || null,
          null,
          null,
          JSON.stringify(vote),
          importBatch
        );
        stats.votes++;
      } catch {
        stats.skipped++;
      }
    }
  }

  // Import post votes (no timestamps)
  const postVotesFile = Bun.file(join(importPath, "post_votes.csv"));
  if (await postVotesFile.exists()) {
    const votes = parseCSV(await postVotesFile.text());
    console.log(`Processing post_votes.csv: ${votes.length} entries`);

    for (const vote of votes) {
      if (!vote.id) continue;
      try {
        insert.run(
          "reddit",
          `vote:post:${vote.id}`,
          sourceAccount,
          vote.direction === "up" ? "vote:up" : "vote:down",
          null, // No timestamp for votes
          null,
          vote.permalink || null,
          null,
          null,
          JSON.stringify(vote),
          importBatch
        );
        stats.votes++;
      } catch {
        stats.skipped++;
      }
    }
  }

  // Import saved posts (no timestamps)
  const savedFile = Bun.file(join(importPath, "saved_posts.csv"));
  if (await savedFile.exists()) {
    const saved = parseCSV(await savedFile.text());
    console.log(`Processing saved_posts.csv: ${saved.length} entries`);

    for (const item of saved) {
      if (!item.id) continue;
      try {
        insert.run(
          "reddit",
          `saved:${item.id}`,
          sourceAccount,
          "save",
          null,
          null,
          item.permalink || null,
          null,
          null,
          JSON.stringify(item),
          importBatch
        );
        stats.votes++; // Counting with votes since both are dateless
      } catch {
        stats.skipped++;
      }
    }
  }

  // Batch upsert all collected identities
  if (allIdentities.length > 0) {
    // Deduplicate by platformId
    const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
    for (const id of allIdentities) {
      uniqueIdentities.set(id.platformId, id);
    }
    upsertIdentities(db, [...uniqueIdentities.values()]);
    stats.identitiesUpserted = uniqueIdentities.size;
  }

  console.log(`\nImport complete:`);
  console.log(`  Posts: ${stats.posts}`);
  console.log(`  Comments: ${stats.comments}`);
  console.log(`  Messages: ${stats.messages}`);
  console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Votes/Saves: ${stats.votes}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  return stats.posts + stats.comments + stats.messages + stats.votes;
}

// CLI
if (import.meta.main) {
  runParser(importRedditData, {
    name: "reddit",
    examples: ["bun run src/parsers/reddit.ts ./imports/reddit my-account"],
  });
}
