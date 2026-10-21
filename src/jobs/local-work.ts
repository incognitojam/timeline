/** FIFO ownership of local work, retained until the actual callback settles. */
export class LocalWorkGate {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = this.waiters.indexOf(ready);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(signal?.reason);
      };
      this.waiters.push(ready);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async run<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      // Do not release on AbortSignal alone: an importer may ignore it while
      // it still owns a SQLite transaction across an await.
      const next = this.waiters.shift();
      if (next) next();
      else this.held = false;
    }
  }
}

/** API/CLI callers run directly; the scheduler supplies its shared guard. */
export async function runLocalWork<T>(
  gate: LocalWorkGate | undefined,
  signal: AbortSignal | undefined,
  work: () => T | Promise<T>,
): Promise<T> {
  if (gate) return gate.run(work, signal);
  signal?.throwIfAborted();
  return work();
}
