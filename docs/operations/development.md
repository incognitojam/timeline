# Development

Conventions for code, commits, and pull requests live in [AGENTS.md](../../AGENTS.md), along with the synthetic seed and host database workflows. Pull requests also need a changeset; see [Releases](releases.md).

## Toolchain

[mise](https://mise.jdx.dev/) installs the tools this repository pins, matching
CI: Bun from `packageManager` in `package.json`, and the tools listed in
`mise.toml`. Install mise and [activate it in your
shell](https://mise.jdx.dev/getting-started.html), then run `mise install`,
which asks once to trust the checkout's `mise.toml`. `bun run setup` trusts and
installs too, so new worktrees get the toolchain. `setup.sh`, `test.sh`, and
`scripts/test-browser.sh` exit with an error when the active Bun differs from
the pinned version. To change a version, edit `packageManager` or `mise.toml`.

`./test.sh static` runs `actionlint` on `.github/workflows/`, as CI does; run
`actionlint` directly to check workflows alone.

## Running locally

```bash
bun run setup                # install dependencies and generate a synthetic ./timeline.db

# Import data from an export
bun run src/platforms/spotify/parser.ts ./imports/spotify my-account

# Run the web app (API + frontend)
bun run dev

# Or run as a service with automated syncing (AUTH_PASSWORD is required outside dev)
AUTH_PASSWORD='choose-a-password' \
bun run service
```

`bun run dev` starts the local API without authentication by default, ignoring
the password in `~/.config/timeline/env`. To exercise login, run
`AUTH_PASSWORD='dev-password' bun run dev`; a password loaded from a local `.env`
also enables authentication. Use `AUTH_PASSWORD='' bun run dev` to explicitly
disable it locally. When using `API_HOST` or `TIMELINE_API_TARGET`, the remote
API's authentication still applies.

### Background runs, status, and stopping

```bash
bun run dev -- --background  # start detached; returns once the web app answers
bun run dev:status           # web/API URLs, PIDs, log (add --json); exits 1 when stopped
bun run dev:stop             # stop it and wait until every process has exited
```

A running dev server, foreground or background, records itself in
`.dev/state.json`; a background run logs to `.dev/dev.log`. Each worktree runs
one dev server at a time. `dev:stop` signals only the processes recorded there,
identified by PID and start time, so do not use `pkill -f`, which can match the
calling shell. It also cleans up children left behind if the dev process itself
was killed.

`bun run dev -- --help` explains how ports are chosen; read them from
`dev:status` rather than guessing. Vite started on its own has no API to proxy
to, so start the app through `bun run dev`.

## Running one sync source

`bun run sync:once <source>` runs a source's `canSync()` and `sync()` once in a
sandbox under `.sync-once/`, without the service, scheduler, or API, and prints
the result, the events it inserted, updated, or deleted, and `sync_state`:

```bash
bun run sync:once claude-code --set path=./fixtures/claude --set account=alice
```

The source gets an empty config, a sandbox `HOME`, and no host environment, so
credentials and fixtures reach it only through the options that pass them, such
as `--env`, `--home-file`, or `--state-json`. Reuse a database across runs with `--db` to check idempotency or cursor
progress; `--help` lists every option. Tests call the same path through
`runSourceOnce()` in `src/sync/once.ts`.

## Testing

Run `./test.sh` before pushing. Screenshot comparisons run in the same Ubuntu
Playwright container locally and in CI. CI runs each chart resize sweep directly
on the hosted Ubuntu runner with the locked Chromium version and its system dependencies.
Install the [toolchain](#toolchain) and Docker (Docker Desktop on macOS), and start Docker before running
the suite. Apple Silicon Macs use the same `linux/amd64` image through emulation.

The full suite runs backend tests, frontend tests, and type checks alongside the
browser checks; Playwright supplies the production build check. `./test.sh unit`
runs the unit checks without browsers or a production build. `./test.sh backend` and
`./test.sh frontend` run those checks separately for hosted CI. Each check reports
its duration and prints its log on failure. PR and trusted CI run browser projects
on separate Linux runners, while trusted CI keeps backend and app checks on macOS.

Local chart sweeps default to `smoke`, checking representative widths and layout
boundaries; PR CI selects this mode explicitly. Set `PLAYWRIGHT_CHART_SWEEP=full`
for the exhaustive width grid used by trusted CI on main. Both modes sweep
forwards and backwards and check clipping, overlap, and overflow. Dense health screenshots
cover compact, desktop, and wide windows.

To run only browser tests or update baselines after an intentional visual change:

```bash
./scripts/test-browser.sh
./scripts/test-browser.sh --update-snapshots
# Playwright arguments work too:
./scripts/test-browser.sh app.spec.ts --grep 'renders the app'
# Match one of the browser CI jobs:
./test.sh browser --project=chart-month
```

The image uses the locked Playwright version and the project's Bun version.
Linux dependencies are isolated from host `node_modules`; updated screenshots,
`web/playwright-report/`, and `web/test-results/` are written into the checkout.
Inspect updated screenshots before committing, then rerun without
`--update-snapshots` to verify them.

For native browser behavior checks without Docker, use
`PLAYWRIGHT_IGNORE_SNAPSHOTS=1 ./test.sh browser`. This skips visual comparisons
and is an optional local override; CI always compares the Linux screenshots.

## README screenshots

The README screenshots in `docs/screenshots/` show demo data for a fictional person. Regenerate them from `web/e2e/showcase.spec.ts` with:

```bash
./scripts/test-browser.sh --config=playwright.showcase.config.ts
```

## Relocatable service artifact

Build the service, scheduler/database workers, web frontend, pinned Bun
runtime, Google Messages sidecar, native runtime dependencies, and version metadata into an artifact
that runs without the source checkout. The build and artifact smoke test require
the pinned Go compiler: run `mise install go`, then activate mise or prefix
the commands below with `mise exec --`:

```bash
bun run build:service
./dist/timeline-service/bin/timeline-service
```

`tools/timeline-app/build.sh` embeds this artifact in `Timeline.app`; the
installed LaunchAgent runs that copy rather than the checkout. Exercise the
standalone packaged boundary from a temporary working directory with:

```bash
./scripts/smoke-service-artifact.sh
```

### Linux artifact validation

The service artifact builder can run natively on glibc Linux (x64 or arm64) for CI validation, including a matching Google Messages sidecar and native Sharp/sqlite-vec packages. macOS remains the supported app host. Builds use the executing Bun and the Go version pinned in mise; this is not a cross-build and the artifact layout is unchanged.

`./scripts/smoke-service-artifact.sh` builds and checks a throwaway artifact. Pass an existing artifact directory to check it without rebuilding. The app smoke uses that path against its relocated bundle, including after release signing. Linux loads sqlite-vec with Bun's SQLite; macOS retains the existing optional custom/Homebrew SQLite probe until SQLite is bundled.

## Changing SQLite

The Linux runtime is SQLite compiled into Bun. `bun run sqlite:pin bun-v<Bun.version>` runs on Linux with that Bun installed and regenerates `src/db/sqlite-pin.ts` from Bun's source and build recipe. Review the manifest when upgrading Bun; the runtime tests reject a changed SQLite version, source id or compile options. The macOS runtime tests explicitly wait for the separate bundled-runtime rollout.

`bun run sqlite:build` checks Linux's runtime or builds a native macOS dylib using Xcode Command Line Tools. It prints the library path on macOS, verifies downloaded source against the manifest's SHA-256, and validates the compiled library before publishing it to the repository-local cache. This command does not select the library for Timeline or change the installed app.

Before switching a host's SQLite, compare disposable snapshots in a checkout containing these commands. Leave the host environment file unchanged during comparison, including its existing setting written as `TIMELINE_SQLITE_LIBRARY_PATH=…` or `export TIMELINE_SQLITE_LIBRARY_PATH=…`. The diagnostic uses only its explicit `--library` argument.

The following Apple Silicon macOS commands use the default data location; substitute your configured database and embeddings locations if different. `prepare-full` refreshes a development snapshot without its live WAL, so it can lag recent writes (see [Local development database](#local-development-database)). Do not use these results as a backup or proof of the live database's exact current contents.

```bash
bun run prepare-full -- --refresh --no-copy
# Scratch output stays private and untracked.
git check-ignore -q .scratch || printf '\n.scratch/\n' >> "$(git rev-parse --git-path info/exclude)"
mkdir -p .scratch
comparison_dir="$(mktemp -d .scratch/sqlite-comparison.XXXXXX)"
cp -c "$HOME/.local/share/timeline/full.db" "$comparison_dir/timeline.db"
brew_sqlite="$(/opt/homebrew/bin/brew --prefix sqlite)"
pinned_library="$(bun run sqlite:build)"

bun run sqlite:check-compat -- --library "$brew_sqlite/lib/libsqlite3.dylib" --db "$comparison_dir/timeline.db" > "$comparison_dir/before.json"
bun run sqlite:check-compat -- --library "$pinned_library" --db "$comparison_dir/timeline.db" > "$comparison_dir/after.json"
diff -u "$comparison_dir/before.json" "$comparison_dir/after.json"
```

If embeddings are configured, snapshot them with SQLite's backup API (including committed WAL frames), then repeat the comparison with that snapshot:

```bash
"$brew_sqlite/bin/sqlite3" -readonly "$HOME/.local/share/timeline/embeddings.db" ".backup '$comparison_dir/embeddings.db'"
bun run sqlite:check-compat -- --library "$brew_sqlite/lib/libsqlite3.dylib" --db "$comparison_dir/timeline.db" --embeddings "$comparison_dir/embeddings.db" > "$comparison_dir/before.json"
bun run sqlite:check-compat -- --library "$pinned_library" --db "$comparison_dir/timeline.db" --embeddings "$comparison_dir/embeddings.db" > "$comparison_dir/after.json"
diff -u "$comparison_dir/before.json" "$comparison_dir/after.json"
```

The checker opens supplied files read-only and creates its own consistent working copies under `.scratch/`. It checks the original database pages before rebuilding working copies with VACUUM, hashes the schema and fixed FTS/JSON queries, counts every table, reports `sqlite_stat*` tables and query plans, applies schema initialization, and exercises REPLACE triggers. With `--embeddings` it also checks sqlite-vec and nearest-neighbour results. Without that argument the output explicitly says vector checks were not performed. Read-only SQLite can create `-wal` and `-shm` sidecars beside a supplied snapshot; the main database bytes remain unchanged. Working copies are removed after the command; reports remain in `comparison_dir` and contain no event text.

Expect only `version`, `sourceId` and `compileOptions` to differ. Other differences need investigation before any switch, especially query plans when `sqlite_stat4` exists. Repeat this procedure for future Bun/SQLite updates, comparing the current library against the new build. On Linux, `--library builtin` checks Bun's embedded SQLite; selecting a dylib there is rejected instead of silently ignored.

When implementing import-time SQLite selection, preserve the diagnostic’s explicit library selection before schema or sqlite-vec modules load. Otherwise the new initialization would reject the old library during the “before” comparison.

## Native CI checks

See [the agent testing guidance](../../AGENTS.md#test-guidelines) for automatic native coverage and how to request it. The PR check remains required under its existing name; [GitHub accepts a job skipped by a job-level condition](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions), so no branch-rule change is needed. Removing a label does not cancel an existing run. Release packaging and the signing check retain their full signed smoke; Trusted CI is reserved for main pushes.

Cancelled or superseded workflows are not validation: a native job cancelled while waiting for detection can appear skipped. Before merging, use the latest completed CI run; rerun it if cancellation left coverage uncertain.
