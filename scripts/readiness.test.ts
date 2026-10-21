import { describe, expect, it } from "bun:test";
import { waitForServer } from "./readiness";

// Yields to the timer queue so a regression that never stops polling trips the
// per-test timeout instead of starving bun's event loop and hanging the suite.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("waitForServer", () => {
  it("resolves true once the server answers", async () => {
    let attempts = 0;
    const ready = await waitForServer({
      url: "http://127.0.0.1:1/api/health",
      sleep: tick,
      fetch: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("ECONNREFUSED");
        return { ok: true };
      },
    });

    expect(ready).toBe(true);
    expect(attempts).toBe(3);
  });

  it("keeps polling while the server answers with an error status", async () => {
    let attempts = 0;
    const ready = await waitForServer({
      url: "http://127.0.0.1:1/api/health",
      sleep: tick,
      fetch: async () => {
        attempts += 1;
        return { ok: attempts >= 2 };
      },
    });

    expect(ready).toBe(true);
    expect(attempts).toBe(2);
  });

  it("resolves false when the process exits first", async () => {
    let attempts = 0;
    let exited = () => {};
    const stopWhen = new Promise<void>((resolve) => {
      exited = resolve;
    });

    const ready = await waitForServer({
      url: "http://127.0.0.1:1/api/health",
      stopWhen,
      sleep: tick,
      fetch: async () => {
        attempts += 1;
        if (attempts === 2) exited();
        throw new Error("ECONNREFUSED");
      },
    });

    expect(ready).toBe(false);
    expect(attempts).toBe(2);
  });

  it("reports a slow start once, without ending the wait", async () => {
    let attempts = 0;
    let elapsed = 0;
    let slowReports = 0;

    const ready = await waitForServer({
      url: "http://127.0.0.1:1/api/health",
      slowAfterMs: 2000,
      onSlow: () => {
        slowReports += 1;
      },
      now: () => elapsed,
      sleep: async () => {
        elapsed += 1000;
        await tick();
      },
      fetch: async () => {
        attempts += 1;
        if (attempts > 5) return { ok: true };
        throw new Error("ECONNREFUSED");
      },
    });

    expect(ready).toBe(true);
    expect(slowReports).toBe(1);
  });

  it("does not report a slow start when the server answers promptly", async () => {
    let slowReports = 0;
    const ready = await waitForServer({
      url: "http://127.0.0.1:1/api/health",
      slowAfterMs: 2000,
      onSlow: () => {
        slowReports += 1;
      },
      now: () => 0,
      sleep: tick,
      fetch: async () => ({ ok: true }),
    });

    expect(ready).toBe(true);
    expect(slowReports).toBe(0);
  });
  it("does not report ready when the process exits during the probe", async () => {
    let exited = () => {};
    const stopWhen = new Promise<void>((resolve) => {
      exited = resolve;
    });

    const ready = await waitForServer({
      url: "http://127.0.0.1:1/api/health",
      stopWhen,
      sleep: tick,
      fetch: async () => {
        // Answers, but the stack it belongs to is already going away.
        exited();
        await tick();
        return { ok: true };
      },
    });

    expect(ready).toBe(false);
  });

  it("gives up after the requested number of attempts", async () => {
    let attempts = 0;
    const ready = await waitForServer({
      url: "http://127.0.0.1:1/api/health",
      attempts: 1,
      sleep: tick,
      fetch: async () => {
        attempts += 1;
        throw new Error("ECONNREFUSED");
      },
    });

    expect(ready).toBe(false);
    expect(attempts).toBe(1);
  });
});
