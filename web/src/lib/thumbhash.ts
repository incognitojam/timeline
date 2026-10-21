import { thumbHashToDataURL } from "thumbhash";
import type { Attachment } from "./api";

/** Module-level cache to avoid repeated decoding across remounts. */
const thumbhashCache = new Map<string, string | null>();

/**
 * Decode a base64-encoded ThumbHash to a data URL for use as a placeholder.
 * Returns null if the hash is invalid or decoding fails. Results are cached.
 */
export function decodeThumbHash(base64: string): string | null {
  const cached = thumbhashCache.get(base64);
  if (cached !== undefined) return cached;

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const result = thumbHashToDataURL(bytes);
    thumbhashCache.set(base64, result);
    return result;
  } catch {
    thumbhashCache.set(base64, null);
    return null;
  }
}

/**
 * Get a thumbhash data URL for an attachment, or null.
 */
export function getThumbhashUrl(attachment: Pick<Attachment, "thumbhash">): string | null {
  if (!attachment.thumbhash || attachment.thumbhash === "error") return null;
  return decodeThumbHash(attachment.thumbhash);
}
