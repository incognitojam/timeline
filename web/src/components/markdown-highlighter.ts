import type { Theme } from "@pierre/highlights";
import githubDark from "@pierre/highlights/themes/github-dark";
import githubLight from "@pierre/highlights/themes/github-light";
import { createHighlightsPlugin } from "@pierre/words/highlights";

/** The theme with some syntax colours replaced, matched case-insensitively. */
function recolour(theme: Theme, colours: Record<string, string>): Theme {
  const replace = (colour: string) => colours[colour.toLowerCase()] ?? colour;
  const syntax = Object.fromEntries(
    Object.entries(theme.style.syntax ?? {}).map(([scope, style]) => [
      scope,
      typeof style === "string" ? replace(style) : { ...style, color: style.color && replace(style.color) },
    ]),
  );
  return { ...theme, style: { ...theme.style, syntax } };
}

// Colours below 4.5:1 against the code block's background (--color-card) take
// GitHub Primer's darker or lighter equivalents.
const light = recolour(githubLight, {
  "#d73a49": "#cf222e", // keywords, operators
  "#22863a": "#1a7f37", // tags, diff additions
  "#e36209": "#bc4c00", // members, list markers
  "#6a737d": "#59636e", // comments
  "#848d97": "#59636e", // hints
});
const dark = recolour(githubDark, { "#6a737d": "#8b949e" });

// Loaded on demand by Markdown. `light-dark()` follows the color-scheme that
// app.css switches with the app's theme.
export const highlighter = createHighlightsPlugin({ themes: { light, dark }, defaultColor: "light-dark()" });
