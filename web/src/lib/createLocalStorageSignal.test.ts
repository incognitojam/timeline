import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { createLocalStorageSignal } from "./createLocalStorageSignal";

beforeEach(() => {
  window.localStorage.clear();
});

describe("createLocalStorageSignal", () => {
  it("returns defaultValue when nothing is stored", () => {
    createRoot((dispose) => {
      const [value] = createLocalStorageSignal("key", "default");
      expect(value()).toBe("default");
      dispose();
    });
  });

  it("reads initial value from localStorage", () => {
    window.localStorage.setItem("key", JSON.stringify("saved"));
    createRoot((dispose) => {
      const [value] = createLocalStorageSignal("key", "default");
      expect(value()).toBe("saved");
      dispose();
    });
  });

  it.each([
    { name: "strings", initial: "default", updated: "updated" },
    { name: "objects", initial: { a: 1 }, updated: { a: 2 } },
  ])("updates and persists $name", ({ initial, updated }) => {
    createRoot((dispose) => {
      const [value, setValue] = createLocalStorageSignal<string | { a: number }>("key", initial);
      expect(value()).toEqual(initial);
      setValue(updated);
      expect(value()).toEqual(updated);
      expect(window.localStorage.getItem("key")).toBe(JSON.stringify(updated));
      dispose();
    });
  });

  it("falls back to defaultValue on malformed localStorage data", () => {
    window.localStorage.setItem("key", "not-valid-json");
    createRoot((dispose) => {
      const [value] = createLocalStorageSignal("key", "default");
      expect(value()).toBe("default");
      expect(window.localStorage.getItem("key")).toBeNull();
      dispose();
    });
  });

  it("handles localStorage.setItem failure gracefully", () => {
    createRoot((dispose) => {
      const [value, setValue] = createLocalStorageSignal("key", "default");
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceededError");
      });
      setValue("updated");
      // Signal still updates even though storage failed
      expect(value()).toBe("updated");
      vi.restoreAllMocks();
      dispose();
    });
  });

  it("handles localStorage.getItem failure gracefully", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    createRoot((dispose) => {
      const [value] = createLocalStorageSignal("key", "default");
      expect(value()).toBe("default");
      vi.restoreAllMocks();
      dispose();
    });
  });

  it("reads and writes with custom serialize/deserialize", () => {
    window.localStorage.setItem("key", "raw-value");
    createRoot((dispose) => {
      const [value, setValue] = createLocalStorageSignal("key", "default", {
        serialize: (v) => v,
        deserialize: (v) => v,
      });
      expect(value()).toBe("raw-value");
      setValue("raw-string");
      expect(window.localStorage.getItem("key")).toBe("raw-string");
      expect(value()).toBe("raw-string");
      dispose();
    });
  });


  it("handles null as a stored value", () => {
    window.localStorage.setItem("key", JSON.stringify(null));
    createRoot((dispose) => {
      const [value] = createLocalStorageSignal<string | null>("key", "default");
      expect(value()).toBeNull();
      dispose();
    });
  });
});
