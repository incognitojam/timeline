type ResponseLike = { ok: boolean };
type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<ResponseLike>;

export type WaitForServerOptions = {
  url: string;
  /** Ends the wait when it resolves, e.g. the child process exiting. */
  stopWhen?: Promise<unknown>;
  intervalMs?: number;
  requestTimeoutMs?: number;
  /** Give up after this many probes. Unbounded by default. */
  attempts?: number;
  /** Delay before `onSlow` reports that startup is taking a while. */
  slowAfterMs?: number;
  onSlow?: () => void;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls `url` until it answers. Resolves true once it does, or false if
 * `stopWhen` resolves first or `attempts` is exhausted.
 */
export async function waitForServer(options: WaitForServerOptions): Promise<boolean> {
  const {
    url,
    stopWhen,
    intervalMs = 100,
    requestTimeoutMs = 1000,
    attempts = Number.POSITIVE_INFINITY,
    slowAfterMs = 2000,
    onSlow,
    fetch: fetchImpl = fetch,
    sleep = defaultSleep,
    now = () => performance.now(),
  } = options;

  const startedAt = now();
  let stopped = false;
  void stopWhen?.then(() => {
    stopped = true;
  });
  let reportedSlow = false;
  let attempted = 0;

  while (!stopped && attempted < attempts) {
    attempted += 1;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
      // A probe in flight when `stopWhen` resolved must not report ready: the
      // caller is shutting down and would act on a stack that is going away.
      if (response.ok) return !stopped;
    } catch {
      // Not listening yet (or still migrating) - keep polling.
    }
    if (stopped) break;
    if (!reportedSlow && onSlow && now() - startedAt >= slowAfterMs) {
      reportedSlow = true;
      onSlow();
    }
    await sleep(intervalMs);
  }

  return false;
}
