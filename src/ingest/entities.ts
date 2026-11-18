/** Decodes the XML/HTML character entities found in exported text: the five named ones and decimal or hex code points. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, code) => {
      const num = Number(code);
      return num >= 0 && num <= 0x10ffff ? String.fromCodePoint(num) : match;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (match, code) => {
      const num = parseInt(code, 16);
      return num >= 0 && num <= 0x10ffff ? String.fromCodePoint(num) : match;
    })
    // &amp; last so we don't double-decode entities that contained a literal "&amp;"
    .replace(/&amp;/g, "&");
}
