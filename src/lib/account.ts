/**
 * Account name utilities shared across parsers.
 */

/**
 * Sanitize a display name into a valid account name.
 * Converts to lowercase, replaces spaces with hyphens, removes non-alphanumeric characters.
 *
 * @example
 * sanitizeAccountName("Alice E.") // => "alice-e"
 * sanitizeAccountName("Alice Example") // => "alice-example"
 */
export function sanitizeAccountName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}
