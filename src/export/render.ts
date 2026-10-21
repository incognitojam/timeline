import { convertLegacyEmoji } from "../db/emoji";
import type { TimelineEvent } from "../db/schema";
import {
  formatDuration,
  getAttachmentDescription,
  getMessageMarkers,
  getReactionsDescription,
  type ReactionActorNameResolver,
} from "../lib/format";
import type { ConversationRangeExportTimestampStyle } from "../shared/conversation-export";
import { isConversationEventType } from "../shared/grouping";
import { getDiscordForwardedText, getDiscordMessageAttachments, getDiscordPollText } from "../shared/discord-forward";
import { discordMentionsToPlainText } from "../shared/discord-mentions";
import type { AttachmentDescriptionsByEvent } from "./attachment-descriptions";
import { type EventGroupData, groupEvents } from "./grouping";
import type { ReplyQuotesByEvent } from "./reply-quotes";
import { quotePreview } from "./quote-preview";

// Re-export for backward compatibility with day-summary.ts
export { groupEvents };

interface TimeZoneOptions {
  timeZone?: string;
}

interface AttachmentRenderOptions {
  attachmentDescriptions?: AttachmentDescriptionsByEvent;
}

interface ReplyQuoteRenderOptions {
  /** Inline reply-quote markers by event id (see loadReplyQuotesForEvents). */
  replyQuotes?: ReplyQuotesByEvent;
}

interface DiscordMentionRenderOptions {
  displayNames?: Record<string, string>;
  discordUserResolver?: (id: string) => string | null;
}

interface TimestampParts {
  date: string;
  time: string;
}

const timestampFormatters = new Map<string, Intl.DateTimeFormat>();

function getTimestampFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = timestampFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    timestampFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function partValue(parts: Intl.DateTimeFormatPart[], type: string): string {
  const part = parts.find((part) => part.type === type);
  if (!part) {
    throw new Error(`Formatted timestamp is missing ${type}`);
  }
  return part.value;
}

function getTimestampParts(date: Date, options: TimeZoneOptions = {}): TimestampParts {
  if (!options.timeZone) {
    const iso = date.toISOString();
    const time = iso.slice(11, 16);
    return {
      date: iso.slice(0, 10),
      time,
    };
  }

  const parts = getTimestampFormatter(options.timeZone).formatToParts(date);
  const datePart = [
    partValue(parts, "year"),
    partValue(parts, "month"),
    partValue(parts, "day"),
  ].join("-");
  const time = `${partValue(parts, "hour")}:${partValue(parts, "minute")}`;
  return {
    date: datePart,
    time,
  };
}

function getTimestampPartsFromString(ts: string, options: TimeZoneOptions = {}): TimestampParts {
  return getTimestampParts(new Date(ts), options);
}

/**
 * Format a timestamp for display: 2024-01-15 14:32
 */
function formatTimestamp(ts: string | null, options: TimeZoneOptions = {}): string {
  if (!ts) return "no date";
  const parts = getTimestampPartsFromString(ts, options);
  return `${parts.date} ${parts.time}`;
}

/**
 * Format a timestamp with date only if it changed: 2024-01-15 14:32 or 14:32
 */
function formatTimestampCompact(
  ts: string | null,
  lastDate: string | null,
  options: TimeZoneOptions = {},
): { formatted: string; date: string | null } {
  if (!ts) return { formatted: "no date", date: null };
  const { date, time } = getTimestampPartsFromString(ts, options);
  
  if (lastDate === date) {
    // Same date, just show time
    return { formatted: time, date };
  } else {
    // New date, show full timestamp
    return { formatted: `${date} ${time}`, date };
  }
}

function formatTimestampTimeOnly(
  ts: string | null,
  options: TimeZoneOptions = {},
): { formatted: string; date: string | null } {
  if (!ts) return { formatted: "no date", date: null };
  const { date, time } = getTimestampPartsFromString(ts, options);
  return {
    formatted: time,
    date,
  };
}

function dayOffset(startDate: string | null, endDate: string): number | null {
  if (!startDate) return null;
  const startDay = new Date(`${startDate}T00:00:00Z`).getTime();
  const endDay = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.round((endDay - startDay) / 86_400_000);
}

function formatRangeEnd(
  startDate: string | null,
  endDate: string,
  endTime: string,
  options: { useMultiDayOffset?: boolean },
): string {
  const days = dayOffset(startDate, endDate);
  if (days === null || days === 0) return endTime;
  if (days === 1) return `${endTime}(+1)`;
  if (options.useMultiDayOffset) return `${endTime}(+${days})`;
  return `${endDate} ${endTime}`;
}

function formatDateTimeRangePrefix(
  eventDate: string | null,
  lastDate: string | null,
  startTime: string,
  endDate: string,
  endTime: string,
  options: TimestampRenderOptions,
): string {
  const useMultiDayOffset = Boolean(options.dateHeaders && !options.fullTimestamps);
  const timeRange = `${startTime}-${formatRangeEnd(eventDate, endDate, endTime, {
    useMultiDayOffset,
  })}`;

  if (options.fullTimestamps) {
    return eventDate ? `${eventDate} ${timeRange}` : timeRange;
  }
  if (!options.dateHeaders && eventDate && eventDate !== lastDate) {
    return `${eventDate} ${timeRange}`;
  }
  return timeRange;
}

/**
 * Format a duration range: 2024-01-15 14:00-15:30
 */
function formatTimeRange(start: string | null, end: string | null, options: TimeZoneOptions = {}): string {
  if (!start) return "no date";
  const startParts = getTimestampPartsFromString(start, options);
  const date = startParts.date;
  const startTime = startParts.time;
  if (!end) return `${date} ${startTime}`;
  const endParts = getTimestampPartsFromString(end, options);
  const endDate = endParts.date;
  const endTime = endParts.time;
  return `${date} ${startTime}-${formatRangeEnd(date, endDate, endTime, {})}`;
}

function describedPhotoMarker(description: string): string {
  return `[photo: ${description}]`;
}

function getAttachmentMarkerWithDescriptions(
  event: TimelineEvent,
  options: AttachmentRenderOptions = {},
): string | null {
  const descriptions = options.attachmentDescriptions?.get(event.id) ?? [];
  const generic = getAttachmentDescription(event);
  if (descriptions.length === 0) return generic;

  if (!generic) {
    const markers: string[] = [];
    for (const attachment of descriptions) {
      if (attachment.description) markers.push(describedPhotoMarker(attachment.description));
    }
    return markers.length > 0 ? markers.join(" ") : null;
  }

  try {
    const raw = typeof event.raw_data === "string"
      ? JSON.parse(event.raw_data)
      : event.raw_data;
    const attachments = event.source === "discord" && event.type.endsWith(":forward")
      ? getDiscordMessageAttachments(event.raw_data)
      : raw.attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) return generic;

    let imageIndex = 0;
    const markers = attachments.map((attachment: { content_type?: string; filename?: string }) => {
      const contentType = attachment.content_type || "";
      if (contentType.startsWith("image/")) {
        const description = descriptions[imageIndex]?.description;
        imageIndex++;
        return description ? describedPhotoMarker(description) : "[photo]";
      }
      if (contentType.startsWith("video/")) return "[video]";
      if (contentType.startsWith("audio/")) return "[audio]";
      return `[file: ${attachment.filename || "attachment"}]`;
    });
    return markers.join(" ");
  } catch {
    return generic;
  }
}

/**
 * Build the display text for a message line.
 *
 * Content and attachments are combined when a message has both (a caption
 * alongside its media) so the attachment marker isn't dropped. Falls back to
 * the attachment marker, then the title, then a placeholder.
 */
function messageText(
  event: TimelineEvent,
  content: string | null,
  title: string | null,
  options: AttachmentRenderOptions & ReplyQuoteRenderOptions = {},
): string {
  const attachments = getAttachmentMarkerWithDescriptions(event, options);
  const markers = getMessageMarkers(event, attachments);
  const isForward = event.source === "discord" && event.type.endsWith(":forward");
  const body = isForward && content ? quotePreview(content) : content;
  const text = body && markers.length > 0
    ? `${body} ${markers.join(" ")}`
    : body || markers.join(" ") || (isForward ? "[content unavailable]" : title || "[no content]");
  const replyQuote = options.replyQuotes?.get(event.id);
  const quoted = isForward
    ? `↗ (forwarded: "${text}")`
    : replyQuote ? `${replyQuote} ${text}` : text;
  return event.source_deleted_observed_at ? `${quoted} [deleted]` : quoted;
}

function getRenderableContent(
  event: TimelineEvent,
  options: TimeZoneOptions & DiscordMentionRenderOptions = {},
): string | null {
  const discordUserResolver = options.discordUserResolver;
  const rawContent = event.source === "discord"
    ? getDiscordPollText(event.raw_data, { user: discordUserResolver })
      || event.content
      || getDiscordForwardedText(event.raw_data)
    : event.content;
  const content = convertLegacyEmoji(rawContent);
  return event.source === "discord" && content
    ? discordMentionsToPlainText(
      content,
      event.raw_data,
      { user: discordUserResolver },
      { timeZone: options.timeZone },
    )
    : content;
}

/**
 * Get sender name from people JSON
 */
function getSender(people: string | null, displayNames?: Record<string, string>): string {
  if (!people) return "Unknown";
  try {
    const arr = JSON.parse(people);
    if (Array.isArray(arr) && arr.length > 0) {
      const identifier = arr[0];
      if (typeof identifier === "string") {
        return displayNames?.[identifier] ?? identifier;
      }
    }
  } catch {}
  return "Unknown";
}

// Conversation-thread events other than calls, which render on their own
// branch: sms/mms/rcs, Discord/Facebook/Skype messages, AI chat turns, etc.
function isMessageEvent(type: string): boolean {
  return isConversationEventType(type) && !type.startsWith("call:");
}

/**
 * Render a single event to a text line
 */
export function renderEvent(
  event: TimelineEvent,
  options: TimeZoneOptions & AttachmentRenderOptions & ReplyQuoteRenderOptions & DiscordMentionRenderOptions = {},
): string {
  const { type, source, timestamp, end_timestamp, duration_ms, people, location_name } = event;
  // Convert legacy Facebook emoji codes to Unicode
  const title = convertLegacyEmoji(event.title);
  const content = getRenderableContent(event, options);

  // Messages (Discord, Facebook, SMS/MMS/RCS, Skype, Google Chat, AI chat turns, etc.)
  if (isMessageEvent(type)) {
    const sender = getSender(people, options.displayNames);
    const text = messageText(event, content, title, options);
    return `${formatTimestamp(timestamp, options)} <${sender}> ${text}`;
  }

  // Calls
  if (type.startsWith("call")) {
    const person = getSender(people, options.displayNames);
    const dur = duration_ms ? ` (${formatDuration(duration_ms)})` : "";
    const callType = type.replace("call:", "");
    return `${formatTimestamp(timestamp, options)} ${callType} call with ${person}${dur}`;
  }

  // Reactions (Facebook)
  if (type.startsWith("reaction:")) {
    const emoji = type.split(":")[1] || "like";
    const emojiMap: Record<string, string> = {
      like: "👍", love: "❤️", haha: "😂", wow: "😮", sorry: "😢", anger: "😠"
    };
    return `${formatTimestamp(timestamp, options)} Reacted ${emojiMap[emoji] || emoji} to: "${title}"`;
  }

  // Spotify listens
  if (source === "spotify" && type.startsWith("listen")) {
    return `${formatTimestamp(timestamp, options)} Listened to "${title}"`;
  }

  // YouTube
  if (type.startsWith("youtube:")) {
    const action = type.replace("youtube:", "");
    if (action === "watch" || action === "view") {
      return `${formatTimestamp(timestamp, options)} Watched "${title}"`;
    }
    if (action === "like") {
      return `${formatTimestamp(timestamp, options)} Liked "${title}"`;
    }
    if (action === "search") {
      return `${formatTimestamp(timestamp, options)} Searched: "${title}"`;
    }
    if (action === "subscribe") {
      return `${formatTimestamp(timestamp, options)} Subscribed to ${title}`;
    }
    return `${formatTimestamp(timestamp, options)} YouTube ${action}: "${title}"`;
  }

  // Trakt (TV/Movies)
  if (source === "trakt") {
    return `${formatTimestamp(timestamp, options)} Watched ${title}`;
  }

  // Chrome browsing
  if (type === "browse") {
    return `${formatTimestamp(timestamp, options)} Visited: ${title}`;
  }

  // Location visits
  if (type === "location:visit") {
    const dur = duration_ms ? ` (${formatDuration(duration_ms)})` : "";
    return `${formatTimeRange(timestamp, end_timestamp, options)} At "${location_name || title}"${dur}`;
  }

  // Location transit
  if (type === "location:transit") {
    return `${formatTimestamp(timestamp, options)} Transit: ${title}`;
  }

  // Google Calendar
  if (type === "event" || type === "event:all-day") {
    if (end_timestamp) {
      return `${formatTimeRange(timestamp, end_timestamp, options)} ${title}`;
    }
    return `${formatTimestamp(timestamp, options)} ${title}`;
  }

  // Journal Q&A
  if (type === "journal:qa") {
    return `${formatTimestamp(timestamp, options)} Journal Q: "${title}" A: ${content}`;
  }

  // Journal reflection
  if (type === "journal:reflection") {
    const preview = content?.slice(0, 200) || "";
    return `${formatTimestamp(timestamp, options)} Journal reflection: ${preview}${content && content.length > 200 ? "..." : ""}`;
  }

  // Google Keep notes
  if (type.startsWith("note:")) {
    const preview = content?.slice(0, 100) || "";
    return `${formatTimestamp(timestamp, options)} Note: "${title}" - ${preview}${content && content.length > 100 ? "..." : ""}`;
  }

  // Monzo transactions
  if (source === "monzo") {
    const category = type.replace("transaction:", "").replace("transaction", "general");
    // Try to extract amount from raw_data
    let amount = "";
    try {
      const raw = JSON.parse(event.raw_data);
      if (raw.amount !== undefined) {
        const pounds = Math.abs(raw.amount) / 100;
        const sign = raw.amount < 0 ? "-" : "+";
        amount = ` ${sign}£${pounds.toFixed(2)}`;
      }
    } catch {}
    return `${formatTimestamp(timestamp, options)} ${title}${amount} (${category})`;
  }

  // Google Search
  if (type === "search") {
    return `${formatTimestamp(timestamp, options)} Searched: "${title}"`;
  }

  // Reddit
  if (type === "post" || type === "comment") {
    const preview = content?.slice(0, 100) || title || "";
    return `${formatTimestamp(timestamp, options)} ${type}: "${preview}${content && content.length > 100 ? "..." : ""}"`;
  }

  if (type === "vote:up" || type === "vote:down") {
    const vote = type === "vote:up" ? "Upvoted" : "Downvoted";
    return `${formatTimestamp(timestamp, options)} ${vote}: "${title}"`;
  }

  // GitHub
  if (source === "github") {
    return `${formatTimestamp(timestamp, options)} ${type.replace("github:", "")}: ${title}`;
  }

  // Facebook posts/comments
  if (type === "post" || type === "comment" || type === "post:page" || type === "group:post" || type === "group:comment") {
    const preview = content?.slice(0, 100) || "";
    return `${formatTimestamp(timestamp, options)} ${type}: "${preview}${content && content.length > 100 ? "..." : ""}"`;
  }

  // Facebook friend events
  if (type === "friend:added" || type === "friend:removed") {
    return `${formatTimestamp(timestamp, options)} ${type.replace(":", " ")}: ${title}`;
  }

  // Pokes
  if (type === "poke") {
    return `${formatTimestamp(timestamp, options)} Poked ${getSender(people, options.displayNames)}`;
  }

  // Default fallback
  return `${formatTimestamp(timestamp, options)} [${source}/${type}] ${title || content || ""}`;
}

/**
 * Render a group of events with a header (legacy)
 */
export function renderEventGroup(
  events: TimelineEvent[],
  header: string,
  options: TimeZoneOptions & AttachmentRenderOptions & ReplyQuoteRenderOptions & DiscordMentionRenderOptions = {},
): string {
  const lines = [`## ${header}`];
  for (const event of events) {
    lines.push(renderEvent(event, options));
  }
  return lines.join("\n");
}

/**
 * Format time range for group headers: 14:00-14:45
 */
function formatTimeRangeShort(start: string | null, end: string | null, options: TimeZoneOptions = {}): string {
  if (!start) return "";
  const startTime = getTimestampPartsFromString(start, options).time;
  if (!end || start === end) return startTime;
  const endTime = getTimestampPartsFromString(end, options).time;
  return `${startTime}-${endTime}`;
}

export interface RenderOptions extends TimeZoneOptions {
  compactAuthors: boolean;
  noSummaries: boolean;  // Disable summary metadata in headers
  fullTimestamps: boolean; // Always show full date+time
  dateHeaders?: boolean; // Insert date headers and show per-line time only
  attachmentDescriptions?: AttachmentDescriptionsByEvent;
  replyQuotes?: ReplyQuotesByEvent;
  displayNames?: Record<string, string>;
  discordUserResolver?: (id: string) => string | null;
  // Off by default: a transcript export reads as one continuous thread.
  splitConversations?: boolean;
}

interface TimestampRenderOptions extends TimeZoneOptions {
  fullTimestamps: boolean;
  dateHeaders?: boolean;
}

interface EventLineRenderOptions extends TimestampRenderOptions {
  compactAuthors: boolean;
  displayNames?: Record<string, string>;
  discordUserResolver?: (id: string) => string | null;
  reactionActorNameResolver?: ReactionActorNameResolver;
  includeReactions?: boolean;
  attachmentDescriptions?: AttachmentDescriptionsByEvent;
  replyQuotes?: ReplyQuotesByEvent;
}

function formatTimestampForOptions(
  timestamp: string | null,
  lastDate: string | null,
  eventDate: string | null,
  options: TimestampRenderOptions,
): { formatted: string; date: string | null } {
  if (options.dateHeaders) {
    return formatTimestampTimeOnly(timestamp, options);
  }
  if (options.fullTimestamps) {
    return { formatted: formatTimestamp(timestamp, options), date: eventDate };
  }
  return formatTimestampCompact(timestamp, lastDate, options);
}

/**
 * Render a single event with compact formatting (omits redundant date/author)
 */
function renderEventCompact(
  event: TimelineEvent,
  lastDate: string | null,
  lastSender: string | null,
  isMessageGroup: boolean,
  options: EventLineRenderOptions
): { line: string; date: string | null; sender: string | null } {
  const { type, source, timestamp, end_timestamp, duration_ms, people, location_name } = event;
  const title = convertLegacyEmoji(event.title);
  const content = getRenderableContent(event, options);
  
  // Extract date from timestamp
  const eventDate = timestamp ? getTimestampPartsFromString(timestamp, options).date : null;
  
  // Messages (Discord, Facebook, SMS, Skype, Google Chat, etc.)
  if (isMessageEvent(type)) {
    const sender = getSender(people, options.displayNames);
    const text = messageText(event, content, title, options);
    const reactions = options.includeReactions
      ? getReactionsDescription(event, options.reactionActorNameResolver)
      : null;
    const body = reactions ? `${text} ${reactions}` : text;

    const formattedTimestamp = formatTimestampForOptions(timestamp, lastDate, eventDate, options);
    const timeStr = formattedTimestamp.formatted;
    const date = formattedTimestamp.date;
    
    const shouldOmitSender = options.compactAuthors
      && isMessageGroup
      && sender === lastSender
      && eventDate === lastDate;
    
    if (shouldOmitSender) {
      return { line: `${timeStr} ${body}`, date, sender };
    }
    return { line: `${timeStr} <${sender}> ${body}`, date, sender };
  }
  
  // For non-messages, render with compact or full timestamp
  const formattedTimestamp = formatTimestampForOptions(timestamp, lastDate, eventDate, options);
  const timeStr = formattedTimestamp.formatted;
  const date = formattedTimestamp.date;
  
  // Handle time ranges (location visits, calendar events)
  if (end_timestamp && (type === "location:visit" || type === "event" || type === "event:all-day")) {
    const endParts = getTimestampPartsFromString(end_timestamp, options);
    const endDate = endParts.date;
    const startTime = timestamp ? getTimestampPartsFromString(timestamp, options).time : "00:00";
    const endTime = endParts.time;
    const dur = duration_ms ? ` (${formatDuration(duration_ms)})` : "";
    const prefix = formatDateTimeRangePrefix(eventDate, lastDate, startTime, endDate, endTime, options);

    if (type === "location:visit") {
      return { line: `${prefix} At "${location_name || title}"${dur}`, date, sender: null };
    } else {
      return { line: `${prefix} ${title}`, date, sender: null };
    }
  }
  
  // For other event types, use standard rendering but replace timestamp
  const standardLine = renderEvent(event, options);
  // Replace first timestamp occurrence with compact version
  const compactLine = standardLine.replace(formatTimestamp(timestamp, options), timeStr);
  return { line: compactLine, date, sender: null };
}

export interface ConversationTranscriptOptions {
  source: string;
  title: string | null;
  timestampStyle: ConversationRangeExportTimestampStyle;
  displayNames?: Record<string, string>;
  discordUserResolver?: (id: string) => string | null;
  reactionActorNameResolver?: ReactionActorNameResolver;
  includeReactions: boolean;
  compactAuthors: boolean;
  timeZone?: string;
  attachmentDescriptions?: AttachmentDescriptionsByEvent;
  replyQuotes?: ReplyQuotesByEvent;
}

export function renderConversationTranscript(
  events: TimelineEvent[],
  options: ConversationTranscriptOptions,
): string {
  const title = options.title || "(no title)";
  const lines = [`## ${options.source}: ${title}`];
  const lineOptions: EventLineRenderOptions = {
    compactAuthors: options.compactAuthors,
    fullTimestamps: options.timestampStyle === "full-timestamps",
    dateHeaders: options.timestampStyle !== "full-timestamps",
    displayNames: options.displayNames,
    discordUserResolver: options.discordUserResolver,
    reactionActorNameResolver: options.reactionActorNameResolver,
    includeReactions: options.includeReactions,
    timeZone: options.timeZone,
    attachmentDescriptions: options.attachmentDescriptions,
    replyQuotes: options.replyQuotes,
  };
  let lastDate: string | null = null;
  let lastSender: string | null = null;

  for (const event of events) {
    const isMessage = isMessageEvent(event.type);
    const { line, date, sender } = renderEventCompact(
      event,
      lastDate,
      lastSender,
      true,
      lineOptions,
    );
    if (lineOptions.dateHeaders && date && date !== lastDate) {
      lines.push(`### ${date}`);
    }
    lines.push(line);

    lastDate = date;
    lastSender = isMessage ? sender : null;
  }

  return lines.join("\n");
}

/**
 * Render a group of events with summary header and compact formatting
 */
export function renderEventGroupWithSummary(group: EventGroupData<TimelineEvent>, options: RenderOptions): string {
  const lines: string[] = [];
  
  // Build header with optional summary
  let header = `## ${group.source}: ${group.label}`;
  
  if (!options.noSummaries) {
    // Add summary info
    const summaryParts: string[] = [group.summary];
    
    if (group.type === "session") {
      // For sessions, include time range and duration
      if (group.timeRange.start && group.timeRange.end && group.timeRange.start !== group.timeRange.end) {
        summaryParts.push(formatTimeRangeShort(group.timeRange.start, group.timeRange.end, options));
      }
      if (group.totalDuration) {
        summaryParts.push(formatDuration(group.totalDuration));
      }
    } else if (group.type === "conversation") {
      // Only worth its tokens when split: an unsplit thread can span the day.
      if (
        options.splitConversations &&
        group.timeRange.start &&
        group.timeRange.end &&
        group.timeRange.start !== group.timeRange.end
      ) {
        summaryParts.push(formatTimeRangeShort(group.timeRange.start, group.timeRange.end, options));
      }
      // Only show participant list for small groups (2-3 people) to save tokens
      if (group.participants && group.participants.length > 0 && group.participants.length <= 3) {
        const participantsStr = group.participants.join(", ");
        summaryParts.push(participantsStr);
      }
      // For larger groups, the message count is sufficient
    }

    if (summaryParts.length > 0) {
      header += ` (${summaryParts.join(", ")})`;
    }
  }
  
  lines.push(header);
  
  // Track state for compact rendering
  let lastDate: string | null = null;
  let lastSender: string | null = null;
  const isMessageGroup = group.type === "conversation";
  
  // Track duplicate messages (same content, different timestamps)
  const seenMessages = new Map<string, number>(); // content -> count
  
  // Render all events in the group with compact formatting
  for (const event of group.events) {
    const isMessage = isMessageEvent(event.type);
    
    // Check for duplicate content (for future optimization)
    const content = event.content || event.title || "";
    const contentKey = content.trim().toLowerCase();
    
    if (isMessage && contentKey && contentKey.length > 0) {
      const count = seenMessages.get(contentKey) || 0;
      seenMessages.set(contentKey, count + 1);
      // Note: We still render duplicates with timestamps for context
      // Future: Could add "(repeat)" marker or aggregate if needed
    }
    
    const { line, date, sender } = renderEventCompact(
      event, 
      lastDate, 
      lastSender, 
      isMessageGroup,
      options
    );
    if (options.dateHeaders && date && date !== lastDate) {
      lines.push(`### ${date}`);
    }
    lines.push(line);
    
    lastDate = date;
    if (isMessage && isMessageGroup) {
      lastSender = sender;
    } else {
      lastSender = null; // Reset when not in message group
    }
  }
  
  return lines.join("\n");
}

/**
 * Render all events, grouped with smart summarization
 */
export function renderEvents(events: TimelineEvent[], options: RenderOptions = {
  compactAuthors: true,
  noSummaries: false,
  fullTimestamps: false,
}): string {
  const groups = groupEvents(events, { splitConversations: options.splitConversations ?? false });
  const sections: string[] = [];

  for (const group of groups) {
    sections.push(renderEventGroupWithSummary(group, options));
  }

  return sections.join("\n\n");
}
