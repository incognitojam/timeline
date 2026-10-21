// Renders the DMG window background at 1x and 2x. Run after changing the
// layout here or in settings.py: bun tools/timeline-app/dmg/render-background.ts
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const here = import.meta.dir;
const web = join(here, "../../../web");
const require = createRequire(join(web, "package.json"));
const { chromium } = require("@playwright/test");

// Must match window_rect and icon_locations in settings.py. The image is taller
// than the window's content area, which loses the title bar's height to it.
const width = 640;
const height = 400;
const iconY = 170;
const appX = 160;
const applicationsX = 480;

// Finder's icon label colour isn't configurable, so the background sits at the
// luminance where both black and white text pass WCAG AA (4.5:1).
const background = "#7a6fa3";
const ink = "#fdf7ff";

// setContent pages are about:blank, which cannot load file:// fonts.
const font = async (pkg: string, file: string) => {
  const data = await Bun.file(join(dirname(require.resolve(`${pkg}/package.json`)), "files", file)).bytes();
  return `url(data:font/woff2;base64,${Buffer.from(data).toString("base64")})`;
};

const ticks = Array.from({ length: Math.floor((width - 80) / 16) + 1 }, (_, i) => {
  const x = 40 + i * 16;
  const major = i % 5 === 0;
  return `<line x1="${x}" x2="${x}" y1="${iconY - (major ? 7 : 3)}" y2="${iconY + (major ? 7 : 3)}" stroke-opacity="${major ? 0.55 : 0.3}"/>`;
}).join("");

const html = `<!doctype html>
<style>
  @font-face { font-family: Fraunces; src: ${await font("@fontsource-variable/fraunces", "fraunces-latin-wght-normal.woff2")}; font-weight: 100 900; }
  @font-face { font-family: Plex; src: ${await font("@fontsource/ibm-plex-mono", "ibm-plex-mono-latin-500-normal.woff2")}; font-weight: 500; }
  html, body { margin: 0; }
  body { width: ${width}px; height: ${height}px; background: ${background}; color: ${ink}; position: relative; overflow: hidden; }
  svg { position: absolute; inset: 0; }
  h1 { position: absolute; left: 40px; top: 34px; margin: 0; font: 600 34px/1 Fraunces; letter-spacing: -0.01em; }
  p { position: absolute; margin: 0; font: 500 11px/1 Plex; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.8; }
  .caption { left: 41px; top: 78px; }
  .next { left: 0; right: 0; top: 296px; text-align: center; }
</style>
<svg width="${width}" height="${height}" stroke="${ink}" fill="none">
  <line x1="40" x2="${width - 40}" y1="${iconY}" y2="${iconY}" stroke-opacity="0.45"/>
  ${ticks}
  <rect x="${(appX + applicationsX) / 2 - 22}" y="${iconY - 12}" width="44" height="24" fill="${background}" stroke="none"/>
  <path d="M ${(appX + applicationsX) / 2 - 14} ${iconY} h 26 m -9 -8 l 9 8 l -9 8" stroke-width="2.5" stroke-linecap="square"/>
</svg>
<h1>Timeline</h1>
<p class="caption">Drag to Applications to install</p>
<p class="next">Then open it. Timeline lives in the menu bar.</p>`;

const browser = await chromium.launch();
try {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    await page.setContent(html);
    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].every((face) => face.status === "loaded");
    });
    if (!loaded) throw new Error("DMG background fonts failed to load");
    await page.screenshot({ path: join(here, scale === 1 ? "background.png" : `background@${scale}x.png`) });
    await page.close();
  }
} finally {
  await browser.close();
}
