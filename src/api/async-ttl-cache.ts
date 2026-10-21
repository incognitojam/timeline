export type CacheLookupStatus = "hit" | "miss" | "coalesced";

export interface CacheLookup<T> {
  status: CacheLookupStatus;
  value: Promise<T>;
}

interface CacheEntry {
  data: unknown;
  expires: number;
}

interface PendingEntry {
  promise: Promise<unknown>;
  token: object;
}

/**
 * Small in-memory TTL cache that coalesces concurrent fills for the same key.
 * Deleting a key removes its active fill token so an older promise cannot
 * repopulate the cache after invalidation.
 */
export class AsyncTtlCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly ttlMs: number) {}

  get<T>(key: string, compute: () => T | Promise<T>): CacheLookup<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expires > Date.now()) {
      return { status: "hit", value: Promise.resolve(cached.data as T) };
    }

    const pending = this.pending.get(key);
    if (pending) {
      return { status: "coalesced", value: pending.promise as Promise<T> };
    }

    const token = {};
    const promise = Promise.resolve()
      .then(compute)
      .then((data) => {
        if (this.pending.get(key)?.token === token) {
          this.entries.set(key, { data, expires: Date.now() + this.ttlMs });
        }
        return data;
      })
      .finally(() => {
        if (this.pending.get(key)?.token === token) {
          this.pending.delete(key);
        }
      });

    this.pending.set(key, { promise, token });
    return { status: "miss", value: promise };
  }

  delete(key: string): void {
    this.entries.delete(key);
    this.pending.delete(key);
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    const keys = new Set([...this.entries.keys(), ...this.pending.keys()]);
    for (const key of keys) {
      if (predicate(key)) this.delete(key);
    }
  }
}
