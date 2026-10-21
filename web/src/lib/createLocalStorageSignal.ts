import { createSignal } from "solid-js";

export function createLocalStorageSignal<T>(
  key: string,
  defaultValue: T,
  options?: {
    serialize?: (value: T) => string;
    deserialize?: (raw: string) => T;
  },
): [() => T, (value: T) => void] {
  const serialize = options?.serialize ?? JSON.stringify;
  const deserialize = options?.deserialize ?? JSON.parse;

  let initial = defaultValue;
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored !== null) initial = deserialize(stored);
    } catch {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* storage unavailable */
      }
    }
  }

  const [value, setValue] = createSignal<T>(initial);

  const set = (next: T) => {
    setValue(() => next);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, serialize(next));
    } catch {
      // Storage full or unavailable — signal still updates in-memory
    }
  };

  return [value, set];
}
