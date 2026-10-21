import type { Platform } from "../db/schema";

/**
 * Parse a Skype user ID into platform and platformId. Shared by the Skype
 * parser and the identity migration script.
 * - `8:live:username` → { platform: "live", platformId: "username" }
 * - `8:username` → { platform: "skype", platformId: "username" }
 * - XMPP format → { platform: "facebook", platformId: "id" }
 */
export function parseSkypeUserId(skypeId: string): { platform: Platform; platformId: string } {
  // Check for XMPP Facebook format (e.g., "xmpp:-100000123456789@chat.facebook.com")
  const xmppMatch = skypeId.match(/^xmpp:-?(\d+)@chat\.facebook\.com$/);
  if (xmppMatch) {
    return { platform: "facebook", platformId: xmppMatch[1] };
  }

  // Remove leading "8:" prefix if present
  let id = skypeId;
  if (id.startsWith("8:")) {
    id = id.slice(2);
  }

  // Check for Microsoft Live account
  if (id.startsWith("live:")) {
    return { platform: "live", platformId: id.slice(5) };
  }

  // Legacy Skype username
  return { platform: "skype", platformId: id };
}
