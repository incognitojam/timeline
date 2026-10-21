import { describe, expect, test } from "bun:test";
import { AsyncTtlCache } from "./async-ttl-cache";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve = (_value: T): void => {};
  let reject = (_reason: unknown): void => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AsyncTtlCache", () => {
  test("coalesces concurrent cache fills", async () => {
    const cache = new AsyncTtlCache(60_000);
    const fill = deferred<string>();
    let computations = 0;
    const compute = () => {
      computations++;
      return fill.promise;
    };

    const first = cache.get("stats", compute);
    const second = cache.get("stats", compute);
    await Promise.resolve();

    expect(computations).toBe(1);
    expect([first.status, second.status]).toEqual(["miss", "coalesced"]);

    fill.resolve("computed");
    expect(await Promise.all([first.value, second.value])).toEqual(["computed", "computed"]);

    const cached = cache.get("stats", () => "unexpected");
    expect(cached.status).toBe("hit");
    expect(await cached.value).toBe("computed");
  });

  test("does not retain failed fills", async () => {
    const cache = new AsyncTtlCache(60_000);
    let computations = 0;

    await expect(cache.get("stats", () => {
      computations++;
      throw new Error("failed fill");
    }).value).rejects.toThrow("failed fill");

    expect(await cache.get("stats", () => {
      computations++;
      return "recovered";
    }).value).toBe("recovered");
    expect(computations).toBe(2);
  });

  test("invalidation prevents an older fill from repopulating the cache", async () => {
    const cache = new AsyncTtlCache(60_000);
    const oldFill = deferred<string>();
    const stale = cache.get("stats", () => oldFill.promise).value;
    cache.delete("stats");

    expect(await cache.get("stats", () => "fresh").value).toBe("fresh");
    oldFill.resolve("stale");
    expect(await stale).toBe("stale");
    expect(await cache.get("stats", () => "unexpected").value).toBe("fresh");
  });
});
