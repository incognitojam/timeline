/**
 * Main-thread control for the scheduler worker.
 *
 * Stopping the worker is a handshake, not a kill. The worker runs its own
 * graceful shutdown when it receives `{ type: "shutdown" }` — `runner.stop()`
 * interrupts and requeues the in-flight job, then the scheduler and inbox
 * watcher stop — and only then does it `process.exit(0)` on its own.
 *
 * The main thread must wait for that exit before calling `terminate()`: a bare
 * `terminate()` immediately after `postMessage` stops the worker thread at once
 * and races out the cleanup, leaving the in-flight job stuck `running` (it is
 * then recovered only by the next boot's `failAllRunningJobs`, i.e. failed).
 *
 * `terminate()` is a bounded fallback for a worker that does not exit in time —
 * e.g. an event-loop-blocking (CPU-bound) handler that stalls the shutdown
 * sequence, or a component stop (`scheduler.stopAndWait`) that overruns its own
 * timeout. An async handler that merely ignores its `AbortSignal` does not delay
 * exit: Effect detaches the orphaned promise on interrupt and `process.exit(0)`
 * discards it.
 */

/** The slice of `worker_threads`' `Worker` this helper needs (kept minimal so it can be faked in tests). */
export interface StoppableWorker {
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
  once(event: "exit", listener: (code: number) => void): unknown;
}

/**
 * Ask the worker to shut down gracefully and wait for it to exit on its own,
 * forcing `terminate()` only if it does not exit within `timeoutMs`.
 *
 * Returns `{ forced: true }` when the timeout fallback fired.
 */
export async function gracefullyStopWorker(
  worker: StoppableWorker,
  timeoutMs: number
): Promise<{ forced: boolean }> {
  const exited = new Promise<void>((resolve) => {
    worker.once("exit", () => resolve());
  });

  worker.postMessage({ type: "shutdown" });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });

  const forced = await Promise.race([exited.then(() => false), timedOut]);
  if (timer) clearTimeout(timer);

  if (forced) {
    // Worker did not exit in time — stop it the hard way.
    await worker.terminate();
  }

  return { forced };
}
