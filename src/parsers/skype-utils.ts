/**
 * Shared utilities for Skype parsers (legacy and modern)
 *
 * Handles partlist XML parsing for call events.
 */

export interface CallParticipant {
  identity: string; // Skype username or phone number
  name: string | null; // Display name from <name> tag
  duration: number | null; // Duration in ms (null = didn't connect)
}

/**
 * Decode HTML entities commonly found in Skype data
 */
export function decodeHtmlEntities(text: string | null | undefined): string | null {
  if (!text) return null;
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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

/**
 * Build people array from call participants
 *
 * Returns display names where available, falling back to identity.
 */
export function buildPeopleArray(participants: CallParticipant[]): string[] {
  return participants.map((p) => p.name || p.identity);
}

/**
 * Build people array for DM calls, ensuring both parties are included
 *
 * For DM calls, we want both parties in the people array even if one
 * didn't answer (missed call). The partlist only shows who actually
 * connected, but for searchability we need both parties.
 *
 * In a DM, there are exactly 2 people:
 * - The author (DB owner / message creator)
 * - The dialog_partner (the other person)
 *
 * @param participants - Parsed from partlist XML
 * @param dialogPartner - The other party in the DM (identity)
 * @param dialogPartnerName - Display name for dialog partner
 * @param author - The author/DB owner (identity)
 * @param authorName - Display name for author
 */
export function buildDmCallPeopleArray(
  participants: CallParticipant[],
  dialogPartner: string | null,
  dialogPartnerName: string | null,
  author: string | null = null,
  authorName: string | null = null
): string[] {
  const people = buildPeopleArray(participants);
  const participantIdentities = new Set(participants.map((p) => p.identity));

  // For DM calls, ensure dialog partner is included even if they didn't answer
  if (dialogPartner && !participantIdentities.has(dialogPartner)) {
    people.push(dialogPartnerName || dialogPartner);
  }

  // Also ensure author is included (the other party in the DM)
  if (author && !participantIdentities.has(author)) {
    // Only add author if not the same as dialog_partner we just added
    if (author !== dialogPartner) {
      people.push(authorName || author);
    }
  }

  return people;
}
