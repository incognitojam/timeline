/**
 * Phone-number helpers shared by the SMS Backup & Restore parser and the
 * conversation-id extractor. Kept in a leaf module so `src/db` code can use
 * them without importing the parser.
 */

/** Identity platform for phone numbers, whichever source captured them. */
export const PHONE_IDENTITY_PLATFORM = "phone";

/** Sources whose participants are phone numbers (identities on PHONE_IDENTITY_PLATFORM). */
export const PHONE_IDENTITY_SOURCES: ReadonlySet<string> = new Set(["phone", "google-messages"]);

export function isPhoneNumberLike(str: string): boolean {
  return /^\+?\d[\d\s()\-]*$/.test(str.trim());
}

export function normalizePhoneNumber(number: string): string {
  // Remove all non-digit characters except +
  const cleaned = number.replace(/[^\d+]/g, "");
  // Normalize UK numbers
  if (cleaned.startsWith("0") && cleaned.length === 11) {
    return "+44" + cleaned.slice(1);
  }
  // Alphanumeric SMS sender IDs (e.g. "ExampleShop", "ExampleCo") have no digits to
  // keep — preserve the trimmed original so the identifier carries the sender,
  // not just "phone:" with an empty platform_id.
  if (!cleaned) return number.trim();
  return cleaned;
}
