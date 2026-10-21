import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

class MemoryStorage implements Storage {
  #items = new Map<string, string>();

  get length() {
    return this.#items.size;
  }

  clear() {
    this.#items.clear();
  }

  getItem(key: string) {
    return this.#items.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.#items.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.#items.delete(key);
  }

  setItem(key: string, value: string) {
    this.#items.set(key, value);
  }
}

class NoopResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = NoopResizeObserver;
}

function hasLocalStorage() {
  if (typeof window === "undefined") {
    return false;
  }

  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  return descriptor !== undefined && "value" in descriptor && descriptor.value !== undefined;
}

if (typeof window !== "undefined" && !hasLocalStorage()) {
  const localStorage = new MemoryStorage();

  Object.defineProperty(window, "Storage", {
    configurable: true,
    value: MemoryStorage,
  });
  Object.defineProperty(globalThis, "Storage", {
    configurable: true,
    value: MemoryStorage,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: localStorage,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorage,
  });
}

// No test may reach the network. A component that fetches without the test
// saying so is either an unnoticed side effect or a missing stub, and both look
// like a passing test: app code catches the failure and carries on. Recording
// the attempt and failing afterwards makes it say so out loud.
const attemptedRequests: string[] = [];

globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  const request = args[0];
  attemptedRequests.push(
    typeof request === "string" || request instanceof URL ? String(request) : request.url,
  );
  return Promise.reject(new Error("fetch is not available in tests; stub it with vi.stubGlobal"));
}) as typeof fetch;

afterEach(() => {
  const attempted = attemptedRequests.splice(0);
  if (attempted.length > 0) {
    throw new Error(
      `Unstubbed fetch in test: ${[...new Set(attempted)].join(", ")}. `
        + "Stub it with vi.stubGlobal(\"fetch\", ...) to declare what the test expects.",
    );
  }
});
