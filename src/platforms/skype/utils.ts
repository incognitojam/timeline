/**
 * Shared utilities for Skype parsers (legacy and modern)
 *
 * Handles partlist XML parsing for call events.
 */

import { decodeEntities } from "../../ingest/entities";

export interface CallParticipant {
  identity: string; // Skype username or phone number
  name: string | null; // Display name from <name> tag
  duration: number | null; // Duration in ms (null = didn't connect)
}

/** Decodes entities in optional Skype text; empty or missing text is null. */
export function decodeHtmlEntities(text: string | null | undefined): string | null {
  return text ? decodeEntities(text) : null;
}

/**
 * Parse <partlist> XML to extract call participants
 *
 * XML structure:
 * <partlist alt="">
 *   <part identity="username">
 *     <name>Display Name</name>
 *     <duration>seconds</duration>
 *   </part>
 * </partlist>
 */
export function parsePartlist(bodyXml: string | null | undefined): CallParticipant[] {
  if (!bodyXml) return [];

  const participants: CallParticipant[] = [];

  // Match all <part identity="...">...</part> blocks
  const partRegex = /<part\s+identity="([^"]+)">([\s\S]*?)<\/part>/g;
  let match: RegExpExecArray | null;

  while ((match = partRegex.exec(bodyXml)) !== null) {
    const identity = match[1];
    const content = match[2];

    // Extract name (decode HTML entities)
    const nameMatch = content.match(/<name>([^<]*)<\/name>/);
    const rawName = nameMatch ? nameMatch[1] : null;
    const name = decodeHtmlEntities(rawName);

    // Extract duration in seconds, convert to ms
    const durationMatch = content.match(/<duration>(\d+(?:\.\d+)?)<\/duration>/);
    const duration = durationMatch
      ? Math.round(parseFloat(durationMatch[1]) * 1000)
      : null;

    participants.push({ identity, name, duration });
  }

  return participants;
}

/**
 * Get call duration from participants
 *
 * Returns the maximum duration among all participants, or null if no one connected.
 * Different participants may have different durations (e.g., one person joins late).
 */
export function getCallDuration(participants: CallParticipant[]): number | null {
  let maxDuration: number | null = null;

  for (const p of participants) {
    if (p.duration !== null) {
      if (maxDuration === null || p.duration > maxDuration) {
        maxDuration = p.duration;
      }
    }
  }

  return maxDuration;
}
