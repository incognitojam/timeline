/**
 * Minimal CSV parser shared by the file-based export parsers (Amex, Fitbit,
 * LinkedIn, Reddit). Handles quoted fields with embedded commas, newlines,
 * and escaped quotes — Amex addresses routinely span multiple lines inside
 * one field. Header keys are trimmed; pass `trimValues` for exports with
 * padded cells (Fitbit).
 */
export function parseCSV(
  content: string,
  options: { trimValues?: boolean } = {}
): Record<string, string>[] {
  const trimValues = options.trimValues ?? false;
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === '"') {
      current += char; // Keep the quote for parseCSVLine
      if (inQuotes && content[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "\n" && !inQuotes) {
      lines.push(current);
      current = "";
    } else if (char !== "\r") {
      current += char;
    }
  }
  if (current) lines.push(current);

  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0], trimValues);
  const results: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i], trimValues);
    if (values.length >= headers.length) {
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => (row[h.trim()] = values[idx] || ""));
      results.push(row);
    }
  }

  return results;
}

function parseCSVLine(line: string, trimValues: boolean): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(trimValues ? current.trim() : current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(trimValues ? current.trim() : current);
  return result;
}
