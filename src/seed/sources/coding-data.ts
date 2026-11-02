/**
 * Shared material for the coding-agent generators (Claude Code, Amp, OpenCode,
 * Conductor, T3 Code, Codex) and the WakaTime/GitHub generators: Alex's
 * projects, task scripts with realistic prompts/code/tool output, and a
 * planner that turns them into timed, agent-neutral conversations. Each
 * generator only maps these neutral turns into its tool's on-disk format.
 */
import type { SeedContext, SeedDay } from "../context";
import { HOME_DIR, PROJECTS, SELF } from "../persona";
import type { Rng } from "../rng";

/** Account name the coding tools are configured with (also Conductor's branch prefix). */
export const CODING_ACCOUNT = SELF.handle;

export type ProjectName = (typeof PROJECTS)[number]["name"];

export interface CodingProject {
  name: ProjectName;
  repo: string;
  language: string;
  /** Launch directory for agent sessions. */
  dir: string;
  /** Markdown fence language. */
  fence: string;
  testCmd: string;
  testFile: string;
  lintCmd: string;
  lintOk: string;
  /** Relative weight when choosing a project for a session. */
  weight: number;
  passOutput(rng: Rng): string;
  failOutput(rng: Rng, task: CodingTask): string;
}

export interface CodingTask {
  title: string;
  /** Branch suffix (prefixed with the account for branch names). */
  branch: string;
  asks: readonly string[];
  /** Search pattern the agent greps for first. */
  grep: string;
  /** Files touched, relative to the project dir; the first is edited. */
  files: readonly string[];
  /** Line(s) replaced in the edit. */
  before: string;
  /** Replacement code (also quoted in the reply). */
  after: string;
  summary: string;
  /** Task-specific follow-up prompts and replies. */
  followups: readonly { ask: string; reply: string; code?: string }[];
}

export type ToolCall =
  | { kind: "read"; path: string; output: string; at: number; doneAt: number }
  | { kind: "grep"; pattern: string; path: string; output: string; at: number; doneAt: number }
  | { kind: "edit"; path: string; oldText: string; newText: string; output: string; at: number; doneAt: number }
  | { kind: "write"; path: string; content: string; output: string; at: number; doneAt: number }
  | { kind: "bash"; command: string; description: string; output: string; error: boolean; at: number; doneAt: number };

export interface AgentStep {
  at: number;
  text?: string;
  thinking?: string;
  tools: ToolCall[];
}

export interface CodingExchange {
  prompt: string;
  promptAt: number;
  /** Attach a screenshot to this prompt (only for agents that store images). */
  image: boolean;
  steps: AgentStep[];
  reply: string;
  replyAt: number;
}

export interface CodingSession {
  project: CodingProject;
  task: CodingTask;
  title: string;
  slug: string;
  branch: string;
  day: SeedDay;
  start: number;
  end: number;
  exchanges: CodingExchange[];
}

export function fence(lang: string, code: string): string {
  return "```" + lang + "\n" + code.trimEnd() + "\n```";
}

function numbered(code: string, startLine: number): string {
  return code
    .trimEnd()
    .split("\n")
    .map((line, i) => `${String(startLine + i).padStart(6, " ")}\t${line}`)
    .join("\n");
}

const dir = (name: string) => `${HOME_DIR}/code/${name}`;

function project(name: ProjectName): (typeof PROJECTS)[number] {
  const found = PROJECTS.find((p) => p.name === name);
  if (!found) throw new Error(`Unknown project ${name}`);
  return found;
}

export const CODING_PROJECTS: readonly CodingProject[] = [
  {
    name: "trailhead",
    repo: project("trailhead").repo,
    language: "TypeScript",
    dir: dir("trailhead"),
    fence: "ts",
    testCmd: "bun test",
    testFile: "src/routes/trips.test.ts",
    lintCmd: "bun run lint",
    lintOk: "Checked 64 files in 41ms. No fixes applied.",
    weight: 5,
    passOutput: (rng) => {
      const pass = rng.int(38, 71);
      return `bun test v1.2.19\n\nsrc/lib/gpx.test.ts:\n✓ parses track points [1.20ms]\n✓ computes elevation gain [0.41ms]\n\nsrc/routes/trips.test.ts:\n✓ GET /api/trips lists upcoming trips [8.92ms]\n✓ POST /api/trips validates dates [3.10ms]\n\n ${pass} pass\n 0 fail\n ${pass * 3} expect() calls\nRan ${pass} tests across ${rng.int(8, 14)} files. [${rng.int(400, 1400)}.00ms]`;
    },
    failOutput: (rng, task) =>
      `bun test v1.2.19\n\nsrc/routes/trips.test.ts:\n✗ ${task.title.toLowerCase()} [4.11ms]\n\nerror: expect(received).toEqual(expected)\n\n  Expected: 200\n  Received: 500\n\n      at <anonymous> (${dir("trailhead")}/src/routes/trips.test.ts:${rng.int(20, 140)}:24)\n\n ${rng.int(30, 60)} pass\n 1 fail`,
  },
  {
    name: "pocket-ledger",
    repo: project("pocket-ledger").repo,
    language: "Rust",
    dir: dir("pocket-ledger"),
    fence: "rust",
    testCmd: "cargo test",
    testFile: "tests/import_csv.rs",
    lintCmd: "cargo clippy --all-targets -- -D warnings",
    lintOk: "    Checking pocket-ledger v0.4.2 (" + dir("pocket-ledger") + ")\n    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.87s",
    weight: 3,
    passOutput: (rng) => {
      const n = rng.int(14, 40);
      return `   Compiling pocket-ledger v0.4.2 (${dir("pocket-ledger")})\n    Finished \`test\` profile [unoptimized + debuginfo] target(s) in ${rng.int(2, 9)}.${rng.int(10, 99)}s\n     Running unittests src/main.rs (target/debug/deps/pocket_ledger-3f9c2a1b7d4e5f60)\n\nrunning ${n} tests\ntest budget::tests::rolls_over_unspent ... ok\ntest import::csv::tests::parses_monzo_export ... ok\ntest report::tests::monthly_totals ... ok\n\ntest result: ok. ${n} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.0${rng.int(1, 9)}s`;
    },
    failOutput: (rng) =>
      `   Compiling pocket-ledger v0.4.2 (${dir("pocket-ledger")})\nerror[E0502]: cannot borrow \`self.entries\` as mutable because it is also borrowed as immutable\n  --> src/budget.rs:${rng.int(40, 120)}:9\n   |\n   |         let last = self.entries.last();\n   |                    ------------ immutable borrow occurs here\n   |         self.entries.push(entry);\n   |         ^^^^^^^^^^^^^^^^^^^^^^^^ mutable borrow occurs here\n\nerror: could not compile \`pocket-ledger\` (bin "pocket-ledger") due to 1 previous error`,
  },
  {
    name: "dotfiles",
    repo: project("dotfiles").repo,
    language: "Shell",
    dir: dir("dotfiles"),
    fence: "bash",
    testCmd: "./install.sh --dry-run",
    testFile: "tests/install.bats",
    lintCmd: "shellcheck install.sh bin/*",
    lintOk: "",
    weight: 1,
    passOutput: (rng) =>
      `==> Dry run: no files will be changed\n  link  ~/.zshrc -> ${dir("dotfiles")}/zsh/.zshrc\n  link  ~/.config/nvim -> ${dir("dotfiles")}/nvim\n  link  ~/.gitconfig -> ${dir("dotfiles")}/git/.gitconfig\n  skip  ~/.tmux.conf (already linked)\n==> ${rng.int(9, 16)} links, 0 conflicts`,
    failOutput: (rng) =>
      `In install.sh line ${rng.int(10, 80)}:\n  for f in $(ls "$DOTFILES"/bin); do\n           ^-- SC2045 (error): Iterating over ls output is fragile. Use globs.`,
  },
  {
    name: "northwind-ingest",
    repo: project("northwind-ingest").repo,
    language: "Go",
    dir: dir("northwind-ingest"),
    fence: "go",
    testCmd: "go test ./...",
    testFile: "internal/batch/writer_test.go",
    lintCmd: "golangci-lint run ./...",
    lintOk: "0 issues.",
    weight: 4,
    passOutput: (rng) =>
      `ok  \tgithub.com/northwind/ingest/cmd/ingest\t0.${rng.int(100, 400)}s\nok  \tgithub.com/northwind/ingest/internal/batch\t0.${rng.int(100, 900)}s\nok  \tgithub.com/northwind/ingest/internal/kafka\t1.${rng.int(100, 900)}s\nok  \tgithub.com/northwind/ingest/internal/retry\t0.0${rng.int(10, 99)}s\nok  \tgithub.com/northwind/ingest/internal/schema\t0.${rng.int(100, 500)}s`,
    failOutput: (rng) =>
      `--- FAIL: TestWriterFlushesOnSize (0.0${rng.int(1, 9)}s)\n    writer_test.go:${rng.int(30, 90)}: got 2 flushes, want 3\nFAIL\nFAIL\tgithub.com/northwind/ingest/internal/batch\t0.${rng.int(200, 700)}s\nok  \tgithub.com/northwind/ingest/internal/schema\t0.212s\nFAIL`,
  },
  {
    name: "garden-sensors",
    repo: project("garden-sensors").repo,
    language: "Python",
    dir: dir("garden-sensors"),
    fence: "python",
    testCmd: "uv run pytest -q",
    testFile: "tests/test_moisture.py",
    lintCmd: "uv run ruff check .",
    lintOk: "All checks passed!",
    weight: 2,
    passOutput: (rng) => {
      const n = rng.int(12, 34);
      return `${".".repeat(n)}                                    [100%]\n${n} passed in ${rng.int(0, 3)}.${rng.int(10, 99)}s`;
    },
    failOutput: (rng) =>
      `....F......                                    [100%]\n=================================== FAILURES ===================================\n____________________________ test_dry_threshold ____________________________\n\n    def test_dry_threshold():\n>       assert classify(412) == "dry"\nE       AssertionError: assert 'ok' == 'dry'\n\ntests/test_moisture.py:${rng.int(10, 60)}: AssertionError\n1 failed, 10 passed in 0.${rng.int(30, 99)}s`,
  },
];

export const TASKS: Readonly<Record<ProjectName, readonly CodingTask[]>> = {
  trailhead: [
    {
      title: "Add GPX export for trips",
      branch: "gpx-export",
      asks: [
        "Add a GPX export endpoint for trips. GET /api/trips/:id/export.gpx should return the planned route as a GPX 1.1 track so I can load it on my watch.",
        "I want to download a trip's route as GPX. Can you add an export endpoint and a button on the trip page?",
      ],
      grep: "export function toGeoJson",
      files: ["src/lib/gpx.ts", "src/routes/trips.ts", "web/src/pages/TripDetail.tsx"],
      before: "export function toGeoJson(points: TrackPoint[]) {",
      after: `export function toGpx(trip: Trip, points: TrackPoint[]): string {
  const segments = points
    .map((p) => '    <trkpt lat="' + p.lat + '" lon="' + p.lng + '"><ele>' + p.ele.toFixed(1) + "</ele></trkpt>")
    .join("\\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="trailhead">',
    "  <trk><name>" + escapeXml(trip.name) + "</name><trkseg>",
    segments,
    "  </trkseg></trk>",
    "</gpx>",
  ].join("\\n");
}

export function toGeoJson(points: TrackPoint[]) {`,
      summary:
        "Added `toGpx()` in `src/lib/gpx.ts`, a `GET /api/trips/:id/export.gpx` route that sets `Content-Type: application/gpx+xml` and a `Content-Disposition` filename based on the trip slug, plus a **Download GPX** button on the trip page. Elevation is written per point when we have it.",
      followups: [
        {
          ask: "Garmin Connect rejected the file — I think it wants a <time> on each point?",
          reply:
            "Garmin's importer is strict about tracks without timestamps. Planned routes are better expressed as a `<rte>` with `<rtept>` elements, which Garmin accepts without times. I switched the export to emit a route and kept the track output behind `?as=track` for apps that prefer it.",
        },
        {
          ask: "Can the filename include the trailhead name instead of the id?",
          reply: "Done — the filename is now `<date>-<trailhead-slug>.gpx`, e.g. `2026-07-19-rattlesnake-ledge.gpx`.",
        },
      ],
    },
    {
      title: "Show NOAA forecast on the trip planner",
      branch: "trip-forecast",
      asks: [
        "On the planner page, show the weather forecast for the trailhead on the trip date. Use the api.weather.gov points → forecast flow, and cache responses for an hour.",
        "Add a forecast card to the planner. weather.gov is free and doesn't need a key — cache it so we don't hammer it.",
      ],
      grep: "fetchForecast",
      files: ["src/lib/weather.ts", "web/src/components/ForecastCard.tsx"],
      before: "// TODO: forecast",
      after: `const cache = new Map<string, { at: number; periods: ForecastPeriod[] }>();
const HOUR = 60 * 60 * 1000;

export async function fetchForecast(lat: number, lng: number): Promise<ForecastPeriod[]> {
  const key = lat.toFixed(3) + "," + lng.toFixed(3);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < HOUR) return hit.periods;

  const point = await getJson<PointsResponse>("https://api.weather.gov/points/" + key);
  const forecast = await getJson<ForecastResponse>(point.properties.forecast);
  cache.set(key, { at: Date.now(), periods: forecast.properties.periods });
  return forecast.properties.periods;
}`,
      summary:
        "The planner now shows a `ForecastCard` for the trailhead. `fetchForecast()` resolves the grid point via `/points/{lat},{lng}`, follows `properties.forecast`, and caches by rounded coordinates for an hour. weather.gov asks for a descriptive `User-Agent`, so requests send `trailhead (alex.rivera@example.com)`.",
      followups: [
        {
          ask: "Make it show the snow level or at least highlight when the forecast mentions snow.",
          reply:
            "weather.gov doesn't expose snow level in the simple forecast, so I highlight periods whose `shortForecast` mentions snow or freezing rain with a blue badge, and show the low temperature next to it.",
        },
        { ask: "What happens if weather.gov is down?", reply: "The card now renders \"Forecast unavailable\" with a retry button; the error is logged but doesn't break the planner." },
      ],
    },
    {
      title: "Fix timezone bug in trip dates",
      branch: "fix-trip-dates",
      asks: [
        "Trips created in the evening show up as the next day. I think we're storing dates as UTC midnight. Can you find and fix it?",
        "Bug: if I create a trip after 5pm it's saved for tomorrow. Probably a toISOString() somewhere.",
      ],
      grep: "toISOString().slice(0, 10)",
      files: ["src/routes/trips.ts", "src/lib/dates.ts"],
      before: "const date = new Date(body.date).toISOString().slice(0, 10);",
      after: `// Trip dates are calendar dates in the trailhead's zone, not instants.
const date = parseLocalDate(body.date); // "YYYY-MM-DD", validated`,
      summary:
        "Found it: `POST /api/trips` parsed the date input with `new Date()` and then took `toISOString().slice(0, 10)`, which converts to UTC first — so anything after 5pm Pacific rolled over. Trip dates are now treated as plain calendar dates (`YYYY-MM-DD`) end to end, with a regression test that creates a trip at 23:30 local.",
      followups: [
        { ask: "Are there existing trips in the db with the wrong date?", reply: "Yes, 6 trips have `created_at` after 00:00 UTC but before local midnight. I added a one-off migration script `scripts/fix-trip-dates.ts` with a `--dry-run` flag; run it to see the list before applying." },
      ],
    },
    {
      title: "Add permit reminders",
      branch: "permit-reminders",
      asks: [
        "Some trails need permits (Enchantments lottery, Mount Rainier wilderness permits). Add a permits field to trails and send a reminder email 14 days before a trip if a permit is needed.",
        "Can you add permit tracking? Each trail can require a permit, and I want a reminder two weeks before the trip.",
      ],
      grep: "interface Trail",
      files: ["src/db/schema.ts", "src/lib/permits.ts", "src/jobs/reminders.ts"],
      before: "  difficulty: Difficulty;",
      after: `  difficulty: Difficulty;
  permit?: {
    name: string;
    url: string;
    /** Days before the trip to remind. */
    remindDays: number;
  };`,
      summary:
        "Trails can now carry an optional `permit` (name, URL, reminder lead time). A daily job in `src/jobs/reminders.ts` finds trips whose trail needs a permit and that start in `remindDays` days, then sends one email per trip (deduplicated via a `reminders_sent` table).",
      followups: [
        { ask: "Use 14 days by default but 30 for the Enchantments.", reply: "Defaults to 14; the seed data for the Enchantments trail now sets `remindDays: 30`." },
        { ask: "Write the email copy to be short and friendly.", reply: "Subject: \"Permit reminder: Snow Lake on Sat Jul 19\". Body is two lines with the permit link and a note to share it in the group chat." },
      ],
    },
    {
      title: "Speed up the trail search query",
      branch: "trail-search-index",
      asks: [
        "Trail search is slow now that we imported all the WTA trails (~4k). It takes 800ms. Can you profile it and add an index or FTS?",
        "Searching trails got really slow. Can you look at the query plan and fix it?",
      ],
      grep: "LIKE '%' ||",
      files: ["src/routes/trails.ts", "src/db/migrations/0007_trails_fts.sql"],
      before: "WHERE name LIKE '%' || ? || '%' OR region LIKE '%' || ? || '%'",
      after: "WHERE trails_fts MATCH ? ORDER BY rank LIMIT 25",
      summary:
        "The search used `LIKE '%q%'` on two columns, which forces a full scan. I added an FTS5 table `trails_fts(name, region, description)` kept in sync by triggers, and switched the route to `MATCH` with prefix queries (`snow*`). Locally the p50 went from ~780ms to ~6ms.",
      followups: [
        { ask: "Typos like 'rattlesnak' should still match.", reply: "FTS prefix matching covers `rattlesnak*`. For real typos I added a trigram fallback when FTS returns nothing — it's slower but only runs on misses." },
      ],
    },
    {
      title: "Add carpool sign-up to trips",
      branch: "carpool",
      asks: [
        "Add a carpool section to trips: people can offer seats or ask for a ride, and the trip page shows who's driving with whom.",
        "We always sort out rides in the group chat. Can trips have a carpool list instead?",
      ],
      grep: "export const tripRoutes",
      files: ["src/routes/carpool.ts", "web/src/components/Carpool.tsx", "src/db/schema.ts"],
      before: "export const tripRoutes = new Hono()",
      after: `export const tripRoutes = new Hono()
  .route("/:id/carpool", carpoolRoutes)`,
      summary:
        "Added `carpool_offers` and `carpool_requests` tables, routes under `/api/trips/:id/carpool`, and a `Carpool` component that lists drivers with remaining seats and lets riders claim one. Claiming is a single `UPDATE ... WHERE seats_left > 0` so two people can't grab the last seat.",
      followups: [{ ask: "Show the meeting point on a map too.", reply: "Drivers can now set a meeting point; the component renders it with the same Leaflet map we use for trailheads." }],
    },
    {
      title: "Migrate tests to bun test",
      branch: "bun-test",
      asks: [
        "Let's drop vitest on the server side and use bun test. Convert the tests in src/ and update package.json scripts.",
        "Can you migrate the backend tests from vitest to bun:test?",
      ],
      grep: "from \"vitest\"",
      files: ["src/routes/trips.test.ts", "package.json"],
      before: 'import { describe, expect, it, vi } from "vitest";',
      after: 'import { describe, expect, it, mock } from "bun:test";',
      summary:
        "Converted 11 server test files to `bun:test` (mostly import changes; `vi.fn()` → `mock()`, `vi.useFakeTimers()` → `setSystemTime()`). The web app keeps vitest because it needs jsdom. `bun test` runs the server suite in ~0.9s vs ~4s before.",
      followups: [],
    },
  ],
  "pocket-ledger": [
    {
      title: "Import Monzo CSV exports",
      branch: "monzo-import",
      asks: [
        "Add an importer for Monzo's CSV export. Columns are Transaction ID, Date, Time, Type, Name, Emoji, Category, Amount, Currency... Map Category to our categories.",
        "I want `ledger import monzo.csv` to work. Can you write the CSV importer?",
      ],
      grep: "pub fn import_",
      files: ["src/import/monzo.rs", "src/import/mod.rs"],
      before: "pub mod amex;",
      after: `pub mod amex;
pub mod monzo;

pub fn detect(headers: &csv::StringRecord) -> Option<Format> {
    if headers.iter().any(|h| h == "Transaction ID") && headers.iter().any(|h| h == "Emoji") {
        return Some(Format::Monzo);
    }
    None
}`,
      summary:
        "Added `src/import/monzo.rs` using `csv` + `serde` with a `MonzoRow` struct, auto-detected from the header row. Amounts are parsed into `Decimal` (no floats), dates are combined with the time column, and Monzo categories map onto ours (`eating_out` → `Dining`, `transport` → `Transport`, etc.). Duplicate transaction IDs are skipped on re-import.",
      followups: [
        { ask: "Pots transfers show up as spending. Can we ignore those?", reply: "Rows with `Type = Pot transfer` are now recorded as transfers and excluded from budget totals." },
      ],
    },
    {
      title: "Add monthly budget rollover",
      branch: "budget-rollover",
      asks: [
        "Unspent budget in a category should roll over into next month, capped at 2x the monthly amount. Implement it in budget.rs.",
        "Can budgets roll over? If I underspend on groceries in March, April gets the leftover (up to a cap).",
      ],
      grep: "fn remaining",
      files: ["src/budget.rs"],
      before: "    pub fn remaining(&self, month: Month) -> Decimal {",
      after: `    pub fn remaining(&self, month: Month) -> Decimal {
        let carried = self
            .previous(month)
            .map(|prev| (self.remaining(prev)).max(Decimal::ZERO))
            .unwrap_or(Decimal::ZERO)
            .min(self.monthly * Decimal::TWO);`,
      summary:
        "`Budget::remaining()` now carries forward unspent money from the previous month, never negative and capped at 2× the monthly amount. I made it iterative instead of recursive so long histories don't blow the stack, and added tests for the cap and for overspending.",
      followups: [{ ask: "Make the cap configurable per category.", reply: "Added `rollover_cap` to the category config (defaults to 2.0; `0` disables rollover)." }],
    },
    {
      title: "Fix borrow checker error in report",
      branch: "fix-report-borrow",
      asks: [
        "cargo build fails after my refactor of report.rs — something about borrowing self.entries mutably. Can you fix it without cloning everything?",
        "Getting E0502 in the report module. Help?",
      ],
      grep: "self.entries.last()",
      files: ["src/report.rs"],
      before: "        let last = self.entries.last();",
      after: "        let last_date = self.entries.last().map(|e| e.date);",
      summary:
        "The immutable borrow from `self.entries.last()` was still alive when you pushed. Copying out just the date (`Option<NaiveDate>`, which is `Copy`) ends the borrow before the `push`, so no clone of the entries is needed.",
      followups: [],
    },
    {
      title: "Add a terminal bar chart to the report",
      branch: "report-chart",
      asks: [
        "`ledger report` prints a table. Add a little horizontal bar chart per category using unicode blocks, scaled to the terminal width.",
        "Can the monthly report show bars next to each category?",
      ],
      grep: "fn render_table",
      files: ["src/report.rs", "Cargo.toml"],
      before: "fn render_table(rows: &[Row]) -> String {",
      after: `fn bar(value: Decimal, max: Decimal, width: usize) -> String {
    if max.is_zero() {
        return String::new();
    }
    let eighths = ((value / max) * Decimal::from(width * 8)).round().to_usize().unwrap_or(0);
    let full = "█".repeat(eighths / 8);
    let partial = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"][eighths % 8];
    format!("{full}{partial}")
}

fn render_table(rows: &[Row]) -> String {`,
      summary:
        "Each category row now ends with a bar using eighth-block characters for sub-cell precision, scaled to the widest category and the terminal width (via `terminal_size`, falling back to 80 columns when piped).",
      followups: [{ ask: "Color over-budget categories red.", reply: "Over-budget rows render their bar in red with `owo-colors`; colors are disabled when `NO_COLOR` is set or stdout isn't a TTY." }],
    },
    {
      title: "Add recurring transaction detection",
      branch: "recurring",
      asks: [
        "Detect recurring payments (subscriptions, rent) from history: same merchant, similar amount, roughly monthly. Add `ledger recurring`.",
        "Can you add a command that lists my subscriptions by finding monthly repeats?",
      ],
      grep: "enum Command",
      files: ["src/recurring.rs", "src/main.rs"],
      before: "    Report(ReportArgs),",
      after: `    Report(ReportArgs),
    /// List merchants that charge on a regular schedule.
    Recurring {
        #[arg(long, default_value_t = 3)]
        min_occurrences: usize,
    },`,
      summary:
        "`ledger recurring` groups transactions by normalized merchant, then looks for at least 3 charges with intervals within ±4 days of a weekly, monthly, or yearly period and amounts within 10%. Output lists merchant, cadence, typical amount, and next expected date.",
      followups: [],
    },
  ],
  dotfiles: [
    {
      title: "Make install.sh idempotent",
      branch: "idempotent-install",
      asks: [
        "install.sh fails the second time because the symlinks already exist. Make it idempotent and add a --dry-run flag.",
        "Can you clean up install.sh so it's safe to rerun?",
      ],
      grep: "ln -s",
      files: ["install.sh"],
      before: 'ln -s "$src" "$dest"',
      after: `link() {
  local src="$1" dest="$2"
  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    echo "  skip  $dest (already linked)"
    return
  fi
  if [ -e "$dest" ]; then
    mv "$dest" "$dest.backup.$(date +%Y%m%d%H%M%S)"
  fi
  if [ "$DRY_RUN" = 1 ]; then echo "  link  $dest -> $src"; else ln -s "$src" "$dest"; fi
}`,
      summary:
        "Replaced the raw `ln -s` calls with a `link()` helper that skips correct links, backs up real files with a timestamp suffix, and honors `--dry-run`. Also fixed the SC2045 warning by globbing `bin/*` instead of parsing `ls`.",
      followups: [],
    },
    {
      title: "Speed up zsh startup",
      branch: "zsh-startup",
      asks: [
        "My shell takes ~900ms to start. Profile .zshrc and make it faster — I suspect nvm and compinit.",
        "zsh startup is sluggish. Can you figure out what's slow?",
      ],
      grep: "nvm.sh",
      files: ["zsh/.zshrc"],
      before: '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
      after: `# fnm is ~40x faster to initialise than nvm
eval "$(fnm env --use-on-cd)"

autoload -Uz compinit
if [[ -n ~/.zcompdump(#qN.mh+24) ]]; then compinit; else compinit -C; fi`,
      summary:
        "`zprof` showed nvm (~520ms) and `compinit` (~210ms) dominating. Swapped nvm for `fnm`, and `compinit` now only rebuilds the dump once a day (`-C` otherwise). Startup measured with `hyperfine 'zsh -i -c exit'` dropped from 912ms to 74ms.",
      followups: [{ ask: "Add fnm to the Brewfile", reply: "Added `brew \"fnm\"` and removed `nvm`." }],
    },
    {
      title: "Add a tmux session picker",
      branch: "tmux-picker",
      asks: [
        "Write a bin/tmux-session script: fzf over ~/code/* and attach to (or create) a tmux session named after the project.",
        "I want a quick project switcher for tmux using fzf.",
      ],
      grep: "fzf",
      files: ["bin/tmux-session", "zsh/.zshrc"],
      before: "# keybindings",
      after: `#!/usr/bin/env bash
set -euo pipefail
dir=$(find "$HOME/code" -mindepth 1 -maxdepth 1 -type d | fzf --prompt="project> ") || exit 0
name=$(basename "$dir" | tr . _)
if ! tmux has-session -t "$name" 2>/dev/null; then
  tmux new-session -ds "$name" -c "$dir"
fi
if [ -n "\${TMUX:-}" ]; then tmux switch-client -t "$name"; else tmux attach -t "$name"; fi`,
      summary: "Added `bin/tmux-session` and bound it to `Ctrl-f` in zsh. It switches clients when already inside tmux and attaches otherwise.",
      followups: [],
    },
  ],
  "northwind-ingest": [
    {
      title: "Add exponential backoff to the Kafka consumer",
      branch: "consumer-backoff",
      asks: [
        "When the warehouse is down the consumer hot-loops on retries. Add exponential backoff with jitter (max 30s) and respect context cancellation.",
        "Our ingest consumer spams retries when the sink fails. Can you add proper backoff?",
      ],
      grep: "for attempt :=",
      files: ["internal/retry/backoff.go", "internal/kafka/consumer.go"],
      before: "\tfor attempt := 0; ; attempt++ {",
      after: `// Backoff returns the delay before retry n: full jitter, capped.
func Backoff(n int, base, max time.Duration) time.Duration {
	d := base << min(n, 16)
	if d <= 0 || d > max {
		d = max
	}
	return time.Duration(rand.Int64N(int64(d)))
}

func Do(ctx context.Context, op func(context.Context) error) error {
	for attempt := 0; ; attempt++ {`,
      summary:
        "Added `retry.Do(ctx, op)` with full-jitter exponential backoff (base 200ms, cap 30s) that returns as soon as `ctx` is cancelled. The consumer wraps sink writes in it and no longer commits offsets until the write succeeds. A table test checks the cap and that cancellation interrupts a pending sleep.",
      followups: [
        { ask: "Expose a metric for retry count.", reply: "Added `ingest_sink_retries_total{sink}` (counter) and `ingest_sink_backoff_seconds` (histogram) to the Prometheus registry." },
      ],
    },
    {
      title: "Batch writer flushes on size and interval",
      branch: "batch-flush",
      asks: [
        "The batch writer only flushes when it hits 500 rows, so low-traffic topics sit for ages. Flush on size OR every 5s, whichever comes first.",
        "Can the writer flush on a timer as well as on size?",
      ],
      grep: "func (w *Writer) Add",
      files: ["internal/batch/writer.go", "internal/batch/writer_test.go"],
      before: "func (w *Writer) Add(row Row) error {",
      after: `func (w *Writer) run(ctx context.Context) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			w.flush(context.WithoutCancel(ctx))
			return
		case <-ticker.C:
			w.flush(ctx)
		case <-w.full:
			w.flush(ctx)
			ticker.Reset(w.interval)
		}
	}
}

func (w *Writer) Add(row Row) error {`,
      summary:
        "The writer now runs a goroutine that flushes on a ticker or when `Add` signals the buffer is full, resetting the ticker after size-triggered flushes. On shutdown it does a final flush with `context.WithoutCancel` so buffered rows aren't dropped. Tests use a fake clock.",
      followups: [{ ask: "Is Add still safe to call from multiple goroutines?", reply: "Yes — the buffer is guarded by the same mutex, and the `full` channel is buffered with capacity 1 so concurrent signals coalesce." }],
    },
    {
      title: "Validate events against the JSON schema",
      branch: "schema-validation",
      asks: [
        "Reject events that don't match schemas/event.v2.json before they hit the warehouse, and send them to a dead-letter topic with the validation error.",
        "Add schema validation + DLQ to the pipeline.",
      ],
      grep: "func Validate",
      files: ["internal/schema/validate.go", "cmd/ingest/main.go"],
      before: "func Validate(raw []byte) error {",
      after: `var compiled = jsonschema.MustCompileString("event.v2.json", eventSchemaV2)

func Validate(raw []byte) error {
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	if err := compiled.Validate(doc); err != nil {
		return &ValidationError{Err: err}
	}
	return nil`,
      summary:
        "Events are validated with `santhosh-tekuri/jsonschema` against the embedded v2 schema. Invalid ones go to `ingest.dlq` with headers `x-validation-error` and `x-source-topic`, and the offset is committed so a bad message can't wedge the partition.",
      followups: [],
    },
    {
      title: "Investigate flaky consumer test",
      branch: "fix-flaky-consumer-test",
      asks: [
        "TestConsumerRebalance fails maybe 1 in 10 runs in CI. Can you run it with -count=50 -race and figure out why?",
        "There's a flaky test in internal/kafka. Please dig in.",
      ],
      grep: "func TestConsumerRebalance",
      files: ["internal/kafka/consumer_test.go"],
      before: "\ttime.Sleep(100 * time.Millisecond)",
      after: "\trequire.Eventually(t, func() bool { return c.Assigned() == 2 }, 2*time.Second, 10*time.Millisecond)",
      summary:
        "The test slept a fixed 100ms waiting for the rebalance; under `-race` on CI it sometimes took longer. Replaced the sleep with `require.Eventually` on the assignment count. 200 runs with `-race` pass locally now.",
      followups: [],
    },
    {
      title: "Add structured logging with slog",
      branch: "slog",
      asks: [
        "Replace our log.Printf calls with log/slog, JSON handler in prod and text locally, with topic/partition/offset attributes on consumer logs.",
        "Move ingest to slog please.",
      ],
      grep: "log.Printf",
      files: ["cmd/ingest/main.go", "internal/kafka/consumer.go"],
      before: '\tlog.Printf("commit failed: %v", err)',
      after: '\tc.log.Error("commit failed", "err", err, "topic", msg.Topic, "partition", msg.Partition, "offset", msg.Offset)',
      summary:
        "All 37 `log.Printf` calls now use `slog`. `main` picks `slog.NewJSONHandler` when `INGEST_ENV=prod` and the text handler otherwise; the consumer carries a logger with `component=consumer` and adds topic/partition/offset per message.",
      followups: [],
    },
  ],
  "garden-sensors": [
    {
      title: "Calibrate the moisture sensor readings",
      branch: "calibration",
      asks: [
        "The capacitive moisture sensors read ~520 in dry soil and ~260 in water. Add per-sensor calibration and convert raw readings to a 0–100% value.",
        "Can you turn the raw ADC numbers into a moisture percentage? Each sensor is a bit different.",
      ],
      grep: "def read_moisture",
      files: ["sensors/moisture.py", "config/sensors.toml"],
      before: "def read_moisture(channel: int) -> int:",
      after: `@dataclass(frozen=True)
class Calibration:
    dry: int = 520
    wet: int = 260

    def percent(self, raw: int) -> float:
        span = self.dry - self.wet
        return round(max(0.0, min(100.0, (self.dry - raw) / span * 100)), 1)


def read_moisture(channel: int) -> int:`,
      summary:
        "Added a `Calibration` dataclass (dry/wet raw values) loaded per sensor from `config/sensors.toml`, and `percent()` clamps to 0–100. The dashboard and alerts now use percentages; raw values are still stored for re-calibration later.",
      followups: [
        { ask: "Add a CLI to calibrate: hold sensor in air, then water.", reply: "`uv run garden calibrate basil` walks you through it: it averages 20 readings in air, then in water, and writes the values into `sensors.toml`." },
      ],
    },
    {
      title: "Send a push alert when plants are dry",
      branch: "dry-alerts",
      asks: [
        "Send me a push notification via ntfy when any plant stays below 25% for 2 hours. Don't spam — at most one alert per plant per day.",
        "Can you add dry-soil alerts? I use ntfy.sh on my phone.",
      ],
      grep: "def check_thresholds",
      files: ["app/alerts.py", "tests/test_alerts.py"],
      before: "def check_thresholds(readings):",
      after: `def should_alert(history: list[Reading], now: datetime, last_sent: datetime | None) -> bool:
    window = [r for r in history if now - r.at <= timedelta(hours=2)]
    if not window or any(r.percent >= DRY_THRESHOLD for r in window):
        return False
    return last_sent is None or now - last_sent >= timedelta(days=1)


def check_thresholds(readings):`,
      summary:
        "`should_alert()` requires every reading in the last two hours to be under 25% and at most one alert per plant per day. Alerts POST to the ntfy topic from `NTFY_TOPIC` with the plant name and current percentage; failures are logged and retried on the next check.",
      followups: [],
    },
    {
      title: "Add a history chart to the dashboard",
      branch: "history-chart",
      asks: [
        "Add a 7-day moisture history chart per plant to the FastAPI dashboard. Keep it lightweight — no React, maybe uPlot.",
        "The dashboard only shows current values. Can we get a week of history as a chart?",
      ],
      grep: "@app.get(\"/\")",
      files: ["app/dashboard.py", "app/templates/index.html"],
      before: '@app.get("/")',
      after: `@app.get("/api/history/{plant}")
def history(plant: str, days: int = 7) -> list[dict]:
    since = datetime.now(UTC) - timedelta(days=days)
    rows = db.execute(
        "SELECT at, percent FROM readings WHERE plant = ? AND at >= ? ORDER BY at",
        (plant, since.isoformat()),
    ).fetchall()
    return [{"at": at, "percent": pct} for at, pct in downsample(rows, 500)]


@app.get("/")`,
      summary:
        "Added `/api/history/{plant}` (downsampled to ≤500 points) and a uPlot chart per plant card with a dashed line at the dry threshold. uPlot is vendored as a single 45KB file so the Pi doesn't need a build step.",
      followups: [],
    },
    {
      title: "Port the sensor loop to MicroPython",
      branch: "micropython",
      asks: [
        "I want to move from the Pi to an ESP32. Port firmware/main.py to MicroPython: read the ADC, publish to MQTT every 5 minutes, deep sleep in between.",
        "Help me rewrite the sensor loop for an ESP32 with MicroPython and MQTT.",
      ],
      grep: "while True:",
      files: ["firmware/main.py", "firmware/boot.py"],
      before: "while True:",
      after: `from machine import ADC, Pin, deepsleep
from umqtt.simple import MQTTClient

adc = ADC(Pin(34))
adc.atten(ADC.ATTN_11DB)

def publish(raw):
    client = MQTTClient("balcony-esp32", MQTT_HOST)
    client.connect()
    client.publish(b"garden/basil/raw", str(raw).encode())
    client.disconnect()

publish(sum(adc.read() for _ in range(16)) // 16)
deepsleep(5 * 60 * 1000)`,
      summary:
        "The ESP32 version wakes, averages 16 ADC reads, publishes to `garden/<plant>/raw` over MQTT, and deep sleeps for 5 minutes. Note the ESP32 ADC is 12-bit (0–4095), so the calibration values need redoing — the Pi's ADS1115 was 16-bit.",
      followups: [],
    },
  ],
};

/** Follow-up exchanges that apply to any task. */
type FollowupKind = "test" | "lint" | "commit" | "pr" | "explain" | "taskFollowup";

function sessionSlug(rng: Rng): string {
  const adjectives = ["quiet", "brisk", "mossy", "golden", "swift", "amber", "misty", "steady", "bright", "cedar"];
  const verbs = ["wandering", "drifting", "climbing", "humming", "folding", "spinning", "sketching", "rolling"];
  const nouns = ["otter", "heron", "lantern", "meadow", "falcon", "harbor", "pebble", "summit", "fern", "comet"];
  return `${rng.pick(adjectives)}-${rng.pick(verbs)}-${rng.pick(nouns)}`;
}

function grepOutput(projectDef: CodingProject, task: CodingTask, rng: Rng): string {
  const lines = task.files
    .slice(0, rng.int(1, Math.min(3, task.files.length)))
    .map((f) => `${f}:${rng.int(8, 180)}:${task.before.split("\n")[0]?.trim() ?? task.grep}`);
  return lines.length > 0 ? lines.join("\n") : `No matches found in ${projectDef.name}`;
}

function contextCode(task: CodingTask): string {
  return `${task.before}\n  // ...\n}`;
}

interface Clock {
  t: number;
}

function advance(clock: Clock, rng: Rng, minSec: number, maxSec: number): number {
  clock.t += rng.int(minSec * 1000, maxSec * 1000);
  return clock.t;
}

/** A tool call before it is placed on the session clock. */
type ToolSpec = ToolCall extends infer T ? (T extends ToolCall ? Omit<T, "at" | "doneAt"> : never) : never;

function tool(clock: Clock, rng: Rng, call: ToolSpec, maxSec = 4): ToolCall {
  const at = advance(clock, rng, 2, 12);
  const doneAt = advance(clock, rng, 1, maxSec);
  return { ...call, at, doneAt };
}

const PREAMBLES = [
  "I'll start by finding where this lives.",
  "Let me look at the current implementation first.",
  "Let me check how this is wired up.",
  "I'll search for the relevant code.",
  "First I'll find the existing code path.",
];

const THINKING = [
  "The user wants a focused change. I should find the existing function, make the minimal edit, and run the tests.",
  "I need to understand the current behavior before editing. Searching for the function, then reading the file.",
  "Likely a single-file change plus a test. Keep the diff small and verify with the test suite.",
];

function initialExchange(projectDef: CodingProject, task: CodingTask, rng: Rng, clock: Clock, failFirst: boolean): CodingExchange {
  const promptAt = clock.t;
  const prompt = rng.pick(task.asks);
  const [primary = "README.md", ...rest] = task.files;
  const steps: AgentStep[] = [];

  steps.push({
    at: advance(clock, rng, 4, 15),
    text: rng.pick(PREAMBLES),
    thinking: rng.chance(0.35) ? rng.pick(THINKING) : undefined,
    tools: [
      tool(clock, rng, { kind: "grep", pattern: task.grep, path: projectDef.dir, output: grepOutput(projectDef, task, rng) }),
      tool(clock, rng, { kind: "read", path: `${projectDef.dir}/${primary}`, output: numbered(contextCode(task), rng.int(10, 120)) }),
    ],
  });

  const editAt = advance(clock, rng, 5, 30);
  const edits: ToolCall[] = [
    tool(clock, rng, {
      kind: "edit",
      path: `${projectDef.dir}/${primary}`,
      oldText: task.before,
      newText: task.after,
      output: `The file ${projectDef.dir}/${primary} has been updated.`,
    }),
  ];
  const extra = rest[0];
  if (extra && rng.chance(0.6)) {
    edits.push(
      tool(clock, rng, {
        kind: "write",
        path: `${projectDef.dir}/${extra}`,
        content: `// ${task.title}\n${task.after.split("\n").slice(0, 6).join("\n")}\n`,
        output: `File created successfully at: ${projectDef.dir}/${extra}`,
      }),
    );
  }
  steps.push({ at: editAt, text: `Found it in \`${primary}\`. Making the change now.`, tools: edits });

  if (failFirst) {
    steps.push({
      at: advance(clock, rng, 3, 10),
      tools: [
        tool(clock, rng, {
          kind: "bash",
          command: projectDef.testCmd,
          description: "Run the test suite",
          output: projectDef.failOutput(rng, task),
          error: true,
        }, 60),
      ],
    });
    steps.push({
      at: advance(clock, rng, 5, 25),
      text: "One failure — the test fixture still uses the old behavior. Updating it and re-running.",
      tools: [
        tool(clock, rng, {
          kind: "edit",
          path: `${projectDef.dir}/${projectDef.testFile}`,
          oldText: "// fixture: legacy",
          newText: `// fixture: ${task.branch}`,
          output: `The file ${projectDef.dir}/${projectDef.testFile} has been updated.`,
        }),
      ],
    });
  }

  steps.push({
    at: advance(clock, rng, 3, 10),
    tools: [
      tool(clock, rng, {
        kind: "bash",
        command: projectDef.testCmd,
        description: "Run the test suite",
        output: projectDef.passOutput(rng),
        error: false,
      }, 60),
    ],
  });

  const replyAt = advance(clock, rng, 4, 20);
  const reply = `${task.summary}\n\n${fence(projectDef.fence, task.after)}\n\n${
    failFirst ? "One test needed its fixture updated; the full suite passes now." : "Tests pass."
  }`;
  return { prompt, promptAt, image: false, steps, reply, replyAt };
}

function followupExchange(
  kind: FollowupKind,
  projectDef: CodingProject,
  task: CodingTask,
  branch: string,
  rng: Rng,
  clock: Clock,
  usedFollowups: Set<number>,
): CodingExchange | null {
  const promptAt = advance(clock, rng, 45, 900);
  const at = () => advance(clock, rng, 4, 15);
  switch (kind) {
    case "test": {
      const prompt = rng.pick([
        "Can you add a test for the edge case where the input is empty?",
        "Add a regression test for this.",
        "Please add tests covering the failure path too.",
        "Is this covered by tests? If not, add some.",
      ]);
      const testPath = `${projectDef.dir}/${projectDef.testFile}`;
      const steps: AgentStep[] = [
        {
          at: at(),
          tools: [
            tool(clock, rng, { kind: "read", path: testPath, output: numbered(`// tests for ${task.branch}\n`, 1) }),
            tool(clock, rng, {
              kind: "edit",
              path: testPath,
              oldText: `// tests for ${task.branch}`,
              newText: `// tests for ${task.branch}\n// + empty input\n// + error path`,
              output: `The file ${testPath} has been updated.`,
            }),
            tool(clock, rng, { kind: "bash", command: projectDef.testCmd, description: "Run tests", output: projectDef.passOutput(rng), error: false }, 60),
          ],
        },
      ];
      return {
        prompt,
        promptAt,
        image: false,
        steps,
        reply: `Added two cases to \`${projectDef.testFile}\`: empty input returns early without touching storage, and the error path surfaces a descriptive message instead of a panic/500. Suite is green.`,
        replyAt: at(),
      };
    }
    case "lint": {
      const prompt = rng.pick(["Run the linter too.", "Can you make sure lint passes?", "lint?"]);
      const steps: AgentStep[] = [
        {
          at: at(),
          tools: [tool(clock, rng, { kind: "bash", command: projectDef.lintCmd, description: "Run linter", output: projectDef.lintOk, error: false }, 30)],
        },
      ];
      return { prompt, promptAt, image: false, steps, reply: "Lint is clean — no warnings.", replyAt: at() };
    }
    case "commit": {
      const prompt = rng.pick(["Looks good, commit it.", "Commit this please.", "Great — commit with a scoped message.", "ship it (commit, don't push)"]);
      const scope = task.files[0]?.split("/").slice(-2, -1)[0] ?? projectDef.name;
      const message = `${scope}: ${task.title.charAt(0).toLowerCase()}${task.title.slice(1)}`;
      const sha = rng.hex(7);
      const steps: AgentStep[] = [
        {
          at: at(),
          tools: [
            tool(clock, rng, {
              kind: "bash",
              command: "git status --short",
              description: "Show changed files",
              output: task.files.map((f) => ` M ${f}`).join("\n"),
              error: false,
            }),
            tool(clock, rng, {
              kind: "bash",
              command: `git add -A && git commit -m "${message}"`,
              description: "Commit changes",
              output: `[${branch} ${sha}] ${message}\n ${task.files.length} files changed, ${rng.int(20, 180)} insertions(+), ${rng.int(2, 60)} deletions(-)`,
              error: false,
            }),
          ],
        },
      ];
      return { prompt, promptAt, image: false, steps, reply: `Committed as \`${sha}\` on \`${branch}\`: "${message}".`, replyAt: at() };
    }
    case "pr": {
      const prompt = rng.pick(["Push and open a PR.", "Open a draft PR for this.", "Can you open the PR?"]);
      const number = rng.int(12, 240);
      const url = `https://github.com/${projectDef.repo}/pull/${number}`;
      const steps: AgentStep[] = [
        {
          at: at(),
          tools: [
            tool(clock, rng, {
              kind: "bash",
              command: `git push -u origin ${branch} && gh pr create --fill`,
              description: "Push branch and open PR",
              output: `branch '${branch}' set up to track 'origin/${branch}'.\n${url}`,
              error: false,
            }, 30),
          ],
        },
      ];
      return { prompt, promptAt, image: false, steps, reply: `Opened ${url} — "${task.title}".`, replyAt: at() };
    }
    case "explain": {
      const prompt = rng.pick([
        "Before I merge — walk me through the change in a few bullets.",
        "Why did you go with this approach rather than something simpler?",
        "Any risks with this change I should know about?",
      ]);
      return {
        prompt,
        promptAt,
        image: false,
        steps: [],
        reply: `Summary:\n\n- ${task.summary.split(". ")[0]}.\n- Touches ${task.files.map((f) => `\`${f}\``).join(", ")}.\n- Risk is low: behavior only changes on the new code path, and it's covered by tests.\n\nThe main thing to watch after deploying is ${projectDef.name === "northwind-ingest" ? "consumer lag on the dashboard" : "the logs for unexpected errors"} for a day or so.`,
        replyAt: at(),
      };
    }
    case "taskFollowup": {
      const index = task.followups.findIndex((_, i) => !usedFollowups.has(i));
      const followup = task.followups[index];
      if (!followup) return null;
      usedFollowups.add(index);
      const primary = task.files[0] ?? "README.md";
      const path = `${projectDef.dir}/${primary}`;
      const steps: AgentStep[] = [
        {
          at: at(),
          tools: [
            tool(clock, rng, {
              kind: "edit",
              path,
              oldText: task.after.split("\n")[0] ?? task.before,
              newText: `${task.after.split("\n")[0] ?? task.before}\n  // ${followup.ask.slice(0, 60)}`,
              output: `The file ${path} has been updated.`,
            }),
            tool(clock, rng, { kind: "bash", command: projectDef.testCmd, description: "Run tests", output: projectDef.passOutput(rng), error: false }, 60),
          ],
        },
      ];
      const reply = followup.code ? `${followup.reply}\n\n${fence(projectDef.fence, followup.code)}` : followup.reply;
      return { prompt: followup.ask, promptAt, image: false, steps, reply, replyAt: at() };
    }
  }
}

export interface PlanOptions {
  /** Oldest day (days before the anchor) sessions may start. */
  fromDaysAgo: number;
  /** Newest day (days before the anchor). */
  toDaysAgo: number;
  sessions: number;
  /** Exchanges per session, inclusive range. */
  exchanges: readonly [number, number];
  /** Number of sessions where one prompt carries a screenshot. */
  images?: number;
  /** Projects to exclude (e.g. work repo on a personal-only tool). */
  exclude?: readonly ProjectName[];
}

/**
 * Plan timed coding sessions within a window of days: weekday evenings for
 * personal projects, weekday working hours for the work repo, weekend
 * afternoons for side projects.
 */
export function planCodingSessions(ctx: SeedContext, rng: Rng, options: PlanOptions): CodingSession[] {
  const days = ctx.days.filter((d) => d.daysAgo <= options.fromDaysAgo && d.daysAgo >= options.toDaysAgo);
  if (days.length === 0) throw new Error("planCodingSessions: empty day window");
  const projects = CODING_PROJECTS.filter((p) => !options.exclude?.includes(p.name));
  const weightedDays = days.map((d) => [d, (d.isWeekend ? 0.6 : 1) * (1 + (1 - d.daysAgo / Math.max(1, options.fromDaysAgo)) * 0.8)] as const);

  const sessions: CodingSession[] = [];
  for (let i = 0; i < options.sessions; i++) {
    const day = rng.weighted(weightedDays);
    const projectDef = rng.weighted(
      projects.map((p) => [p, day.isWeekend && p.name === "northwind-ingest" ? 0.2 : p.weight] as const),
    );
    const task = rng.pick(TASKS[projectDef.name]);
    const isWork = projectDef.name === "northwind-ingest";
    const hour = isWork ? rng.int(9, 16) : day.isWeekend ? rng.int(10, 17) : rng.weighted([[rng.int(19, 22), 4], [rng.int(7, 8), 1], [12, 1]]);
    const start = ctx.localDate(day.date, hour, rng.int(0, 59), rng.int(0, 59)).getTime();
    const clock: Clock = { t: start };
    const slug = sessionSlug(rng);
    const branch = `${CODING_ACCOUNT}/${task.branch}`;
    const failFirst = rng.chance(0.3);

    const exchanges: CodingExchange[] = [initialExchange(projectDef, task, rng, clock, failFirst)];
    const count = rng.int(options.exchanges[0], options.exchanges[1]);
    const used = new Set<number>();
    const kinds: FollowupKind[] = rng.shuffle<FollowupKind>(["taskFollowup", "taskFollowup", "test", "lint", "explain"]);
    kinds.push("commit");
    if (rng.chance(0.5)) kinds.push("pr");
    for (const kind of kinds) {
      if (exchanges.length >= count) break;
      const exchange = followupExchange(kind, projectDef, task, branch, rng, clock, used);
      if (exchange) exchanges.push(exchange);
    }
    sessions.push({
      project: projectDef,
      task,
      title: task.title,
      slug,
      branch,
      day,
      start,
      end: clock.t,
      exchanges,
    });
  }
  for (const session of rng.sample(sessions, options.images ?? 0)) {
    const target = rng.pick(session.exchanges);
    target.image = true;
    target.prompt = `${target.prompt} Screenshot attached.`;
  }
  return sessions.sort((a, b) => a.start - b.start);
}

/** Small deterministic screenshot for a coding prompt. */
export async function codingScreenshot(ctx: SeedContext, rng: Rng): Promise<Buffer> {
  return ctx.image({ width: rng.pick([640, 720, 800]), height: rng.pick([400, 450, 500]), hue: rng.int(0, 359), variant: rng.int(0, 999), format: "png" });
}

/** Claude Code / Claude Agent SDK tool_use block for a neutral tool call. */
export function anthropicToolUse(call: ToolCall, id: string): Record<string, unknown> {
  switch (call.kind) {
    case "read":
      return { type: "tool_use", id, name: "Read", input: { file_path: call.path } };
    case "grep":
      return { type: "tool_use", id, name: "Grep", input: { pattern: call.pattern, path: call.path, output_mode: "content", "-n": true } };
    case "edit":
      return { type: "tool_use", id, name: "Edit", input: { file_path: call.path, old_string: call.oldText, new_string: call.newText } };
    case "write":
      return { type: "tool_use", id, name: "Write", input: { file_path: call.path, content: call.content } };
    case "bash":
      return { type: "tool_use", id, name: "Bash", input: { command: call.command, description: call.description } };
  }
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}
