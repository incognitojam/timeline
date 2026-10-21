import { describe, test, expect } from "bun:test";
import { httpRetry, isTransientHttpError } from "./http-retry";

describe("isTransientHttpError (default policy)", () => {
  test("retries anything carrying a numeric status >= 500", () => {
    expect(isTransientHttpError({ status: 500 })).toBe(true);
    expect(isTransientHttpError({ status: 503 })).toBe(true);
    // Works by duck-typing, so it covers any error class with a `status`.
    expect(isTransientHttpError(Object.assign(new Error("x"), { status: 502 }))).toBe(true);
  });

  test("treats 4xx (incl. 429) and statusless errors as permanent", () => {
    expect(isTransientHttpError({ status: 400 })).toBe(false);
    expect(isTransientHttpError({ status: 404 })).toBe(false);
    expect(isTransientHttpError({ status: 429 })).toBe(false);
    expect(isTransientHttpError({ status: "500" })).toBe(false); // non-numeric
    expect(isTransientHttpError(new Error("boom"))).toBe(false);
    expect(isTransientHttpError("nope")).toBe(false);
  });

  test("retries network errors (fetch rejects with a TypeError)", () => {
    expect(isTransientHttpError(new TypeError("fetch failed"))).toBe(true);
  });
});

// A transient error worth retrying in these tests.
class TransientError extends Error {}

const isTransient = (error: unknown): boolean => error instanceof TransientError;

describe("httpRetry", () => {
  test("returns the value without retrying on success", async () => {
    let calls = 0;
    const result = await httpRetry(
      async () => {
        calls++;
        return "ok";
      },
      { isTransient },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries transient failures up to maxRetries, then succeeds", async () => {
    let attempts = 0;
    const result = await httpRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new TransientError("flaky");
        return 42;
      },
      { isTransient, maxRetries: 3, baseDelayMs: 0 },
    );
    expect(result).toBe(42);
    expect(attempts).toBe(3); // two failures + one success
  });

  test("re-throws the original error object once retries are exhausted", async () => {
    const boom = new TransientError("still down");
    let attempts = 0;
    const caught = await httpRetry(
      async () => {
        attempts++;
        throw boom;
      },
      { isTransient, maxRetries: 2, baseDelayMs: 0 },
    ).catch((e) => e);

    expect(caught).toBe(boom); // identity preserved, not wrapped
    expect(attempts).toBe(3); // initial attempt + 2 retries
  });

  test("does not retry an error the predicate rejects", async () => {
    const permanent = new Error("unauthorized");
    let attempts = 0;
    const caught = await httpRetry(
      async () => {
        attempts++;
        throw permanent;
      },
      { isTransient, maxRetries: 5, baseDelayMs: 0 },
    ).catch((e) => e);

    expect(caught).toBe(permanent);
    expect(attempts).toBe(1); // non-transient → no retries
  });

  test("maxRetries: 0 disables retrying", async () => {
    let attempts = 0;
    await httpRetry(
      async () => {
        attempts++;
        throw new TransientError("nope");
      },
      { isTransient, maxRetries: 0, baseDelayMs: 0 },
    ).catch(() => {});
    expect(attempts).toBe(1); // single attempt, no retry
  });

  test("falls back to isTransientHttpError when no predicate is given", async () => {
    let retried = 0;
    await httpRetry(
      async () => {
        retried++;
        throw { status: 500 };
      },
      { maxRetries: 2, baseDelayMs: 0 },
    ).catch(() => {});
    expect(retried).toBe(3); // 500 is transient by default → initial + 2 retries

    let permanent = 0;
    await httpRetry(
      async () => {
        permanent++;
        throw { status: 404 };
      },
      { maxRetries: 2, baseDelayMs: 0 },
    ).catch(() => {});
    expect(permanent).toBe(1); // 404 permanent by default → no retry
  });
});
