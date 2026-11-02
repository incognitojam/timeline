import { Database } from "bun:sqlite";
import { join } from "node:path";
import { storeAndInsertAttachment } from "../../media/attachments";
import { safeFileName } from "../../platforms/discord/attachment-downloader";
import type { NormalizedMessage } from "../../platforms/discord/client";
import { buildDiscordMessageRawData } from "../../platforms/discord/event-converter";
import { importDiscordDMs } from "../../platforms/discord/parser";
import type { SeedContext, SeedSource } from "../context";
import type { Person, PersonKey } from "../persona";
import { GROUP_CHATS, peopleOn, personByKey } from "../persona";
import type { Rng } from "../rng";
import {
  DM_SCRIPTS,
  FRIEND_DM_SCRIPTS,
  GAME_NIGHT_SCRIPTS,
  HIKE_GROUP_SCRIPTS,
  HOURS,
  type PlannedMessage,
  planConversation,
  recentLift,
  type Script,
} from "./messaging-a-data";

const NAME = "discord";
const DISCORD_EPOCH = 1_420_070_400_000n;
const REACTIONS = ["😂", "❤️", "👍", "🔥", "💯", "😭", "👀", "🙌"] as const;
const GROUP_REACTIONS: Readonly<Record<string, readonly string[]>> = {
  "weekend-hike": ["🥾", "⛰️", "🌲", "🥪"],
  "game-night": ["🎮", "💀", "🏆"],
};
const PHOTO_BUDGET = { dm: 8, group: 28 };

/** Snowflake-shaped user id derived from the persona's stable numeric id. */
function discordUserId(person: Person): string {
  return `71${person.numericId.padStart(16, "0")}`;
}

interface Channel {
  id: string;
  /** Discord channel type: 1 = DM, 3 = group DM. */
  type: 1 | 3;
  name: string;
  recipients: Person[];
  groupKey?: string;
  plan: PlannedMessage[];
}

/**
 * Discord DMs and group DMs, written as the discord-chat archive SQLite
 * database that importDiscordDMs reads. Each message's `data` JSON is built by
 * the live sync's buildDiscordMessageRawData, so raw_data matches what the
 * gateway sync stores (reactions with users, replies, attachments).
 * Attachments are stored the way the sync's downloader stores them.
 */
export const discordSeed: SeedSource = {
  name: NAME,
  produces: {
    discord: ["message:dm", "message:group", "message:dm:attachment", "message:group:attachment"],
  },
  async seed(ctx) {
    const rng = ctx.rng(NAME);
    const alex = personByKey("alex");
    const lift = recentLift(ctx);
    let sequence = 0;
    const snowflake = (ms: number): string =>
      (((BigInt(ms) - DISCORD_EPOCH) << 22n) | BigInt(sequence++ & 0x3fffff)).toString();
    const channelEpoch = ctx.localDate(ctx.startDate, 0).getTime() - 400 * 86_400_000;

    const channels: Channel[] = [];
    for (const person of peopleOn("discord")) {
      const own = DM_SCRIPTS[person.key] ?? [];
      const scripts: Script[] = [...own, ...own, ...FRIEND_DM_SCRIPTS];
      channels.push({
        id: snowflake(channelEpoch + rng.int(0, 300) * 86_400_000),
        type: 1,
        name: person.first,
        recipients: [person],
        plan: planConversation(ctx, ctx.rng(`${NAME}:dm:${person.key}`), {
          members: [person.key],
          scripts,
          sessionsPerWeek: person.closeness * 0.13,
          dayWeight: lift,
          startHour: HOURS.anytime,
          fillerChance: 0.15,
        }),
      });
    }
    for (const group of GROUP_CHATS.discord ?? []) {
      const hike = group.id === "weekend-hike";
      channels.push({
        id: snowflake(channelEpoch + rng.int(0, 300) * 86_400_000),
        type: 3,
        name: group.name,
        recipients: group.members.map(personByKey),
        groupKey: group.id,
        plan: planConversation(ctx, ctx.rng(`${NAME}:group:${group.id}`), {
          members: group.members,
          scripts: hike ? HIKE_GROUP_SCRIPTS : GAME_NIGHT_SCRIPTS,
          sessionsPerWeek: group.perDay * (hike ? 0.5 : 0.7),
          // Hike planning peaks Thursday–Sunday; game night midweek and weekends.
          dayWeight: (day) =>
            lift(day) * (hike ? ([0, 4, 5, 6].includes(day.weekday) ? 1.5 : 0.4) : [2, 3, 4, 5].includes(day.weekday) ? 1.3 : 0.6),
          startHour: hike
            ? (day, r) => (day.isWeekend ? r.float(6.5, 19) : r.float(18, 22.5))
            : (day, r) => (day.isWeekend ? r.float(13, 23.5) : r.float(19, 23.5)),
          shuffleRoles: true,
          fillerChance: 0.18,
        }),
      });
    }

    // Spend the attachment budget on a spread of photo lines; the rest of the
    // photo-marked lines keep only their caption.
    const photoLines = (type: 1 | 3) =>
      channels.filter((c) => c.type === type).flatMap((c) => c.plan.filter((m) => m.photo));
    const withPhoto = new Set([
      ...rng.sample(photoLines(1), PHOTO_BUDGET.dm),
      ...rng.sample(photoLines(3), PHOTO_BUDGET.group),
    ]);
    if (withPhoto.size < PHOTO_BUDGET.dm + PHOTO_BUDGET.group) {
      throw new Error(`discord: only ${withPhoto.size} photo lines to attach images to`);
    }

    const archivePath = join(ctx.stage(NAME), "personal.db");
    const archive = new Database(archivePath, { create: true });
    archive.exec(`
      CREATE TABLE guilds (id TEXT PRIMARY KEY, name TEXT, sparse INTEGER);
      CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT, type TEXT, guild_id TEXT, guild_name TEXT, recipients TEXT, category TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT, content TEXT, author_id TEXT, author_name TEXT, author_nickname TEXT, timestamp TEXT, data TEXT);
    `);
    const insertChannel = archive.prepare("INSERT INTO channels VALUES (?, ?, ?, NULL, NULL, ?, ?)");
    const insertMessage = archive.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const pendingImages: PendingImage[] = [];

    archive.transaction(() => {
      for (const channel of channels) {
        insertChannel.run(
          channel.id,
          channel.name,
          channel.type === 1 ? "DirectMessage" : "GroupDirectMessage",
          JSON.stringify(channel.recipients.map((p) => ({ id: discordUserId(p), username: p.handle, name: p.first }))),
          channel.type === 1 ? "DM" : "Group",
        );
        const members = [alex, ...channel.recipients];
        const reactionPool = [...REACTIONS, ...(channel.groupKey ? (GROUP_REACTIONS[channel.groupKey] ?? []) : [])];
        const sent: NormalizedMessage[] = [];

        for (const planned of channel.plan) {
          // A bare photo line without an image left over has nothing to say.
          if (planned.text === "" && !withPhoto.has(planned)) continue;
          const author = personByKey(planned.by);
          const ms = planned.at.getTime();
          const id = snowflake(ms);
          const previous = sent.at(-1);
          const replyTarget =
            previous && previous.author.id !== discordUserId(author) && (planned.reply || rng.chance(0.03))
              ? previous
              : undefined;
          const attachments: NormalizedMessage["attachments"] = [];
          if (withPhoto.has(planned)) {
            const portrait = rng.chance(0.3);
            const attachment = {
              id: snowflake(ms),
              url: "",
              fileName: photoName(planned.at, rng),
              fileSizeBytes: 0,
              contentType: "image/jpeg",
              width: portrait ? 480 : 640,
              height: portrait ? 640 : 480,
            };
            attachment.url = `https://cdn.discordapp.com/attachments/${channel.id}/${attachment.id}/${attachment.fileName}`;
            attachments.push(attachment);
            pendingImages.push({ messageId: id, channelId: channel.id, attachment, variant: pendingImages.length });
          }
          const msg: NormalizedMessage = {
            id,
            type: replyTarget ? "Reply" : "Default",
            rawType: replyTarget ? 19 : 0,
            timestamp: planned.at.toISOString(),
            timestampEdited: rng.chance(0.02) ? new Date(ms + rng.int(20, 300) * 1000).toISOString() : null,
            content: planned.text,
            flags: 0,
            author: {
              id: discordUserId(author),
              name: author.handle,
              nickname: author.first,
              isBot: false,
              avatarUrl: null,
            },
            attachments,
            embeds: [],
            reactions: reactionsFor(rng, members, author.key, reactionPool, attachments.length > 0),
            mentions: [],
            reference: replyTarget ? { type: 0, messageId: replyTarget.id, channelId: channel.id } : undefined,
            referencedMessage: replyTarget,
          };
          sent.push(msg);
          insertMessage.run(
            id,
            channel.id,
            msg.content,
            msg.author.id,
            msg.author.name,
            msg.author.nickname,
            msg.timestamp,
            JSON.stringify(buildDiscordMessageRawData(msg)),
          );
        }
      }
    })();
    archive.close();

    await ctx.inTransaction(async () => {
      await importDiscordDMs(ctx.db, archivePath, discordUserId(alex));
      await storeImages(ctx, pendingImages);
    });

    ctx.identify("alex", `discord:${discordUserId(alex)}`);
    for (const person of new Set(channels.flatMap((c) => c.recipients))) {
      ctx.identify(person.key, `discord:${discordUserId(person)}`);
    }
  },
};

interface PendingImage {
  messageId: string;
  channelId: string;
  attachment: NormalizedMessage["attachments"][number];
  variant: number;
}

/** Store generated images the way the sync's attachment downloader stores downloads. */
async function storeImages(ctx: SeedContext, images: readonly PendingImage[]): Promise<void> {
    const eventId = ctx.db.prepare("SELECT id FROM events WHERE source = 'discord' AND source_id = ?");
    for (const { messageId, channelId, attachment, variant } of images) {
      const row = eventId.get(messageId) as { id: number } | null;
      if (!row) throw new Error(`discord: imported event for message ${messageId} not found`);
      const content = await ctx.image({
        width: attachment.width ?? 640,
        height: attachment.height ?? 480,
        hue: (variant * 47) % 360,
        variant,
      });
      // Same record and storage layout as the sync's attachment downloader.
      await storeAndInsertAttachment(
        ctx.db,
        {
          eventId: row.id,
          source: "discord",
          sourceId: attachment.id,
          filename: attachment.fileName,
          mimeType: attachment.contentType,
          width: attachment.width ?? null,
          height: attachment.height ?? null,
          originalUri: attachment.url,
        },
        content,
        `${channelId}/${attachment.id}/${safeFileName(attachment.fileName)}`,
      );
    }

}

function reactionsFor(
  rng: Rng,
  members: readonly Person[],
  author: PersonKey,
  pool: readonly string[],
  isPhoto: boolean,
): NormalizedMessage["reactions"] {
  if (!rng.chance(isPhoto ? 0.7 : 0.1)) return [];
  const others = members.filter((p) => p.key !== author);
  const emojis = rng.sample(pool, rng.chance(0.25) ? 2 : 1);
  return emojis.map((name) => {
    const users = rng.sample(others, rng.int(1, others.length));
    return {
      emoji: { id: null, name },
      count: users.length,
      users: users.map((p) => ({ id: discordUserId(p), name: p.first })),
    };
  });
}

function photoName(at: Date, rng: Rng): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
  return rng.chance(0.5) ? `PXL_${stamp}${rng.digits(3)}.jpg` : `IMG_${rng.int(1000, 9999)}.jpg`;
}
