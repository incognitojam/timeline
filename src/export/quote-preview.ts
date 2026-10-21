const MAX_QUOTE_LENGTH = 70;

export function quotePreview(text: string): string {
  const plain = text.replace(/\s+/g, " ").trim();
  // Slice code points so truncating next to an emoji keeps it intact.
  const chars = [...plain];
  return chars.length > MAX_QUOTE_LENGTH
    ? `${chars.slice(0, MAX_QUOTE_LENGTH - 1).join("").trimEnd()}…`
    : plain;
}
