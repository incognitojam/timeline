import { describe, test, expect, afterEach } from "bun:test";
import { TraktApiError, traktGet } from "./trakt-api";

const config = { client_id: "test-id", client_secret: "test-secret" };
const tokens = {
  access_token: "test-token",
  refresh_token: "test-refresh",
  expires_at: 9_999_999_999_000,
  created_at: 0,
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// The retry policy itself (which statuses are transient, backoff, exhaustion)
// lives in http-retry.test.ts. These tests cover only what is trakt-specific:
// that traktGet emits a TraktApiError carrying the status the shared policy
// reads, and passes successful responses through the wrapper intact.
describe("traktGet", () => {
  test("returns parsed data and passes the pagination header through the wrapper", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ id: 1 }]), {
        status: 200,
        headers: { "X-Pagination-Page-Count": "3" },
      })) as unknown as typeof fetch;

    const { data, headers } = await traktGet<Array<{ id: number }>>(
      config,
      tokens,
      "/sync/history",
    );

    expect(data).toEqual([{ id: 1 }]);
    // fetchHistory drives pagination off this header — it must survive httpRetry.
    expect(headers.get("X-Pagination-Page-Count")).toBe("3");
  });

  test("surfaces a non-2xx as TraktApiError with its status, and does not retry a 404", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const error = await traktGet(config, tokens, "/sync/history").catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(TraktApiError);
    expect(error.status).toBe(404);
    expect(calls).toBe(1); // 404 < 500 → default policy permanent, no retry
  });
});
