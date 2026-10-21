/**
 * Format model ID into a human-readable name.
 * Uses pattern-based formatting that handles most model naming conventions:
 * - Strips date suffixes (e.g., -20251101)
 * - Converts version numbers (4-5 → 4.5)
 * - Capitalizes words, preserving known acronyms
 *
 * This approach handles new models gracefully without requiring manual updates.
 */
export function formatModelName(modelId: string | null): string {
  if (!modelId) return "Unknown Model";

  // Short names from Conductor's model column (no version info available)
  if (/^opus$/i.test(modelId)) return "Claude Opus";
  if (/^sonnet$/i.test(modelId)) return "Claude Sonnet";
  if (/^haiku$/i.test(modelId)) return "Claude Haiku";

  // Strip date suffixes (e.g., claude-opus-4-5-20251101 → claude-opus-4-5)
  let cleaned = modelId.replace(/-\d{8}$/, "");

  // Convert version patterns (e.g., 4-5 → 4.5)
  cleaned = cleaned.replace(/(\d+)-(\d+)(?=-|$)/g, "$1.$2");

  // Known acronyms that should stay uppercase
  const acronyms = new Set(["gpt", "ai", "llm"]);

  // Format as title case, preserving acronyms
  return cleaned
    .split("-")
    .map((word) => {
      const lower = word.toLowerCase();
      if (acronyms.has(lower)) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}
