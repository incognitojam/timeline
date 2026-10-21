const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input);
}

export function isLoopbackUrl(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    LOOPBACK_IPV4.test(url.hostname)
  );
}

function sanitizedUrl(url: URL): string {
  const sanitized = new URL(url);
  sanitized.username = "";
  sanitized.password = "";
  sanitized.search = "";
  sanitized.hash = "";
  return sanitized.href;
}

function assertNetworkAllowed(url: URL): void {
  const isHttp = url.protocol === "http:" || url.protocol === "https:";
  if (isHttp && !isLoopbackUrl(url)) {
    throw new Error(`External network request blocked during tests: ${sanitizedUrl(url)}`);
  }
}

/**
 * Preserve local HTTP integration tests while failing any external request
 * before it can reach third-party infrastructure.
 */
export function createTestFetchGuard(fetchImpl: typeof fetch): typeof fetch {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assertNetworkAllowed(requestUrl(input));
      return fetchImpl(input, init);
    },
    {
      preconnect(
        url: string | URL,
        options?: Parameters<typeof fetch.preconnect>[1],
      ): void {
        assertNetworkAllowed(new URL(url));
        fetchImpl.preconnect(url, options);
      },
    },
  );
}
