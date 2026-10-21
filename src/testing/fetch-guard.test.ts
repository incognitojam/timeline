import { describe, expect, test } from "bun:test";
import { createTestFetchGuard, isLoopbackUrl } from "./fetch-guard";

describe("test fetch guard", () => {
  test("allows loopback HTTP requests", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response("ok");
    }) as typeof fetch;
    const guardedFetch = createTestFetchGuard(fetchImpl);

    await guardedFetch("http://localhost:3001/health");
    await guardedFetch(new URL("http://127.0.0.2:3001/health"));
    await guardedFetch(new Request("http://[::1]:3001/health"));

    expect(calls).toEqual([
      "http://localhost:3001/health",
      "http://127.0.0.2:3001/health",
      "http://[::1]:3001/health",
    ]);
  });

  test("rejects external HTTP requests without calling fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("unexpected");
    }) as unknown as typeof fetch;
    const guardedFetch = createTestFetchGuard(fetchImpl);

    await expect(guardedFetch("https://discord.com/api/v10/users/@me")).rejects.toThrow(
      "External network request blocked during tests: https://discord.com/api/v10/users/@me",
    );
    expect(called).toBe(false);
  });

  test("redacts credentials from blocked request errors", async () => {
    const fetchImpl = (async () => new Response("unexpected")) as unknown as typeof fetch;
    const guardedFetch = createTestFetchGuard(fetchImpl);
    const request = guardedFetch(
      "https://alice:password@example.com/resource?oauth_token=secret#fragment",
    );

    await expect(request).rejects.toThrow(
      "External network request blocked during tests: https://example.com/resource",
    );
    await expect(request).rejects.not.toThrow(/alice|password|oauth_token|secret|fragment/);
  });

  test("guards Bun preconnect while preserving loopback support", () => {
    const calls: string[] = [];
    const fetchImpl = Object.assign(
      async () => new Response("ok"),
      {
        preconnect(url: string | URL): void {
          calls.push(String(url));
        },
      },
    );
    const guardedFetch = createTestFetchGuard(fetchImpl);

    guardedFetch.preconnect("http://localhost:3001");
    expect(() => guardedFetch.preconnect("https://discord.com/api/v10")).toThrow(
      "External network request blocked during tests: https://discord.com/api/v10",
    );
    expect(calls).toEqual(["http://localhost:3001"]);
  });

  test("does not treat private or wildcard addresses as loopback", () => {
    expect(isLoopbackUrl(new URL("http://192.168.1.10"))).toBe(false);
    expect(isLoopbackUrl(new URL("http://0.0.0.0"))).toBe(false);
    expect(isLoopbackUrl(new URL("http://localhost.example.com"))).toBe(false);
    expect(isLoopbackUrl(new URL("http://127.0.0.1.example.com"))).toBe(false);
  });

  test("delegates non-network fetch schemes", async () => {
    const fetchImpl = (async () => new Response("fixture")) as unknown as typeof fetch;
    const response = await createTestFetchGuard(fetchImpl)("data:text/plain,fixture");

    expect(await response.text()).toBe("fixture");
  });
});
