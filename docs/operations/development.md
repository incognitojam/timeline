# Development

Conventions for code, commits, and pull requests live in [AGENTS.md](../../AGENTS.md), along with the sample and full database workflows. Pull requests also need a changeset; see [Releases](releases.md).

## Running locally

```bash
bun run setup                # install dependencies and prepare a sample ./timeline.db

# Import data from an export
bun run src/parsers/spotify.ts ./imports/spotify my-account

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

## Testing

Run `./test.sh` before pushing. Screenshot comparisons run in the same Ubuntu
Playwright container locally and in CI. CI runs each chart resize sweep directly
on Ubuntu 24.04 with the locked Chromium version and its system dependencies.
Install Bun and Docker (Docker Desktop on macOS), and start Docker before running
the suite. Apple Silicon Macs use the same `linux/amd64` image through emulation.

The full suite runs backend tests, frontend tests, and type checks alongside the
browser checks; Playwright supplies the production build check. `./test.sh unit`
runs the unit checks without browsers or a production build. `./test.sh backend` and
`./test.sh frontend` run those checks separately for hosted CI. Each check reports
its duration and prints its log on failure. PR and trusted CI run browser projects
on separate Linux runners, while trusted CI keeps backend and app checks on macOS.

PR chart sweeps check representative widths and layout boundaries. Trusted CI on
main and local runs retain the exhaustive sweep. Set `PLAYWRIGHT_CHART_SWEEP=smoke`
to reproduce the PR coverage locally; the default is `full`. Dense health screenshots
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
runtime, native runtime dependencies, and version metadata into an artifact
that runs without the source checkout:

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
