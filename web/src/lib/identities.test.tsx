import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCache,
  getAvatarUrl,
  getContactId,
  getDisplayName,
  getSenderLabel,
  invalidateCache,
  isResolved,
  populateCache,
  populateCacheFromParticipants,
  resolveIdentifiers,
} from "./identities";

const alice = "discord:alice";
const bob = "discord:bob";

function identity(name: string, contactId: number | null = null, isSelf = false) {
  return { name, username: null, contactId, avatarUrl: null, isSelf };
}

function successfulResponse(resolved: Record<string, ReturnType<typeof identity>>) {
  return new Response(JSON.stringify({ resolved }), { status: 200 });
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (!resolve) throw new Error("Failed to create deferred promise");
  return { promise, resolve };
}

describe("identities", () => {
  afterEach(() => {
    cleanup();
    clearCache();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("updates synchronous display-name reads when entries resolve or are invalidated", () => {
    render(() => <span>{getDisplayName(alice)}</span>);

    expect(screen.getByText("alice")).toBeInTheDocument();

    populateCache({ [alice]: identity("Alice") });
    expect(screen.getByText("Alice")).toBeInTheDocument();

    invalidateCache([alice]);
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("deduplicates identifiers shared by overlapping calls", async () => {
    const firstResponse = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce(successfulResponse({ [bob]: identity("Bob") }));
    vi.stubGlobal("fetch", fetchMock);

    const first = resolveIdentifiers([alice]);
    const second = resolveIdentifiers([alice, bob]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    firstResponse.resolve(successfulResponse({ [alice]: identity("Alice") }));
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestedIdentifiers = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)) as { identifiers: string[] },
    );
    expect(requestedIdentifiers).toEqual([
      { identifiers: [alice] },
      { identifiers: [bob] },
    ]);
  });

  it("waits for the second batch when a concurrent caller adds new identifiers", async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);

    const first = resolveIdentifiers([alice]);
    const second = resolveIdentifiers([bob]);

    firstResponse.resolve(successfulResponse({ [alice]: identity("Alice") }));
    await first;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    secondResponse.resolve(successfulResponse({ [bob]: identity("Bob") }));
    await second;
    expect(getDisplayName(bob)).toBe("Bob");
  });

  it("removes invalidated entries so resolving them fetches fresh data", async () => {
    populateCache({ [alice]: identity("Old Alice", 1) });
    invalidateCache([alice]);

    expect(isResolved(alice)).toBe(false);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      successfulResponse({ [alice]: identity("New Alice", 2) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await resolveIdentifiers([alice]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getDisplayName(alice)).toBe("New Alice");
    expect(getContactId(alice)).toBe(2);
  });

  it("does not cache failed batches so a later call retries", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(successfulResponse({ [alice]: identity("Alice") }));
    vi.stubGlobal("fetch", fetchMock);

    await resolveIdentifiers([alice]);
    expect(isResolved(alice)).toBe(false);

    await resolveIdentifiers([alice]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getDisplayName(alice)).toBe("Alice");
    expect(error).toHaveBeenCalledWith("Failed to resolve identities:", 500);
  });

  it("seeds readers from conversation participants", () => {
    populateCacheFromParticipants({
      [alice]: {
        name: "Alice",
        contactId: 42,
        avatarUrl: "https://example.com/alice.jpg",
        isSelf: false,
      },
    });

    expect(getDisplayName(alice)).toBe("Alice");
    expect(getContactId(alice)).toBe(42);
    expect(getAvatarUrl(alice)).toBe("https://example.com/alice.jpg");
  });

  it("keeps unobserved entries until explicitly removed", () => {
    vi.useFakeTimers();
    populateCache({ [alice]: identity("Alice"), [bob]: identity("Bob") });

    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(getDisplayName(alice)).toBe("Alice");

    invalidateCache([alice]);
    expect(isResolved(alice)).toBe(false);

    clearCache();
    expect(isResolved(bob)).toBe(false);
  });
});

describe("getSenderLabel", () => {
  afterEach(() => {
    clearCache();
  });

  function event(type: string, identifier: string) {
    return { type, people: JSON.stringify([identifier]) };
  }

  it("names other people on every event type", () => {
    populateCache({ [alice]: identity("Alice", 7) });

    expect(getSenderLabel(event("message:dm", alice))).toBe("Alice");
    expect(getSenderLabel(event("listen:track", alice))).toBe("Alice");
  });

  it("calls the user \"You\" on conversation-shaped events", () => {
    populateCache({ [bob]: identity("Owner Example", 1, true) });

    expect(getSenderLabel(event("message", bob))).toBe("You");
    expect(getSenderLabel(event("message:group", bob))).toBe("You");
    expect(getSenderLabel(event("instagram:message:dm", bob))).toBe("You");
    expect(getSenderLabel(event("sms:sent", bob))).toBe("You");
    expect(getSenderLabel(event("mms:received", bob))).toBe("You");
  });

  it("drops the user from their own non-conversation activity", () => {
    populateCache({ [bob]: identity("Owner Example", 1, true) });

    expect(getSenderLabel(event("listen:track", bob))).toBeNull();
    expect(getSenderLabel(event("youtube:watch", bob))).toBeNull();
    expect(getSenderLabel(event("browse", bob))).toBeNull();
  });

  it("returns null when the event has no sender", () => {
    expect(getSenderLabel({ type: "message:dm", people: null })).toBeNull();
  });
});
