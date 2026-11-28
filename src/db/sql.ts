import { QueryTimeoutError, type QueryExecutor } from "./pool";

export interface RunSqlResult {
  rows: Record<string, unknown>[];
  count: number;
  error?: string;
  timeout?: QueryTimeoutError;
}

/**
 * Execute a raw SQL query with safety validation.
 * Only SELECT queries are allowed. Dangerous keywords are blocked.
 * Returns at most maxRows results.
 */
export async function runReadOnlySql(db: QueryExecutor, sql: string, maxRows = 150): Promise<RunSqlResult> {
  // Validate that this is a SELECT or WITH query
  const trimmed = sql.trim().toLowerCase();
  if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
    return { rows: [], count: 0, error: "Only SELECT queries are allowed" };
  }

  // Check for dangerous keywords
  const dangerous = ["insert", "update", "delete", "drop", "alter", "create", "truncate", "exec", "execute"];
  for (const pattern of dangerous) {
    if (new RegExp(`\\b${pattern}\\b`, "i").test(sql)) {
      return { rows: [], count: 0, error: `Query contains disallowed keyword: ${pattern}` };
    }
  }

  try {
    const results = await db.query<Record<string, unknown>>(sql);
    return {
      rows: results.slice(0, maxRows),
      count: results.length,
    };
  } catch (error) {
    if (error instanceof QueryTimeoutError) {
      return {
        rows: [],
        count: 0,
        error: error.message,
        timeout: error,
      };
    }

    return {
      rows: [],
      count: 0,
      error: error instanceof Error ? error.message : "Query execution failed",
    };
  }
}

export interface RawDataSchema {
  source: string;
  type?: string;
  sampleCount: number;
  paths: string[];  // e.g. ["$.id", "$.merchant.name", "$.attachments[].filename"]
  sample: Record<string, unknown>;  // One truncated example
}

/**
 * Recursively extract JSON paths from an object
 */
function extractPaths(obj: unknown, prefix: string, paths: Set<string>): void {
  if (obj === null || obj === undefined) return;

  if (Array.isArray(obj)) {
    paths.add(prefix + "[]");
    if (obj.length > 0) {
      extractPaths(obj[0], prefix + "[]", paths);
    }
  } else if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix + "." + key;
      paths.add(path);
      extractPaths(value, path, paths);
    }
  }
  // Primitives: path already added by parent
}

/**
 * Truncate long strings in sample for display
 */
function truncateValues(obj: unknown, maxLen = 50): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return obj.length > maxLen ? obj.slice(0, maxLen) + "..." : obj;
  }
  if (Array.isArray(obj)) {
    return obj.slice(0, 2).map(v => truncateValues(v, maxLen));
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = truncateValues(v, maxLen);
    }
    return result;
  }
  return obj;
}

/**
 * Get the JSON schema of raw_data for a source/type.
 * Returns field paths that can be used with json_extract() in SQL queries.
 */
export async function getRawDataSchema(db: QueryExecutor, options: {
  source: string;
  type?: string;
  sampleSize?: number;
}): Promise<RawDataSchema> {
  const { source, type, sampleSize = 5 } = options;

  // Query sample events
  let sql = "SELECT raw_data FROM events WHERE source = ?";
  const params: (string | number)[] = [source];
  if (type) {
    sql += " AND type LIKE ?";
    params.push(type + "%");
  }
  sql += " ORDER BY timestamp DESC LIMIT ?";
  params.push(sampleSize);

  const rows = await db.query<{ raw_data: string }>(sql, ...params);

  // Extract and merge all JSON paths from samples
  const allPaths = new Set<string>();
  let sample: Record<string, unknown> = {};

  for (const row of rows) {
    const data = JSON.parse(row.raw_data);
    if (Object.keys(sample).length === 0) sample = data;
    extractPaths(data, "$", allPaths);
  }

  return {
    source,
    type,
    sampleCount: rows.length,
    paths: Array.from(allPaths).sort(),
    sample: truncateValues(sample) as Record<string, unknown>,
  };
}
