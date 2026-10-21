import type { DiscordPoll, DiscordPollMedia, PollVoter } from "../platforms/discord/client";

export type { DiscordPoll, DiscordPollMedia, PollVoter } from "../platforms/discord/client";

export interface DiscordRawAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  content_type?: string;
  width?: number;
  height?: number;
}

export interface DiscordStickerItem {
  id: string | null;
  name: string | null;
  formatType: number | null;
}

function parseRawData(rawData: unknown): unknown {
  if (typeof rawData !== "string") return rawData;
  try {
    return JSON.parse(rawData);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function parseAttachment(value: unknown): DiscordRawAttachment | null {
  const attachment = asRecord(value);
  if (!attachment) return null;
  if (
    typeof attachment.id !== "string" ||
    typeof attachment.filename !== "string" ||
    typeof attachment.size !== "number" ||
    typeof attachment.url !== "string"
  ) {
    return null;
  }

  return {
    id: attachment.id,
    filename: attachment.filename,
    size: attachment.size,
    url: attachment.url,
    content_type: typeof attachment.content_type === "string"
      ? attachment.content_type
      : undefined,
    width: typeof attachment.width === "number" ? attachment.width : undefined,
    height: typeof attachment.height === "number" ? attachment.height : undefined,
  };
}

function parseStickerItem(value: unknown): DiscordStickerItem | null {
  const sticker = asRecord(value);
  if (!sticker) return null;

  return {
    id: typeof sticker.id === "string" ? sticker.id : null,
    name: typeof sticker.name === "string" ? sticker.name : null,
    formatType: typeof sticker.format_type === "number" ? sticker.format_type : null,
  };
}

function getSnapshotMessages(rawData: unknown): Record<string, unknown>[] {
  const raw = asRecord(parseRawData(rawData));
  if (!raw || !Array.isArray(raw.message_snapshots)) return [];

  const messages: Record<string, unknown>[] = [];
  for (const snapshot of raw.message_snapshots) {
    const message = asRecord(asRecord(snapshot)?.message);
    if (message) messages.push(message);
  }
  return messages;
}

/** Original Discord message snowflake referenced by a forwarded wrapper. */
export function getDiscordForwardedMessageId(rawData: unknown): string | null {
  const raw = asRecord(parseRawData(rawData));
  const reference = asRecord(raw?.message_reference);
  if (!reference || reference.type !== 1) return null;
  return typeof reference.message_id === "string" && /^\d+$/.test(reference.message_id)
    ? reference.message_id
    : null;
}

/**
 * Original Discord message snowflake referenced by a *reply* (not a forward).
 * Discord marks forwards with `message_reference.type === 1`; a reply is type 0
 * or has no type at all. Returns null for forwards and non-reference messages.
 */
export function getDiscordReplyMessageId(rawData: unknown): string | null {
  const raw = asRecord(parseRawData(rawData));
  const reference = asRecord(raw?.message_reference);
  if (!reference) return null;
  if (reference.type !== undefined && reference.type !== 0) return null;
  return typeof reference.message_id === "string" && /^\d+$/.test(reference.message_id)
    ? reference.message_id
    : null;
}

function authorNameFromRecord(author: Record<string, unknown> | null): string | null {
  const globalName = typeof author?.global_name === "string" ? author.global_name : null;
  const username = typeof author?.username === "string" ? author.username : null;
  return globalName || username;
}

function authorIdFromRecord(author: Record<string, unknown> | null): string | null {
  return typeof author?.id === "string" && author.id.length > 0 ? author.id : null;
}

/** Display name of a Discord message's author: global (nick)name, else username. */
export function getDiscordAuthorName(rawData: unknown): string | null {
  const raw = asRecord(parseRawData(rawData));
  return authorNameFromRecord(asRecord(raw?.author));
}

/** Discord snowflake of a message's author. */
export function getDiscordAuthorId(rawData: unknown): string | null {
  const raw = asRecord(parseRawData(rawData));
  return authorIdFromRecord(asRecord(raw?.author));
}

export interface DiscordReferencedMessage {
  authorId: string | null;
  authorName: string | null;
  content: string | null;
  /** Whether the replied-to message had attachments; null on legacy snapshots that predate attachment_count. */
  hasAttachment: boolean | null;
}

/**
 * Discord's inline resolved preview of the replied-to message. Only present on
 * gateway-synced replies; historical events resolve the target via our own
 * events table instead, falling back to this embedded snapshot when the
 * original message isn't indexed.
 */
export function getDiscordReferencedMessage(rawData: unknown): DiscordReferencedMessage | null {
  const raw = asRecord(parseRawData(rawData));
  const ref = asRecord(raw?.referenced_message);
  if (!ref) return null;
  return {
    authorId: authorIdFromRecord(asRecord(ref.author)),
    authorName: authorNameFromRecord(asRecord(ref.author)),
    content: typeof ref.content === "string" ? ref.content : null,
    hasAttachment: typeof ref.attachment_count === "number" ? ref.attachment_count > 0 : null,
  };
}

/** Text carried by Discord's forwarded-message snapshot rather than its empty wrapper. */
export function getDiscordForwardedText(rawData: unknown): string | null {
  for (const message of getSnapshotMessages(rawData)) {
    if (typeof message.content !== "string") continue;
    const content = message.content.trim();
    if (content) return content;
  }
  return null;
}

/** Sticker items from Discord's raw API payload. */
export function getDiscordStickerItems(rawData: unknown): DiscordStickerItem[] {
  const raw = asRecord(parseRawData(rawData));
  if (!raw) return [];

  const stickers: DiscordStickerItem[] = [];
  const collect = (items: unknown) => {
    if (!Array.isArray(items)) return;
    stickers.push(...items.map(parseStickerItem).filter((sticker): sticker is DiscordStickerItem => sticker !== null));
  };
  collect(raw.sticker_items);
  for (const message of getSnapshotMessages(raw)) {
    collect(message.sticker_items);
  }
  return stickers;
}

function parsePollMedia(value: unknown): DiscordPollMedia | null {
  const media = asRecord(value);
  if (!media) return null;

  const emoji = asRecord(media.emoji);
  return {
    text: typeof media.text === "string" ? media.text : undefined,
    emoji: emoji && typeof emoji.name === "string"
      ? {
        id: typeof emoji.id === "string" || emoji.id === null ? emoji.id : null,
        name: emoji.name,
        animated: typeof emoji.animated === "boolean" ? emoji.animated : undefined,
      }
      : undefined,
  };
}

export interface ParsedDiscordPoll {
  poll: DiscordPoll;
  hasAnswerCounts: boolean;
  hasVoterCapture: boolean;
  votersByAnswerId: Map<string, PollVoter[]>;
}

function parsePollVoter(value: unknown): PollVoter | null {
  const voter = asRecord(value);
  if (
    typeof voter?.id !== "string" ||
    typeof voter.name !== "string" ||
    typeof voter.username !== "string" ||
    (typeof voter.avatar !== "string" && voter.avatar !== null)
  ) {
    return null;
  }

  return { id: voter.id, name: voter.name, username: voter.username, avatar: voter.avatar };
}

function parsePollVoters(value: unknown): Map<string, PollVoter[]> {
  const voters = asRecord(value);
  const answers = asRecord(voters?.answers);
  const votersByAnswerId = new Map<string, PollVoter[]>();
  if (!answers) return votersByAnswerId;

  for (const [answerId, value] of Object.entries(answers)) {
    if (!Array.isArray(value)) continue;
    const voters = value.map(parsePollVoter).filter((voter): voter is PollVoter => voter !== null);
    if (voters.length > 0) votersByAnswerId.set(answerId, voters);
  }

  return votersByAnswerId;
}

export function parseDiscordPoll(rawData: unknown): ParsedDiscordPoll | null {
  const raw = asRecord(parseRawData(rawData));
  const poll = asRecord(raw?.poll);
  const question = parsePollMedia(poll?.question);
  if (!poll || !question || !Array.isArray(poll.answers) || typeof poll.allow_multiselect !== "boolean") {
    return null;
  }

  const answers: DiscordPoll["answers"] = [];
  for (const value of poll.answers) {
    const answer = asRecord(value);
    const pollMedia = parsePollMedia(answer?.poll_media);
    if (typeof answer?.answer_id !== "number" || !pollMedia) return null;
    answers.push({ answer_id: answer.answer_id, poll_media: pollMedia });
  }

  const resultsRecord = asRecord(poll.results);
  let results: DiscordPoll["results"];
  let hasAnswerCounts = false;
  if (resultsRecord) {
    if (typeof resultsRecord.is_finalized !== "boolean") {
      return null;
    }
    const answerCounts: NonNullable<DiscordPoll["results"]>["answer_counts"] = [];
    if (resultsRecord.answer_counts !== undefined) {
      if (!Array.isArray(resultsRecord.answer_counts)) return null;
      hasAnswerCounts = true;
      for (const value of resultsRecord.answer_counts) {
        const answerCount = asRecord(value);
        if (
          typeof answerCount?.id !== "number" ||
          typeof answerCount.count !== "number" ||
          typeof answerCount.me_voted !== "boolean"
        ) {
          return null;
        }
        answerCounts.push({
          id: answerCount.id,
          count: answerCount.count,
          me_voted: answerCount.me_voted,
        });
      }
    }
    results = { is_finalized: resultsRecord.is_finalized, answer_counts: answerCounts };
  }

  return {
    poll: {
      question,
      answers,
      expiry: typeof poll.expiry === "string" || poll.expiry === null ? poll.expiry : null,
      allow_multiselect: poll.allow_multiselect,
      layout_type: typeof poll.layout_type === "number" ? poll.layout_type : 0,
      results,
    },
    hasAnswerCounts,
    hasVoterCapture: asRecord(poll.voters) !== null,
    votersByAnswerId: parsePollVoters(poll.voters),
  };
}

function formatPollMedia(media: DiscordPollMedia): string {
  const text = media.text?.trim();
  const emoji = media.emoji?.name;
  return [emoji, text].filter((value): value is string => Boolean(value)).join(" ") || "[unnamed option]";
}

/**
 * Compact plain-text poll marker from a Discord message's raw API payload.
 * `user` resolves voter names, as it does for mention tokens.
 */
export function getDiscordPollText(
  rawData: unknown,
  options: { user?: (id: string) => string | null } = {},
): string | null {
  const parsed = parseDiscordPoll(rawData);
  if (!parsed) return null;
  const { poll, hasAnswerCounts, votersByAnswerId } = parsed;

  const countsByAnswerId = new Map(poll.results?.answer_counts.map((count) => [count.id, count]));
  const answers = poll.answers.map((answer) => {
    const text = formatPollMedia(answer.poll_media);
    const count = countsByAnswerId.get(answer.answer_id);
    if (!poll.results || !hasAnswerCounts) return text;
    const votes = count?.count ?? 0;
    const voterNames = votersByAnswerId
      .get(String(answer.answer_id))
      ?.map((voter) => options.user?.(voter.id) ?? voter.name);
    const votersDescription = voterNames && voterNames.length > 0
      ? `: ${voterNames.join(", ")}`
      : count?.me_voted ? ", you voted" : "";
    return `${text} (${votes} vote${votes === 1 ? "" : "s"}${votersDescription})`;
  });
  const notes = [
    poll.allow_multiselect ? "multiple selections allowed" : null,
    poll.results?.is_finalized ? "finalized" : null,
  ].filter((note): note is string => note !== null);
  const question = formatPollMedia(poll.question);
  const body = [question, ...answers].join(" — ");

  return `[poll: ${body}${notes.length > 0 ? ` — ${notes.join("; ")}` : ""}]`;
}

/** Attachments nested inside Discord forwarded-message snapshots. */
export function getDiscordSnapshotAttachments(rawData: unknown): DiscordRawAttachment[] {
  const attachments: DiscordRawAttachment[] = [];
  for (const message of getSnapshotMessages(rawData)) {
    if (!Array.isArray(message.attachments)) continue;
    for (const value of message.attachments) {
      const attachment = parseAttachment(value);
      if (attachment) attachments.push(attachment);
    }
  }
  return attachments;
}

/** Outer and forwarded-snapshot attachments, deduplicated by Discord attachment id. */
export function getDiscordMessageAttachments(rawData: unknown): DiscordRawAttachment[] {
  const raw = asRecord(parseRawData(rawData));
  const byId = new Map<string, DiscordRawAttachment>();

  if (raw && Array.isArray(raw.attachments)) {
    for (const value of raw.attachments) {
      const attachment = parseAttachment(value);
      if (attachment) byId.set(attachment.id, attachment);
    }
  }
  for (const attachment of getDiscordSnapshotAttachments(raw)) {
    if (!byId.has(attachment.id)) byId.set(attachment.id, attachment);
  }

  return [...byId.values()];
}
