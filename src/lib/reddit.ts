/**
 * Reddit participant normalization shared by the reddit parser and the
 * conversation-id extractor. Kept in a leaf module so `src/db` code can use
 * it without importing the parser.
 */

/**
 * Normalize a Reddit participant into a qualified identifier.
 * - User: reddit:<username>
 * - Subreddit: reddit:/r/<subreddit>
 */
export function normalizeRedditParticipant(
  value: string
): { identifier: string; platformId: string; displayName: string } | null {
  let clean = value.trim();
  if (!clean) return null;

  // Strip existing platform prefix if present
  if (clean.startsWith("reddit:")) {
    clean = clean.slice("reddit:".length);
  }

  // Subreddit detection: /r/<sub> or r/<sub>
  if (clean.startsWith("/r/") || clean.startsWith("r/")) {
    const subreddit = clean.replace(/^\/?r\//, "");
    if (!subreddit) return null;
    const platformId = `r/${subreddit}`;
    return {
      identifier: `reddit:${platformId}`,
      platformId,
      displayName: `r/${subreddit}`,
    };
  }

  // Strip /u/ or u/ prefix if present for users
  if (clean.startsWith("/u/")) {
    clean = clean.slice(3);
  } else if (clean.startsWith("u/")) {
    clean = clean.slice(2);
  }

  if (!clean) return null;
  return {
    identifier: `reddit:${clean}`,
    platformId: clean,
    displayName: clean,
  };
}
