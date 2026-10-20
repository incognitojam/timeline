import { defineConfig } from "@playwright/test";
import { parsePort, t3WorkspacePort } from "../scripts/ports";

const ignoreSnapshots = process.env.PLAYWRIGHT_IGNORE_SNAPSHOTS === "1";

if (
  (process.platform !== "linux" || process.arch !== "x64") &&
  !ignoreSnapshots
) {
  throw new Error(
    "Screenshot baselines require Linux x64. Run ./scripts/test-browser.sh from the repository root (add --update-snapshots to update them).",
  );
}

function resolvePort(): number {
  const explicitPort = process.env.PLAYWRIGHT_PORT;
  if (explicitPort !== undefined) {
    return parsePort(explicitPort, "PLAYWRIGHT_PORT");
  }

  return t3WorkspacePort("playwright") ?? 4173;
}

const port = resolvePort();
const chartViews = ["month", "week", "year"];

export default defineConfig({
  testDir: "./e2e",
  // README screenshot generation lives in its own config (playwright.showcase.config.ts).
  testIgnore: "showcase.spec.ts",
  outputDir: "./test-results",
  ignoreSnapshots,
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}{ext}",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  // Schedule the slow sweeps first locally and run each resolution in its own CI job.
  projects: [
    ...chartViews.map((view) => ({
      name: `chart-${view}`,
      grep: new RegExp(`health chart width sweep ${view}$`),
    })),
    {
      name: "workflows",
      grepInvert: new RegExp(`health chart width sweep (${chartViews.join("|")})$`),
    },
  ],
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    colorScheme: "dark",
    locale: "en-GB",
    contextOptions: { reducedMotion: "reduce" },
    timezoneId: "Europe/London",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: `bun run build && bun run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    env: { VITE_MAPTILER_API_KEY: "playwright-test" },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
