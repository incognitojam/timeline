import { describe, expect, test } from "bun:test";
import { gracefullyStopWorker, type StoppableWorker } from "./worker-control";

describe("scheduler/worker-control", () => {
  test("posts shutdown and waits for the worker to exit itself, without terminating", async () => {
    const exitListeners: Array<(code: number) => void> = [];
    let postedShutdown = false;
    let terminated = false;

    const worker: StoppableWorker = {
      postMessage: (value) => {
        if ((value as { type?: string }).type === "shutdown") {
          postedShutdown = true;
          // Model the worker finishing its graceful shutdown and exiting itself.
          queueMicrotask(() => {
            for (const cb of exitListeners) cb(0);
          });
        }
      },
      terminate: async () => {
        terminated = true;
        return 0;
      },
      once: (_event, listener) => {
        exitListeners.push(listener);
        return undefined;
      },
    };

    const { forced } = await gracefullyStopWorker(worker, 1000);

    expect(postedShutdown).toBe(true);
    // The worker exited on its own, so no forced terminate was needed.
    expect(forced).toBe(false);
    expect(terminated).toBe(false);
  });

  test("forces terminate when the worker does not exit before the timeout", async () => {
    let terminated = false;

    const worker: StoppableWorker = {
      // Worker hangs: it never emits "exit".
      postMessage: () => {},
      terminate: async () => {
        terminated = true;
        return 1;
      },
      once: () => undefined,
    };

    const { forced } = await gracefullyStopWorker(worker, 10);

    expect(forced).toBe(true);
    expect(terminated).toBe(true);
  });
});
