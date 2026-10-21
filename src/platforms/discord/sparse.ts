/**
 * Sparse sync for Discord channels
 *
 * Instead of importing all messages, only imports:
 * 1. Messages sent by the user
 * 2. Context around those messages (to capture conversations)
 *
 * Extracted from an earlier local import path.
 */

import {
  DiscordClient,
  decrementSnowflake,
  incrementSnowflake,
  type NormalizedMessage,
} from "./client";

// How close messages need to be to be considered part of the same session
const DEFAULT_SESSION_GAP_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// At the edges of a session, how far to look for context
const DEFAULT_EDGE_CAP = 100;
const DEFAULT_EDGE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

export interface Session {
  firstMsgId: string;
  lastMsgId: string;
  firstMsgTime: number;
  lastMsgTime: number;
}

export interface SessionContextOptions {
  /** Max messages to fetch before/after session (default 100) */
  edgeCap?: number;
  /** Max time window before/after session in ms (default 3 days) */
  edgeWindowMs?: number;
}

/**
 * Group messages into sessions based on time gaps.
 * Pure function with no dependencies.
 */
export function groupIntoSessions(
  messages: { id: string; timestamp: string }[],
  gapMs: number = DEFAULT_SESSION_GAP_MS
): Session[] {
  if (messages.length === 0) return [];

  const sorted = [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const sessions: Session[] = [];
  const firstMsg = sorted[0];
  let currentSession: Session = {
    firstMsgId: firstMsg.id,
    lastMsgId: firstMsg.id,
    firstMsgTime: new Date(firstMsg.timestamp).getTime(),
    lastMsgTime: new Date(firstMsg.timestamp).getTime(),
  };

  for (let i = 1; i < sorted.length; i++) {
    const msg = sorted[i];
    const msgTime = new Date(msg.timestamp).getTime();

    if (msgTime - currentSession.lastMsgTime <= gapMs) {
      currentSession.lastMsgId = msg.id;
      currentSession.lastMsgTime = msgTime;
    } else {
      sessions.push(currentSession);
      currentSession = {
        firstMsgId: msg.id,
        lastMsgId: msg.id,
        firstMsgTime: msgTime,
        lastMsgTime: msgTime,
      };
    }
  }
  sessions.push(currentSession);

  return sessions;
}

/**
 * Fetch messages for session context - yields batches of messages.
 * For each session, fetches:
 * 1. Context BEFORE first message
 * 2. ALL messages between first and last (full conversation)
 * 3. Context AFTER last message
 */
export async function* fetchSessionContext(
  client: DiscordClient,
  channelId: string,
  sessions: Session[],
  options?: SessionContextOptions
): AsyncGenerator<NormalizedMessage[]> {
  const edgeCap = options?.edgeCap ?? DEFAULT_EDGE_CAP;
  const edgeWindowMs = options?.edgeWindowMs ?? DEFAULT_EDGE_WINDOW_MS;

  for (const session of sessions) {
    // 1. Fetch context BEFORE first message
    const beforeMsgs = await client.fetchMessagesBefore(
      channelId,
      session.firstMsgId,
      edgeCap,
      edgeWindowMs
    );
    if (beforeMsgs.length > 0) {
      yield beforeMsgs;
    }

    // 2. Fetch ALL messages between first and last
    const afterSnowflake = decrementSnowflake(session.firstMsgId);
    const beforeSnowflake = incrementSnowflake(session.lastMsgId);

    for await (const batch of client.fetchMessagesInRange(
      channelId,
      afterSnowflake,
      beforeSnowflake
    )) {
      yield batch;
    }

    // 3. Fetch context AFTER last message
    const afterMsgs = await client.fetchMessagesAfter(
      channelId,
      session.lastMsgId,
      edgeCap,
      edgeWindowMs
    );
    if (afterMsgs.length > 0) {
      yield afterMsgs;
    }
  }
}
