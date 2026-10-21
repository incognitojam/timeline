import { Database } from "bun:sqlite";

interface CacheEntry<T> {
  value: T;
  updated_at: string;
}

export function getCache<T>(db: Database, key: string): CacheEntry<T> | null {
  const row = db.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(key) as {
    value: string;
    updated_at: string;
  } | undefined;
  if (!row) return null;
  return {
    value: JSON.parse(row.value) as T,
    updated_at: row.updated_at,
  };
}

export function setCache<T>(db: Database, key: string, value: T): void {
  db.prepare(`
    INSERT INTO cache (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value));
}

export function invalidateCache(db: Database, key: string): void {
  db.prepare("DELETE FROM cache WHERE key = ?").run(key);
}
