import { createSignal, onCleanup } from "solid-js";

export type ColorScheme = "dark" | "light";

/**
 * Creates a reactive signal that tracks the system color scheme preference.
 * Updates automatically when the user changes their system preference.
 */
export function createColorSchemeSignal(): () => ColorScheme {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const [colorScheme, setColorScheme] = createSignal<ColorScheme>(
    mediaQuery.matches ? "dark" : "light"
  );

  const handleChange = (e: MediaQueryListEvent) => {
    setColorScheme(e.matches ? "dark" : "light");
  };

  mediaQuery.addEventListener("change", handleChange);
  onCleanup(() => mediaQuery.removeEventListener("change", handleChange));

  return colorScheme;
}
