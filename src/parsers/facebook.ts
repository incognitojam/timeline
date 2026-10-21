import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getDb, initDb } from "../db/schema";
import { extractConversationId } from "../db/conversation-id";
import {
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";
import { insertPendingAttachment } from "../media/attachments";

// Facebook encodes text as latin1 bytes but labels it UTF-8
// This decodes the mangled text back to proper UTF-8
function decodeFacebookText(text: string | undefined): string | null {
  if (!text) return null;
  try {
    const bytes = new Uint8Array(text.split("").map((c) => c.charCodeAt(0)));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return text;
  }
}

function toISOTimestamp(ts: number | undefined): string | null {
  if (!ts || ts < 1000000000) return null; // Invalid or placeholder timestamp
  // Facebook uses seconds, not milliseconds for most non-message data
  const ms = ts < 10000000000 ? ts * 1000 : ts;
  return new Date(ms).toISOString();
}

interface Stats {
  messages: number;
  calls: number;
  photos: number;
  videos: number;
  shares: number;
  polls: number;
  posts: number;
  comments: number;
  reactions: number;
  groups: number;
  events: number;
  friends: number;
  pokes: number;
  other: number;
  skipped: number;
  skippedDegraded: number;
  conversations: number;
  attachments: number;
  identities: number;
}

export async function importFacebookData(
  db: Database,
  importPath: string,
  sourceAccount: string
) {
  const importBatch = `facebook-${sourceAccount}-${Date.now()}`;

  // RETURNING id is required for the message importer, which needs the
  // resulting event id to attach attachments. result.lastInsertRowid is
  // unreliable after ON CONFLICT DO UPDATE — SQLite does not advance it on
  // UPDATE, so attachments would silently link to a previously-inserted row.
  const insert = db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp,
      duration_ms, title, content, people, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id, source_account) DO UPDATE SET
      type = excluded.type,
      content = excluded.content,
      title = excluded.title,
      duration_ms = excluded.duration_ms,
      people = excluded.people,
      tags = excluded.tags,
      raw_data = excluded.raw_data,
      import_batch = excluded.import_batch
    RETURNING id
  `);

  const stats: Stats = {
    messages: 0, calls: 0, photos: 0, videos: 0, shares: 0, polls: 0,
    posts: 0, comments: 0, reactions: 0, groups: 0, events: 0,
    friends: 0, pokes: 0, other: 0, skipped: 0, skippedDegraded: 0,
    conversations: 0, attachments: 0, identities: 0,
  };

  // Collect all identities for batch upsert
  const allIdentities: UpsertIdentityOptions[] = [];

  // Determine base path for activity data
  let activityPath = join(importPath, "your_facebook_activity");
  try {
    await readdir(activityPath);
  } catch {
    activityPath = importPath; // Old format
  }

  // ============ MESSAGES ============
  console.log("Importing messages...");
  await importMessages(db, importPath, sourceAccount, importBatch, stats, allIdentities);

  // ============ POSTS ============
  console.log("Importing posts...");
  await importPosts(db, insert, activityPath, sourceAccount, importBatch, stats);

  // ============ COMMENTS ============
  console.log("Importing comments...");
  await importComments(db, insert, activityPath, sourceAccount, importBatch, stats);

  // ============ REACTIONS ============
  console.log("Importing reactions...");
  await importReactions(db, insert, activityPath, sourceAccount, importBatch, stats);

  // ============ GROUPS ============
  console.log("Importing group activity...");
  await importGroups(db, insert, activityPath, sourceAccount, importBatch, stats);

  // ============ EVENTS ============
  console.log("Importing events...");
  await importEvents(db, insert, activityPath, sourceAccount, importBatch, stats);

  // ============ FRIENDS ============
  console.log("Importing friends...");
  await importFriends(db, insert, importPath, sourceAccount, importBatch, stats, allIdentities);

  // ============ POKES ============
  console.log("Importing pokes...");
  await importPokes(db, insert, activityPath, sourceAccount, importBatch, stats, allIdentities);

  // Batch upsert all collected identities
  if (allIdentities.length > 0) {
    // Deduplicate by platform:platformId
    const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
    for (const id of allIdentities) {
      const key = `${id.platform}:${id.platformId}`;
      // Prefer entries with display name
      if (!uniqueIdentities.has(key) || (id.displayName && !uniqueIdentities.get(key)?.displayName)) {
        uniqueIdentities.set(key, id);
      }
    }
    upsertIdentities(db, [...uniqueIdentities.values()]);
    stats.identities = uniqueIdentities.size;
  }

  // Print summary
  console.log(`\n${"=".repeat(50)}`);
  console.log("Import complete:");
  console.log(`  Messages: ${stats.messages.toLocaleString()}`);
  console.log(`  Calls: ${stats.calls}`);
  console.log(`  Photos: ${stats.photos}`);
  console.log(`  Videos: ${stats.videos}`);
  console.log(`  Attachments: ${stats.attachments}`);
  console.log(`  Shares: ${stats.shares}`);
  console.log(`  Polls: ${stats.polls}`);
  console.log(`  Posts: ${stats.posts}`);
  console.log(`  Comments: ${stats.comments}`);
  console.log(`  Reactions: ${stats.reactions}`);
  console.log(`  Group activity: ${stats.groups}`);
  console.log(`  Events: ${stats.events}`);
  console.log(`  Friends: ${stats.friends}`);
  console.log(`  Pokes: ${stats.pokes}`);
  console.log(`  Identities: ${stats.identities}`);
  console.log(`  Other: ${stats.other}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Skipped (deleted accounts): ${stats.skippedDegraded}`);
  console.log(`  Batch ID: ${importBatch}`);

  // Return total events imported for sync_log tracking
  const totalImported = stats.messages + stats.calls + stats.photos + stats.videos +
    stats.shares + stats.polls + stats.posts + stats.comments + stats.reactions +
    stats.groups + stats.events + stats.friends + stats.pokes + stats.other;
  return totalImported;
}

/**
 * Get MIME type from filename
 */
function getMimeType(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop();
  const mimeTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    aac: "audio/aac",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    zip: "application/zip",
    txt: "text/plain",
  };
  return mimeTypes[ext || ""] ?? null;
}

// ============ MESSAGE IMPORT ============
async function importMessages(
  db: Database,
  importPath: string,
  sourceAccount: string,
  importBatch: string,
  stats: Stats,
  allIdentities: UpsertIdentityOptions[]
) {
  // Message rows are the only facebook rows with a conversation identity;
  // the other importers share the plain upsert without the column. Same
  // upsert shape as importFacebookData's (RETURNING id for attachments),
  // and a reimport refreshes conversation_id along with raw_data.
  const insert = db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp,
      duration_ms, title, content, people, tags, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id, source_account) DO UPDATE SET
      type = excluded.type,
      content = excluded.content,
      title = excluded.title,
      duration_ms = excluded.duration_ms,
      people = excluded.people,
      tags = excluded.tags,
      raw_data = excluded.raw_data,
      import_batch = excluded.import_batch,
      conversation_id = excluded.conversation_id
    RETURNING id
  `);
  let messagesDir = join(importPath, "your_facebook_activity", "messages");
  try {
    await readdir(join(messagesDir, "inbox"));
  } catch {
    messagesDir = join(importPath, "messages");
  }

  const categories = ["inbox", "archived_threads", "filtered_threads", "message_requests", "e2ee_cutover"];

  for (const category of categories) {
    const categoryPath = join(messagesDir, category);
    let conversations: string[];
    try {
      conversations = await readdir(categoryPath);
    } catch {
      continue;
    }

    for (const convDir of conversations) {
      const convPath = join(categoryPath, convDir);
      let files: string[];
      try {
        files = (await readdir(convPath)).filter(
          (f) => f.startsWith("message_") && f.endsWith(".json")
        );
      } catch {
        continue;
      }

      if (files.length === 0) continue;

      // Sort files by number: ascending for processing (newest batches first = monotonically decreasing timestamps)
      // Facebook exports: message_1.json = newest, higher numbers = older
      const fileInfos = files
        .map((f) => ({
          path: join(convPath, f),
          num: parseInt(f.match(/message_(\d+)\.json/)?.[1] || "0"),
        }))
        .sort((a, b) => a.num - b.num);

      // Pre-load every message_*.json so we can build a complete participant
      // set before insert. Facebook's export sometimes ships data.participants
      // empty or partial (when others left or accounts were deleted), but the
      // sender_name on each message is reliable — union the two for full coverage.
      const fileData: any[] = [];
      for (const fileInfo of fileInfos) {
        try {
          fileData.push(await Bun.file(fileInfo.path).json());
        } catch {
          fileData.push(null);
        }
      }

      // Get convFirstTs from oldest message (highest numbered file, last message in array)
      const oldestFileData = fileData[fileData.length - 1];
      if (!oldestFileData) continue;
      const convFirstTs = oldestFileData.messages?.at(-1)?.timestamp_ms;
      if (!convFirstTs) continue; // Empty conversation

      stats.conversations++;

      // Pick first non-null file for conversation metadata
      const firstData = fileData.find((d) => d) ?? null;
      if (!firstData) continue;

      const conversationTitle: string = decodeFacebookText(firstData.title) || convDir;
      const threadType: string | null = firstData.thread_type ?? null;
      // The export's stable thread folder. Every observed export era carries
      // thread_path in the JSON; synthesize the same shape from the on-disk
      // location if one ever omits it.
      const threadPath: string =
        typeof firstData.thread_path === "string" && firstData.thread_path !== ""
          ? firstData.thread_path
          : `${category}/${convDir}`;

      // Preserve the export's participant list verbatim for raw_data (decoded
      // names from the first non-null file).
      const participants: string[] = (firstData.participants || [])
        .map((p: any) => decodeFacebookText(p.name) || p.name)
        .filter((n: string | null): n is string => Boolean(n));

      // Build the full participant set for the people column: union of
      // data.participants from all files and every msg.sender_name. Facebook's
      // export sometimes ships participants empty or partial (when others left
      // or accounts were deleted); senders fill in the rest.
      const participantNames = new Set<string>();
      for (const data of fileData) {
        if (!data) continue;
        for (const p of data.participants || []) {
          const name = decodeFacebookText(p.name) || p.name;
          if (name) participantNames.add(name);
        }
        for (const msg of data.messages || []) {
          const name = decodeFacebookText(msg.sender_name) || msg.sender_name;
          if (name) participantNames.add(name);
        }
      }

      const participantIdentifiers: string[] = [];
      for (const name of participantNames) {
        const identifier = formatIdentifier("facebook", `name:${name}`);
        participantIdentifiers.push(identifier);
        allIdentities.push({
          platform: "facebook",
          platformId: `name:${name}`,
          displayName: name,
        });
      }

      // Track timestamp and index for stable source_id generation
      let lastTimestampMs = Infinity;
      let idx = 0;

      // Wrap each conversation in a transaction for atomicity
      db.exec("BEGIN");
      try {
        for (let i = 0; i < fileInfos.length; i++) {
          const data = fileData[i];
          if (!data) continue;

          for (const msg of data.messages || []) {
            const senderName = decodeFacebookText(msg.sender_name) || msg.sender_name;

            // Skip messages from deleted accounts to preserve existing data
            if (!senderName) {
              stats.skippedDegraded++;
              continue;
            }

            // Calculate stable idx for same-timestamp messages
            // Messages are processed in monotonically decreasing timestamp order
            if (msg.timestamp_ms < lastTimestampMs) {
              lastTimestampMs = msg.timestamp_ms;
              idx = 0;
            } else if (msg.timestamp_ms === lastTimestampMs) {
              idx += 1;
            } else {
              // Timestamp increased unexpectedly - this violates our assumption about file ordering
              throw new Error(
                `Unexpected timestamp order in ${convDir}: ${msg.timestamp_ms} > ${lastTimestampMs}. ` +
                `Facebook export format may have changed.`
              );
            }

            const timestamp = new Date(msg.timestamp_ms).toISOString();
            // Stable source_id: uses convFirstTs (oldest message timestamp) instead of convDir
            const messageId = `msg:${convFirstTs}:${msg.timestamp_ms}:${idx}`;

            // Build people array with sender first using platform identifiers
            const senderIdentifier = formatIdentifier("facebook", `name:${senderName}`);
            const people = [senderIdentifier, ...participantIdentifiers.filter((p) => p !== senderIdentifier)];

            let eventType = "message";
            let title: string | null = null;
            let content: string | null = null;
            let duration: number | null = null;

            // Always use conversationTitle as title, message text as content
            title = conversationTitle;

            if (msg.call_duration !== undefined) {
              eventType = "message:call";
              duration = msg.call_duration * 1000;
              content = `${Math.floor(msg.call_duration / 60)}m ${msg.call_duration % 60}s call`;
              stats.calls++;
            } else if (msg.photos?.length > 0) {
              eventType = "message:photo";
              content = decodeFacebookText(msg.content) || "[photo]";
              stats.photos++;
            } else if (msg.videos?.length > 0) {
              eventType = "message:video";
              content = decodeFacebookText(msg.content) || "[video]";
              stats.videos++;
            } else if (msg.share) {
              eventType = "message:share";
              content = decodeFacebookText(msg.content) || msg.share.link || decodeFacebookText(msg.share.share_text) || "[shared link]";
              stats.shares++;
            } else if (msg.sticker) {
              eventType = "message:sticker";
              content = "[sticker]";
              stats.messages++;
            } else if (msg.gifs?.length > 0) {
              eventType = "message:gif";
              content = decodeFacebookText(msg.content) || "[gif]";
              stats.messages++;
            } else if (msg.audio_files?.length > 0) {
              eventType = "message:audio";
              content = "[voice message]";
              stats.messages++;
            } else if (msg.is_unsent) {
              eventType = "message:unsent";
              content = "[unsent message]";
              stats.messages++;
            } else if (msg.content === "This poll is no longer available.") {
              eventType = "message:poll";
              content = "[poll data not exported by Facebook]";
              stats.polls++;
            } else {
              content = decodeFacebookText(msg.content);
              stats.messages++;
            }

            const rawData = {
              ...msg,
              sender_name: senderName,
              content: decodeFacebookText(msg.content),
              conversation: {
                title: conversationTitle,
                participants,
                thread_type: threadType,
                category,
                thread_path: threadPath,
                first_message_ts: convFirstTs,
              },
            };
            if (msg.reactions) {
              rawData.reactions = msg.reactions.map((r: any) => ({
                reaction: decodeFacebookText(r.reaction),
                actor: decodeFacebookText(r.actor),
              }));
            }

            try {
              const row = insert.get(
                "facebook", messageId, sourceAccount, eventType, timestamp, duration,
                title, content,
                JSON.stringify(people),
                JSON.stringify([conversationTitle]),
                JSON.stringify(rawData), importBatch,
                // Derived from the same object persisted to raw_data, so this
                // matches what extractConversationId reads back off the row.
                extractConversationId("facebook", rawData)
              ) as { id: number } | undefined;

              // RETURNING id yields the actual row id for both INSERT and the
              // ON CONFLICT DO UPDATE path, so attachments always bind to the
              // right event.
              if (row) {
                const eventId = row.id;

                // Collect all attachments from the message
                const attachments: { uri: string; type: string }[] = [];
                if (msg.photos) {
                  for (const photo of msg.photos) {
                    if (photo.uri) attachments.push({ uri: photo.uri, type: "photo" });
                  }
                }
                if (msg.videos) {
                  for (const video of msg.videos) {
                    if (video.uri) attachments.push({ uri: video.uri, type: "video" });
                  }
                }
                if (msg.gifs) {
                  for (const gif of msg.gifs) {
                    if (gif.uri) attachments.push({ uri: gif.uri, type: "gif" });
                  }
                }
                if (msg.audio_files) {
                  for (const audio of msg.audio_files) {
                    if (audio.uri) attachments.push({ uri: audio.uri, type: "audio" });
                  }
                }
                if (msg.sticker?.uri) {
                  attachments.push({ uri: msg.sticker.uri, type: "sticker" });
                }
                if (msg.files) {
                  for (const file of msg.files) {
                    if (file.uri) attachments.push({ uri: file.uri, type: "file" });
                  }
                }

                // Insert each attachment
                for (const attachment of attachments) {
                  const filename = attachment.uri.split("/").pop() || attachment.uri;
                  const mimeType = getMimeType(filename);

                  try {
                    insertPendingAttachment(db, {
                      eventId,
                      source: "facebook",
                      sourceId: filename,
                      filename,
                      mimeType,
                      originalUri: attachment.uri,
                    });
                    stats.attachments++;
                  } catch {
                    // Duplicate attachment, skip
                  }
                }
              }
            } catch {
              stats.skipped++;
            }
          }
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }
  console.log(`  ${stats.conversations} conversations, ${stats.messages.toLocaleString()}+ messages`);
}

// ============ POSTS IMPORT ============
async function importPosts(
  db: Database,
  insert: any,
  activityPath: string,
  sourceAccount: string,
  importBatch: string,
  stats: Stats
) {
  const postsDir = join(activityPath, "posts");

  // Your posts
  const yourPostsFile = join(postsDir, "your_posts__check_ins__photos_and_videos_1.json");
  try {
    const posts: any[] = await Bun.file(yourPostsFile).json();
    for (const post of posts) {
      const timestamp = toISOTimestamp(post.timestamp);
      const title = decodeFacebookText(post.title) || "Post";
      let content: string | null = null;

      // Extract post content from data array
      if (post.data) {
        for (const d of post.data) {
          if (d.post) content = decodeFacebookText(d.post);
        }
      }

      const postId = `post:${post.timestamp}:${title.slice(0, 30)}`;

      try {
        insert.run(
          "facebook", postId, sourceAccount, "post", timestamp, null,
          title, content, null, null, JSON.stringify(post), importBatch
        );
        stats.posts++;
      } catch {
        stats.skipped++;
      }
    }
  } catch {}

  // Posts on other pages
  const otherPostsFile = join(postsDir, "posts_on_other_pages_and_profiles.json");
  try {
    const data = await Bun.file(otherPostsFile).json();
    const posts = Array.isArray(data) ? data : data.other_posts_v2 || [];
    for (const post of posts) {
      const timestamp = toISOTimestamp(post.timestamp);
      const title = decodeFacebookText(post.title) || "Post on page";
      let content: string | null = null;

      if (post.data) {
        for (const d of post.data) {
          if (d.post) content = decodeFacebookText(d.post);
        }
      }

      const postId = `post:other:${post.timestamp}:${title.slice(0, 30)}`;

      try {
        insert.run(
          "facebook", postId, sourceAccount, "post:page", timestamp, null,
          title, content, null, null, JSON.stringify(post), importBatch
        );
        stats.posts++;
      } catch {
        stats.skipped++;
      }
    }
  } catch {}

  console.log(`  ${stats.posts} posts`);
}

// ============ COMMENTS IMPORT ============
async function importComments(
  db: Database,
  insert: any,
  activityPath: string,
  sourceAccount: string,
  importBatch: string,
  stats: Stats
) {
  const commentsFile = join(activityPath, "comments_and_reactions", "comments.json");
  try {
    const data = await Bun.file(commentsFile).json();
    const comments = data.comments_v2 || [];

    for (const comment of comments) {
      const timestamp = toISOTimestamp(comment.timestamp);
      const title = decodeFacebookText(comment.title) || "Comment";
      let content: string | null = null;

      if (comment.data) {
        for (const d of comment.data) {
          if (d.comment?.comment) content = decodeFacebookText(d.comment.comment);
        }
      }

      const commentId = `comment:${comment.timestamp}:${title.slice(0, 30)}`;

      try {
        insert.run(
          "facebook", commentId, sourceAccount, "comment", timestamp, null,
          title, content, null, null, JSON.stringify(comment), importBatch
        );
        stats.comments++;
      } catch {
        stats.skipped++;
      }
    }
  } catch {}

  console.log(`  ${stats.comments} comments`);
}

// ============ REACTIONS IMPORT ============
async function importReactions(
  db: Database,
  insert: any,
  activityPath: string,
  sourceAccount: string,
  importBatch: string,
  stats: Stats
) {
  const reactionsDir = join(activityPath, "comments_and_reactions");
  let files: string[];
  try {
    files = (await readdir(reactionsDir)).filter((f) => f.startsWith("likes_and_reactions"));
  } catch {
    return;
  }

  for (const file of files) {
    try {
      const data = await Bun.file(join(reactionsDir, file)).json();
      const reactions = Array.isArray(data) ? data : data.reactions_v2 || [];

      for (const reaction of reactions) {
        const timestamp = toISOTimestamp(reaction.timestamp);
        const title = decodeFacebookText(reaction.title) || "Reaction";
        let reactionType = "LIKE";

        if (reaction.data) {
          for (const d of reaction.data) {
            if (d.reaction?.reaction) reactionType = d.reaction.reaction;
          }
        }

        const reactionId = `reaction:${reaction.timestamp || Date.now()}:${stats.reactions}`;

        try {
          insert.run(
            "facebook", reactionId, sourceAccount, `reaction:${reactionType.toLowerCase()}`,
            timestamp, null, title, null, null, null, JSON.stringify(reaction), importBatch
          );
          stats.reactions++;
        } catch {
          stats.skipped++;
        }
      }
    } catch {}
  }

  console.log(`  ${stats.reactions} reactions`);
}

// ============ GROUPS IMPORT ============
async function importGroups(
  db: Database,
  insert: any,
  activityPath: string,
  sourceAccount: string,
  importBatch: string,
  stats: Stats
) {
  const groupsDir = join(activityPath, "groups");

  // Group posts and comments
  const groupPostsFile = join(groupsDir, "group_posts_and_comments.json");
  try {
    const data = await Bun.file(groupPostsFile).json();
    const items = data.group_posts_v2 || [];

    for (const item of items) {
      const timestamp = toISOTimestamp(item.timestamp);
      const title = decodeFacebookText(item.title) || "Group post";
      let content: string | null = null;

      if (item.data) {
        for (const d of item.data) {
          if (d.post) content = decodeFacebookText(d.post);
          if (d.comment?.comment) content = decodeFacebookText(d.comment.comment);
        }
      }

      const itemId = `group:post:${item.timestamp}:${stats.groups}`;

      try {
        insert.run(
          "facebook", itemId, sourceAccount, "group:post", timestamp, null,
          title, content, null, null, JSON.stringify(item), importBatch
        );
        stats.groups++;
      } catch {
        stats.skipped++;
      }
    }
  } catch {}

  // Group comments
  const groupCommentsFile = join(groupsDir, "your_comments_in_groups.json");
  try {
    const data = await Bun.file(groupCommentsFile).json();
    const items = data.group_comments_v2 || [];

    for (const item of items) {
      const timestamp = toISOTimestamp(item.timestamp);
      const title = decodeFacebookText(item.title) || "Group comment";
      let content: string | null = null;

      if (item.data) {
        for (const d of item.data) {
          if (d.comment?.comment) content = decodeFacebookText(d.comment.comment);
        }
      }

      const itemId = `group:comment:${item.timestamp}:${stats.groups}`;

      try {
        insert.run(
          "facebook", itemId, sourceAccount, "group:comment", timestamp, null,
          title, content, null, null, JSON.stringify(item), importBatch
        );
        stats.groups++;
      } catch {
        stats.skipped++;
      }
    }
  } catch {}

  // Group membership activity
  const membershipFile = join(groupsDir, "your_group_membership_activity.json");
  try {
    const data = await Bun.file(membershipFile).json();
    const items = data.groups_joined_v2 || [];

    for (const item of items) {
      const timestamp = toISOTimestamp(item.timestamp);
      const title = decodeFacebookText(item.title) || "Joined group";

      const itemId = `group:join:${item.timestamp}:${stats.groups}`;

      try {
        insert.run(
          "facebook", itemId, sourceAccount, "group:join", timestamp, null,
          title, null, null, null, JSON.stringify(item), importBatch
        );
        stats.groups++;
      } catch {
        stats.skipped++;
      }
    }
  } catch {}

  console.log(`  ${stats.groups} group activities`);
}

// ============ EVENTS IMPORT ============
async function importEvents(
  db: Database,
  insert: any,
  activityPath: string,
  sourceAccount: string,
  importBatch: string,
  stats: Stats
) {
  const eventsDir = join(activityPath, "events");

  // Event invitations
  const invitationsFile = join(eventsDir, "event_invitations.json");
  try {
    const data = await Bun.file(invitationsFile).json();
    const items = data.events_invited_v2 || [];

    for (const item of items) {
      const timestamp = toISOTimestamp(item.timestamp);
      const title = decodeFacebookText(item.name) || "Event invitation";

      const itemId = `event:invite:${item.timestamp}:${title.slice(0, 30)}`;

      try {
        insert.run(
          "facebook", itemId, sourceAccount, "event:invitation", timestamp, null,
          title, null, null, null, JSON.stringify(item), importBatch
        );
        stats.events++;
      } catch {
        stats.skipped++;
      }
    }
  } catch {}

  // Event responses
  const responsesFile = join(eventsDir, "your_event_responses.json");
  try {
    const data = await Bun.file(responsesFile).json();
    const items = data.event_responses_v2?.events_joined || [];

    for (const item of items) {
      const timestamp = toISOTimestamp(item.timestamp);
      const title = decodeFacebookText(item.name) || "Event response";

      const itemId = `event:response:${item.timestamp}:${title.slice(0, 30)}`;

      try {
        insert.run(
          "facebook", itemId, sourceAccount, "event:response", timestamp, null,
          title, null, null, null, JSON.stringify(item), importBatch
        );
        stats.events++;
      } catch {
        stats.skipped++;
      }
    }
  } catch {}

  console.log(`  ${stats.events} events`);
}

// ============ FRIENDS IMPORT ============
async function importFriends(
  db: Database,
  insert: any,
  importPath: string,
  sourceAccount: string,
  importBatch: string,
  stats: Stats,
  allIdentities: UpsertIdentityOptions[]
) {
  const friendsDir = join(importPath, "connections", "friends");

  // Current friends
  const friendsFile = join(friendsDir, "your_friends.json");
  try {
    const data = await Bun.file(friendsFile).json();
    const friends = data.friends_v2 || [];

    for (const friend of friends) {
      const timestamp = toISOTimestamp(friend.timestamp);
      const name = decodeFacebookText(friend.name) || "Friend";

      const friendId = `friend:${friend.timestamp}:${name}`;
      const friendIdentifier = formatIdentifier("facebook", `name:${name}`);

      // Collect friend identity
      allIdentities.push({
        platform: "facebook",
        platformId: `name:${name}`,
        displayName: name,
      });

      try {
        insert.run(
          "facebook", friendId, sourceAccount, "friend:added", timestamp, null,
          `Became friends with ${name}`, null, JSON.stringify([friendIdentifier]), null,
          JSON.stringify(friend), importBatch
        );
        stats.friends++;
      } catch {
        stats.skipped++;
      }
    }
  } catch {}

  // Removed friends
  const removedFile = join(friendsDir, "removed_friends.json");
  try {
    const data = await Bun.file(removedFile).json();
    const friends = data.deleted_friends_v2 || [];

    for (const friend of friends) {
      const timestamp = toISOTimestamp(friend.timestamp);
      const name = decodeFacebookText(friend.name) || "Friend";

      const friendId = `friend:removed:${friend.timestamp}:${name}`;
      const friendIdentifier = formatIdentifier("facebook", `name:${name}`);

      // Collect friend identity
      allIdentities.push({
        platform: "facebook",
        platformId: `name:${name}`,
        displayName: name,
      });

      try {
        insert.run(
          "facebook", friendId, sourceAccount, "friend:removed", timestamp, null,
          `Removed friend ${name}`, null, JSON.stringify([friendIdentifier]), null,
          JSON.stringify(friend), importBatch
        );
        stats.friends++;
      } catch {
        stats.skipped++;
      }
    }
  } catch {}

  console.log(`  ${stats.friends} friend events`);
}

// ============ POKES IMPORT ============
async function importPokes(
  db: Database,
  insert: any,
  activityPath: string,
  sourceAccount: string,
  importBatch: string,
  stats: Stats,
  allIdentities: UpsertIdentityOptions[]
) {
  const pokesFile = join(activityPath, "other_activity", "pokes.json");
  try {
    const data = await Bun.file(pokesFile).json();
    const pokes = data.pokes_v2 || [];

    for (const poke of pokes) {
      const timestamp = toISOTimestamp(poke.timestamp);
      const title = decodeFacebookText(poke.title) || "Poke";
      const name = poke.data?.[0]?.name ? decodeFacebookText(poke.data[0].name) : null;

      const pokeId = `poke:${poke.timestamp}:${stats.pokes}`;

      let people: string[] | null = null;
        if (name) {
          const personIdentifier = formatIdentifier("facebook", `name:${name}`);
          people = [personIdentifier];
          allIdentities.push({
          platform: "facebook",
          platformId: `name:${name}`,
          displayName: name,
        });
      }

      try {
        insert.run(
          "facebook", pokeId, sourceAccount, "poke", timestamp, null,
          title, null, people ? JSON.stringify(people) : null, null,
          JSON.stringify(poke), importBatch
        );
        stats.pokes++;
      } catch {
        stats.skipped++;
      }
    }
  } catch {}

  console.log(`  ${stats.pokes} pokes`);
}

// ============ CLI ============
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: bun run src/parsers/facebook.ts <import-path> [account-name]");
    console.log("");
    console.log("Imports all Facebook data: messages, posts, comments, reactions,");
    console.log("groups, events, friends, and pokes.");
    console.log("");
    console.log("Example: bun run src/parsers/facebook.ts /tmp/facebook-export my-account");
    process.exit(1);
  }

  const importPath = args[0];
  const accountName = args[1] || "default";

  console.log(`Importing Facebook data from ${importPath}`);
  console.log(`Account: ${accountName}\n`);

  const db = getDb();
  initDb(db);

  await importFacebookData(db, importPath, accountName);

  db.close();
}
