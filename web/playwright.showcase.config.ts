import { defineConfig } from "@playwright/test";
import browserTests from "./playwright.config";

// README screenshot generation (docs/screenshots/). Run from the repository root:
//   ./scripts/test-browser.sh --config=playwright.showcase.config.ts
// Shares the regression config's Linux guard and production preview server;
// renders showcase.spec.ts only, which the regression config ignores.
export default defineConfig({
  ...browserTests,
  testIgnore: [],
  testMatch: "showcase.spec.ts",
  outputDir: "./test-results-showcase",
  retries: 0,
  projects: [{ name: "showcase" }],
  reporter: [["list"]],
  use: {
    ...browserTests.use,
    // 2x device pixels so README images stay crisp on high-DPI displays.
    deviceScaleFactor: 2,
    timezoneId: "UTC",
    trace: "off",
    viewport: { width: 1440, height: 900 },
  },
});
