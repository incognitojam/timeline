/**
 * Extract a stable conversation identifier from a parser's `raw_data` payload.
 *
 * The events table groups conversations by `(source, source_account, title)`,
 * but `title` is derived from human-changeable names (Discord channel names,
 * Skype display names, Claude conversation titles, etc.). When a user renames
 * a chat, the messages before and after the rename land with different titles,
 * fragmenting the conversation.
 *
 * Most sources already preserve a stable identifier inside `raw_data`. Lifting
 * it into a first-class column lets queries collapse renamed chats back into
 * one conversation. Rows whose raw_data predates its source's identifier
 * capture (facebook rows from before conversation metadata capture) return `null`
 * and continue to use title-based grouping via `COALESCE`.
 */
import { isPhoneNumberLike, normalizePhoneNumber } from "../lib/phone";
import { normalizeRedditParticipant } from "../lib/reddit";

/**
 * Group MMS joins the participants with `~`. Normalize each participant so
 * national and international forms of one number key together, and sort so
 * the key doesn't depend on participant order. Non-phone participants (RCS
 * group ids, alphanumeric sender ids like "Example 2 UK") pass through verbatim —
 * normalizePhoneNumber would reduce them to their stray digits.
 */
function phoneAddressKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parts = raw
    .split("~")
    .map((part) => (isPhoneNumberLike(part) ? normalizePhoneNumber(part) : part.trim()))
    .filter((part) => part !== "");
  if (parts.length === 0) return null;
  return parts.sort().join("~");
}

export function extractConversationId(source: string, rawData: unknown): string | null {
  if (!rawData || typeof rawData !== "object") return null;
  const data = rawData as Record<string, unknown>;

  switch (source) {
    case "discord": {
      const channel = data._channel as { id?: unknown } | undefined;
      return typeof channel?.id === "string" ? channel.id : null;
    }
    case "skype": {
      const conv = data._conversation as { id?: unknown } | undefined;
      if (typeof conv?.id === "string") return conv.id;
      // Legacy desktop main.db rows store conversation fields at the top
      // level of raw_data instead of under _conversation.
      const chatname = typeof data.chatname === "string" && data.chatname !== "" ? data.chatname : null;
      // Facebook-bridged chats: the xmpp address is the conversation identity.
      if (chatname?.startsWith("xmpp:")) return chatname;
      // DMs: key on the partner in the modern `8:<skypename>` shape so a
      // thread present in both a legacy and a modern export unifies. The
      // chatname is NOT usable here: each `#a/$b;hex` names a P2P chat
      // *session* (fresh hex per session, creator order flips), so one DM
      // spans many chatnames.
      const partner = typeof data.dialog_partner === "string" && data.dialog_partner !== "" ? data.dialog_partner : null;
      if (partner) return `8:${partner}`;
      // Group chats and conference-call sessions (dialog_partner is null):
      // the chatname is stable for these.
      return chatname;
    }
    case "claude":
      return typeof data.conversation_uuid === "string" ? data.conversation_uuid : null;
    case "chatgpt":
      return typeof data.conversation_id === "string" ? data.conversation_id : null;
    case "conductor":
    case "claude-code":
    case "opencode":
    case "codex":
      return typeof data.session_id === "string" ? data.session_id : null;
    case "amp":
    case "t3code":
      return typeof data.thread_id === "string" ? data.thread_id : null;
    case "instagram": {
      // The parser attaches a conversation block to every message row; its
      // thread_path is the export's stable thread folder (e.g.
      // "inbox/<name>_<threadid>"), synthesized from category/folder when an
      // export omits it.
      const conv = data.conversation as { thread_path?: unknown } | undefined;
      return typeof conv?.thread_path === "string" && conv.thread_path !== "" ? conv.thread_path : null;
    }
    case "phone":
      // SMS/MMS rows store the counterparty address in `address`, call rows
      // in `number`.
      return phoneAddressKey(data.address ?? data.number);
    case "google-messages":
      // The importer writes the counterparties in the same `~`-joined shape
      // so a chat keys identically to its SMS Backup & Restore copy.
      return phoneAddressKey(data.address);
    case "facebook": {
      // The parser records the oldest-message timestamp used in its stable
      // `msg:<first_message_ts>:...` source_id. Facebook renamed pre-2021
      // `<slug>_<alphanumeric>` folders to newer numeric-id folders without
      // preserving that id in the old export, but this timestamp survives the
      // rename. Keep thread_path only as a compatibility fallback for rows
      // imported before first_message_ts was captured.
      const conv = data.conversation as {
        first_message_ts?: unknown;
        thread_path?: unknown;
      } | undefined;
      if (typeof conv?.first_message_ts === "number" && Number.isSafeInteger(conv.first_message_ts)) {
        return String(conv.first_message_ts);
      }
      if (typeof conv?.thread_path !== "string") return null;
      const folder = conv.thread_path.split("/").at(-1) ?? "";
      if (folder === "") return null;
      const numericId = folder.match(/(?:^|_)(\d{10,})$/);
      return numericId ? numericId[1] : folder;
    }
    case "google-chat": {
      // The Takeout message_id is "<space_id>/<topic_id>/<message>"; the
      // first segment is the stable space/DM identity (it also names the
      // export folder), constant across renames and export eras.
      const messageId = data.message_id;
      if (typeof messageId !== "string") return null;
      const spaceId = messageId.split("/")[0];
      return spaceId !== "" && spaceId !== messageId ? spaceId : null;
    }
    case "reddit": {
      // Only message rows carry `from`/`to`; posts, comments, votes, and
      // saves fall through to null. The export's `thread_id` is NOT usable
      // as the key: most archived messages predate it and carry an empty
      // string, which would collapse them into one thread. Instead the key
      // is synthesized from the sorted normalized participants, which also
      // unifies a partner's threaded and pre-threading messages.
      const participants = [data.from, data.to]
        .filter((v): v is string => typeof v === "string")
        .map((v) => normalizeRedditParticipant(v)?.platformId)
        .filter((v): v is string => typeof v === "string");
      if (participants.length === 0) return null;
      return [...new Set(participants)].sort().join("~");
    }
    case "linkedin": {
      // Message rows preserve the LinkedIn export's stable `CONVERSATION ID`
      // column verbatim in raw_data. Other record types (connections,
      // positions, education) lack it and fall through to null.
      const convId = data["CONVERSATION ID"];
      return typeof convId === "string" && convId !== "" ? convId : null;
    }
    default:
      return null;
  }
}

/** Sources for which `extractConversationId` can return a non-null value. */
export const SOURCES_WITH_CONVERSATION_ID = [
  "discord",
  "skype",
  "claude",
  "chatgpt",
  "conductor",
  "claude-code",
  "opencode",
  "amp",
  "t3code",
  "codex",
  "linkedin",
  "instagram",
  "phone",
  "google-messages",
  "reddit",
  "google-chat",
  "facebook",
] as const;
