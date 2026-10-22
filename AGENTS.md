# AGENTS.md

This file provides guidance to AI coding assistants when working with code in this repository.

## Project Overview

Timeline is a personal data aggregator that indexes exports from various services (Spotify, Google, Reddit, LinkedIn, etc.) into a unified searchable SQLite database. The goal is to create a queryable timeline of personal history, similar to Ploze but self-hosted with full control over the schema.

## Vendored Repositories

This project vendors external repositories under @repos/

  - Use vendored repositories as read-only reference material when working with related libraries
  - Prefer examples and patterns from the vendored source code over generated guesses or web search results
  - Do not edit files under @repos/ unless explicitly asked
  - Do not import from @repos/ - application code should continue importing from normal package dependencies

When writing Effect code, inspect @repos/effect/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

When reasoning about SolidJS reactivity (signals, resources, Suspense/transitions) or Solid Query behavior, read the actual implementation rather than guessing: @repos/solid/ (pinned to the installed solid-js version; the reactive core, including createResource and SuspenseContext, is `packages/solid/src/reactive/signal.ts`) and @repos/query/ (pinned to the installed @tanstack/solid-query version; the Solid adapter is `packages/solid-query/`, cache/observer logic in `packages/query-core/`).

## Service Deployment

Timeline self-hosts on a **macOS** host. The menu bar app runs recall capture in-process and owns the service and Tailscale LaunchAgents; the service runs under launchd from the packaged runtime inside `~/Applications/Timeline.app` — see [docs/user/macos-host.md](docs/user/macos-host.md).

**Architecture**:
```
Service (main process: app-bundled Bun runtime)
  ├── Main Thread
  │   ├── API Server (Hono, serves built web app, reads from timeline.db)
  │   └── App State DB (read/write: chats, messages, sync_log, etc.)
  │
  └── Worker Thread (keeps API responsive during syncs)
      ├── Sync Scheduler (per-source settings from app-state.db, writes to timeline.db)
      └── Inbox Watcher (fs.watch for new files, processes imports)
```

**Key Design**: Sync and import operations run in a separate Worker thread so they don't block the API event loop. The worker is the only thread writing to `timeline.db`, while the API only reads from it and reads/writes to `app-state.db`.

**Paths (macOS host)**:
- Bootstrap config: `~/.config/timeline/config.toml` · Secrets: `~/.config/timeline/env`
- Database: `~/.local/share/timeline/{timeline.db,app-state.db}` · Media: `~/.local/share/timeline/media`
- Logs: `~/Library/Logs/timeline/service.log`
- Runtime: `~/Applications/Timeline.app/Contents/Resources/timeline-service`
- Apply source changes by rebuilding/installing the app; the service never reads or mutates the checkout.

**Service commands (macOS)**:
```bash
launchctl print gui/$(id -u)/dev.incognitojam.timeline-service        # status
tail -f ~/Library/Logs/timeline/service.log                           # logs
launchctl kickstart -k gui/$(id -u)/dev.incognitojam.timeline-service # restart
curl -s http://127.0.0.1:3001/api/health                              # API is localhost-only
```

> **Stopping the service (backfills/maintenance)**: `touch ~/.local/share/timeline/service.hold` *before* `launchctl bootout` — Timeline.app self-heals a bare bootout within ~30s. Remove the hold to restore (see [docs/user/macos-host.md](docs/user/macos-host.md), "Stopping the service for maintenance").

Install: `cd tools/timeline-app && ./build.sh --install && open ~/Applications/Timeline.app` (macOS app-owned LaunchAgents — see [docs/user/macos-host.md](docs/user/macos-host.md)).

**Authentication**: `AUTH_PASSWORD` is required outside development/test. Protects `/status`, `/status.md`, and all `/api/*` routes except `/api/health` and `/api/auth/*`; MCP endpoints use token auth (`MCP_TOKENS`). Uses Basic Auth (`curl -u ':password' URL`). Cookie set automatically on success. For local development authentication, see [Running locally](docs/operations/development.md#running-locally).

**Status page**: `/status` shows service health, sync stats, and scheduler state. Use `/status.md` (or `Accept: text/markdown` header) for markdown output suitable for LLMs/agents.

**Performance**: The API emits [`Server-Timing`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Server-Timing) headers on responses (via Hono's `timing()` middleware). View per-request timing breakdowns in browser DevTools under Network > Timing. See `src/api/index.ts` for instrumented paths.

## Development Workflow

Development happens locally. The **macOS host** runs the service packaged inside `Timeline.app`, so apply source changes with `cd tools/timeline-app && ./build.sh --install` (see [docs/user/macos-host.md](docs/user/macos-host.md)).

**Worktree/clone setup**: `bun run setup` (`scripts/setup.sh`) installs root + `web/` dependencies, copies the gitignored files listed in `.worktreeinclude` from the main clone, links `./imports`, and prepares a sample `./timeline.db`. Agent harnesses run it on worktree creation; re-run it by hand any time.

> **Note**: `prepare-sample`/`prepare-full` generate or refresh caches from the local host DB (no SSH). Existing caches can be copied to another machine and reused there without the host DB.

**Sample database for local development**:
```bash
bun run prepare-sample             # Reuse cached sample (any age) or generate; copy to ./timeline.db
bun run prepare-sample -- --refresh  # Force regenerate the sample
bun run prepare-sample -- --percent=2  # Sample 2% instead of default 1%
bun run prepare-sample -- --no-contacts  # Omit contact/identity tables (e.g. for a shareable sample)
```

The script samples the local host DB (`[database].path` from `~/.config/timeline/config.toml`, default `~/.local/share/timeline/timeline.db`) into `~/.local/share/timeline/sample.db` and copies that to `./timeline.db`. The cache is reused regardless of age and does not require the host DB to remain available — pass `--refresh` (or `--percent`) on the Timeline host to regenerate it. It also removes `.no-local-db` so the workspace can use `./timeline.db` directly.

**Full database for local development**:
```bash
bun run prepare-full              # Reuse cached full DB (any age) or clone; copy to ./timeline.db
bun run prepare-full -- --refresh # Force re-clone from the host DB
bun run prepare-full -- --no-copy # Update the cache only (skip ./timeline.db)
```

`--full` clones the local host DB using a copy-on-write clone where the filesystem supports it (`cp -c` on macOS or a reflink on Linux). The clone is cached at `~/.local/share/timeline/full.db` (a distinct filename from the host's `timeline.db`, so the cache can never alias the live DB) and reused regardless of age or whether the host DB remains available; pass `--refresh` on the Timeline host to re-clone. It's a **dev snapshot, not a backup**: the clone omits the host's WAL, so it can lag the live DB by the most recent few MB of committed writes (immaterial for development; checkpoint the host first if you need the exact latest).

## Database Locations

- **Host (production)**: `~/.local/share/timeline/timeline.db` on the macOS host (`[database].path` from config)
- **Local development**: `./timeline.db` (repo-local, the default)

Set `TIMELINE_DB_PATH` env var to override.

### Local Development Database

For local development, `./timeline.db` is the default and doesn't require setting `TIMELINE_DB_PATH`. Agent worktrees run `bun run setup` on creation, so `./timeline.db` already exists. For standalone development, run `bun run setup` (or just `bun run prepare-sample`) first.

**When to use `prepare-sample` vs `prepare-full`:**
- **`bun run prepare-sample`** — Creates a 1% sample DB. Good for most development: UI work, API changes, parser testing, frontend iteration. Fast and small.
- **`bun run prepare-full`** — Creates a complete copy of the host database. **Recommended before testing backfill scripts, migrations, or features that benefit from comprehensive/realistic data.** Cheap on filesystems with copy-on-write cloning. Always test with `prepare-full` before running scripts against the host DB.

The `.no-local-db` marker file (in the repo root) prevents accidental writes when no local DB has been prepared. Both `prepare-sample` and `prepare-full` remove this marker automatically.

### App State Database

`app-state.db` lives alongside `timeline.db`. Stores chats, messages, day_summaries, and sync_log. Schema in `src/db/app-state.ts`.

## Commands

```bash
bun install

# Parsers: bun run src/parsers/<name>.ts [args...]
# Args vary by parser; check the CLI block near bottom of each file. Setup: docs/user/source-setup.md

# Run the web app (uses T3 workspace ports when available, otherwise free ports)
bun run dev

# Point the frontend at the production API instead (skips the local API;
# useful for frontend-only changes that need realistic data)
API_HOST=https://timeline bun run dev

# Run MCP server (for testing)
bun run mcp

# Embeddings / vector search (experimental — needs sqlite-vec + an embeddings
# endpoint; see docs/user/embeddings.md for required env vars)
bun run embeddings index --limit 100
bun run embeddings search --limit 10 "query text"

# Run as persistent service (with scheduler, watcher)
bun run service

# Lint
bun run lint                          # Run Biome linter (also runs in test.sh)

# Record release impact for a pull request; use --empty when none
bun changeset

# Run tests
./test.sh                             # Runs all tests + lint + build. Prefer for most changes; required before commit/PR.
bun test                              # Backend tests only (uses temp database via bunfig.toml)
bun test src/api/api.test.ts          # Run specific backend test file
(cd web && bun run test:run)          # Frontend tests only (Vitest)

# Query the database directly
sqlite3 ./timeline.db "SELECT * FROM events WHERE source='spotify' LIMIT 5;"

# Full-text search
sqlite3 ./timeline.db "SELECT * FROM events WHERE id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH 'search term');"
```

> **Syncs**: The scheduler in `bun run service` runs syncs automatically; the web UI's `/status` page can trigger any source on demand.

> **Note**: Commands use `./timeline.db` by default. Override with `TIMELINE_DB_PATH=<path>`. Utility scripts live in `src/scripts/` (backfills, verification, etc.).

## Recall Tooling

Mac screen recall runs inside `tools/timeline-app`, which also owns the service and Tailscale LaunchAgents. Build with `./build.sh`; refresh the installed copy with `./build.sh --install`. The **Record Screen** menu toggle requests permission for Timeline and controls `~/.local/share/timeline/recall.pause`. Quitting the app stops capture; enable **Launch at Login** to resume after signing in. See `docs/user/recall-setup.md` for setup and migration from the retired Recall LaunchAgent.

`tools/timeline-recall` retains a standalone diagnostic capture tool sharing the app's capture engine. It is not required for normal recording. Its `create-signing-identity.sh` also supplies the stable identity used by local app builds.

## Architecture

### Database Schema (`src/db/schema.ts`)
Single unified `events` table stores all data from all sources:
- **Source tracking**: `source`, `source_id`, `source_account` (for multiple accounts per service)
- **Event data**: `type`, `timestamp`, `end_timestamp`, `duration_ms`
- **Content**: `title`, `content` (both indexed in FTS5)
- **Location**: `latitude`, `longitude`, `location_name`
- **Entities**: `people` (JSON), `tags` (JSON)
- **Raw preservation**: `raw_data` (original JSON, never modified for reprocessing)

FTS5 virtual table `events_fts` provides full-text search with automatic sync triggers.

### Parsers (`src/parsers/`)
Each parser reads export files and inserts into the unified schema:
- Parsers preserve original data in `raw_data` JSON field
- Use `source_account` to distinguish multiple accounts from same source
- `import_batch` groups related imports for easy re-import
- Unique constraint `(source, source_id, source_account)` prevents duplicates

### Data Flow
1. Raw exports stored in `~/.local/share/timeline/imports/{source}/` (preferred) or `./imports/{source}/` (gitignored, for quick local dev)
2. Parser reads export format, normalizes to events schema
3. Events inserted into `timeline.db` with FTS indexing
4. Query via SQL or future MCP server

### LLM Context Export (`src/export/`)
Exports events as readable text for LLM context windows. CLI (`cli.ts`) supports `contact`, `range`, and `conversation` commands. Smart group filtering for large chats (5+ people) uses asymmetric context windows.

### AI Features

Day summarization and journal prompts run text generation through configured LLM providers (`src/llm/`), resolving a model reference to a Vercel AI SDK `LanguageModel`. Providers are set under `[llm.providers.<name>]` in config: `openrouter` (needs `OPENROUTER_API_KEY`) or `openai-compatible` (any OpenAI-compatible server — LM Studio local or over the network, llama.cpp, vLLM). There is no baked-in default — with no `[llm.providers.*]` configured, text generation is unavailable. The first configured provider's models are addressed by bare id (e.g. `google/gemini-3.1-flash-lite`); others by `<provider>/<model-id>`. Model context windows (which size how much of a day is sent before chunking) are auto-detected per model — OpenRouter from its live API, LM Studio from its native `/api/v0/models` using the *loaded* window (embedding models excluded); `context_length` in config is a fallback for servers that don't report it. Summaries cached in `day_summaries` (keyed by date + model). The aggregated catalogue is served at `GET /api/summary/models` and selectable via UI dropdowns, grouped by provider.

### Sync Orchestrator (`src/sync/`)

Automated data syncing from API-based sources. Structure: `config.ts`, `types.ts`, `log.ts`, and `sources/` directory with one file per sync source.

**Configuration**: Per-source sync settings live in the `sync_sources` table in `app-state.db` and are edited from the web UI. Legacy `[sync.<source>]` sections in `config.toml` are imported once at `bun run service` startup when the table is empty, then ignored with a warning until removed. Discord account is auto-detected.

**Adding new sync sources**: Create a file in `src/sync/sources/` exporting a `SyncSource` object with `name`, `description`, `enabled`, `canSync()`, and `sync()` methods. A source with editable settings declares them through `configSchema`. Register it in `src/sync/sources/index.ts`.

### Service Mode (`src/service.ts`)

Run as a unified service: `bun run service` (or `TIMELINE_CONFIG=/path/to/config.toml bun run service`).

**Configuration** (`~/.config/timeline/config.toml`): Bootstrap TOML with `[server]`, `[database]`, `[scheduler]`, `[media]`, `[backup.r2]`, `[llm]`, and `[inbox]` sections. Sync-source settings live in `app-state.db` after the one-time `[sync.*]` import. `config.toml` is read once at startup; restart the service to apply bootstrap changes.

### MCP Server

Timeline exposes an MCP server for AI assistants to query the timeline.

- **Stdio**: `bun run mcp` — for Claude Code, local MCP clients. Configure in `.mcp.json`.
- **HTTP**: `/mcp/<token>` endpoint (Streamable HTTP transport). Set `MCP_TOKENS` env var. Expose via Tailscale Funnel for remote access (e.g., Claude.ai Custom Connectors).

**Files**: `src/mcp.ts` (stdio entry), `src/mcp-tools.ts` (shared tools), `src/api/mcp-http.ts` (HTTP handler), `src/api/mcp-tokens.ts` (token validation).

## Key Design Decisions

- **Raw data preservation**: Always keep original export data in `raw_data` field so data can be reprocessed if schema/parsing improves
- **Nullable timestamps**: Some events (Reddit votes) have no timestamp - schema allows null
- **Multiple accounts**: `source_account` field tracks which account data came from
- **JSON for flexibility**: `people`, `tags`, `raw_data` use JSON for schema flexibility

## Linting

Biome enforces lint rules across `src/` and `web/src/`. Runs automatically in `test.sh`.

```bash
bun run lint                          # Run Biome linter
```

**Rules:**
- **No non-null assertions** (`!`) — fix the types or logic so `!` isn't needed. Allowed in test files (`*.test.ts`).
  - **Make types accurate**: If a type says `string | undefined` but the value is always present, fix the type (e.g., discriminated unions, narrower interfaces).
  - **Fail fast for internal data**: If a value should never be null, throw an error rather than silently falling back (`if (!x) throw new Error(...)` not `x ?? default`).
  - **Validate at boundaries**: Parse/validate user input and API responses at the boundary, then use accurate types internally.
  - **SolidJS `<Show>`**: Use the callback form `<Show when={value()}>{(val) => ...}</Show>` to get a narrowed accessor.
  - **Map has/set/get**: Capture the array in a variable instead of `.get()?.push()` after `.has()/.set()`.
- **No explicit `any`** (warning) — use specific types or `unknown` where possible

## Bash Guidelines

### IMPORTANT: Avoid commands that cause output buffering issues
- DO NOT pipe output through `head`, `tail`, `less`, or `more` when monitoring or checking command output
- DO NOT use `| head -n X` or `| tail -n X` to truncate output - these cause buffering problems
- Instead, let commands complete fully, or use `--max-lines` flags if the command supports them
- For log monitoring, prefer reading files directly rather than piping through filters

### When checking command output:
- Run commands directly without pipes when possible
- If you need to limit output, use command-specific flags (e.g., `git log -n 10` instead of `git log | head -10`)
- Avoid chained pipes that can cause output to buffer indefinitely

## Git Guidelines

### Release notes

Before opening or updating a pull request, follow [docs/operations/releases.md](docs/operations/releases.md). Every pull request must commit either a release changeset from `bun changeset` for a user- or operator-visible change, or an empty changeset from `bun changeset --empty` when the change should not appear in the changelog.

Treat the changeset as release metadata, not as a feature. Pull-request summaries and changeset text should describe the actual observable change.

- **Scoped commits**: Format as `<scope>: <description>` with an optional body/trailers. Scope is the subsystem touched (e.g., `api:`, `web:`, `sync:`); prefer deriving it from existing repo history.
- **Short titles**: Under 50 chars preferred, 72 max
- **Atomic and self-justifying**: Each commit (and PR) is one logical change, exercised at merge — not scaffolding nothing calls yet. If a feature has multiple moving parts, commit them together rather than splitting into non-functional pieces.
- **No dead code**: Nothing without a caller. Wire it up as it lands, or feature-flag it. When "keep it small" conflicts with "no dead code," no-dead-code wins — resolve with vertical slicing or a flag.
- **Slice vertically**: Build a thin end-to-end path first, then widen — not horizontally ("all backend, then all frontend"). Split frontend/backend only along a real seam (e.g. a versioned API contract) where each side is independently testable.
- **Separate mechanical from behavioral changes**: Renames, formatting, and moves go in distinct commits from behavioral changes (and ideally separate branches) to avoid introducing regressions.
- **Stack small dependent PRs**: Order them so each rung is consumed as it lands. If a PR is one rung in a stack, state what it depends on and what consumes it.
- **Commit why-rule**: Describe *what* changed. Add a reason only when you can cite a specific checkable artifact — a failing test, error/stack trace, API limit, measured behavior, or the GitHub issue for this slice. The artifact must explain why *this* change in *this* form, not just name the broader task. Put the reason in the body/trailer. Reference the GitHub issue there with `Closes #N` only when the commit resolves it, otherwise `Refs #N` / `Part of #N`. No artifact → no invented rationale; describe plainly or let a self-evident diff speak for itself.
- **Single source of truth**: Define each constant, config value, or type once — others import or derive it. Don't restate in comments/docs what the code, types, or schema already express; state each fact once, closest to where it's enforced.
- **Branch naming**: Name branches after the logical change, not the layer. Prefer `add-rate-limit-to-login` over `backend-changes`.
- **Clean up before opening a PR**: Rebase/squash the branch. Run tests before pushing — `./test.sh` must pass.
- **Link the issue in the PR body**: `Closes #N` if the PR resolves it, `Refs #N` / `Part of #N` if partial. No closing keyword unless it genuinely closes the issue.

### Pull request content

Treat everything in a pull request as public: descriptions, screenshots, recordings, and CI logs.

- **Synthetic data only**: Screenshots, recordings, and examples in a pull request must show fixture or sample data, never a personal database. The e2e fixtures in `web/e2e/` are a good source.
- **Attach images, don't commit them**: Upload screenshots with `gh pr edit <number> --attach './shot.png#Alt text'` (or `gh pr create --attach`). Never push images to a branch to embed them in a pull request.

### Code Review Checklist

Also apply the project-specific checks in `.agents/checks/` (parser/importer safety, database cleanup safety, PR atomicity, private identifiers).

- Flag code added without a caller, or an interface whose usage isn't in the diff.
- Flag mechanical changes (renames, formatting) mixed into behavioral diffs.
- Check the PR is atomic and self-justifying; call out scaffolding that adds no usable feature yet.
- Apply the commit why-rule: flag a stated why that cites no checkable artifact, and flag a closing keyword on a change that only partially addresses the referenced issue.
- Check commit/PR titles follow Scoped Commits (`<scope>: <description>`) with a scope already in use in the repo's history.
- Single source of truth for values: flag the same constant, config value, or type defined in more than one place.
- Single source of truth for docs: flag comments or docs that restate what the code/types/schema already express.
- When a PR adds or bumps a dependency, or uses a library API you're not certain is current, check the library's docs/changelog for breaking changes.
- Flag code comments, commit messages, or descriptions that contradict each other or the implementation.

## Fail Fast - No Silent Defaults

**NEVER create defaults that mask failures.** If a required config, environment var or dependency is missing, RAISE AN EXCEPTION AT INIT. Do not silently substitute a "safe" fallback that makes code appear to work while actually being broken. Swallowing errors to avoid exceptions is not defensive programming - it's sabotage. Your collaborators will waste hours debugging phantom failures that surface far from the root cause. A loud crash at startup is infinitely preferable to silent corruption downstream. If the system cannot operate correctly, it must refuse to operate at all.

## Test Guidelines

- **No real personal data in tests** - Use generic names ("Alice", "Bob"), `example.com` emails, and placeholder locations
- **New API endpoints need smoke tests** - Basic coverage ensuring the endpoint responds correctly
- **Tests must run fast** - Slow tests get skipped; keep the feedback loop tight
- **Prefer seed data + integration tests over endless unit tests** - Test real behavior through the actual code paths

**Backend tests** use Bun's native test runner (`bun test`). Test files live alongside source in `src/**/*.test.ts`.

**Frontend tests** use Vitest with jsdom and `@solidjs/testing-library`. Test files live in `web/src/**/*.test.{ts,tsx}`. Run with `bun run test` from the `web/` directory.

## Frontend Stack Pitfalls

The web app uses SolidJS, TanStack Solid Query, and Tailwind v4. Key gotchas:

- **No emoji UI chrome** - Use components from `web/src/ui/icons.ts` for interface icons; emoji from user or source data, including reactions, remains unchanged.

### SolidJS (not React!)
- **Never destructure props** - breaks reactivity: use `props.name` not `const { name } = props`
- **Never destructure query results** - use `query.data` not `const { data } = query`
- **Signals are functions** - call them: `count()` not `count`
- **Prefer derived state over effects** - `const doubled = () => count() * 2` not `createEffect(() => setDoubled(count() * 2))`
- **Use control flow components** - `<Show>`, `<For>`, `<Switch>` instead of ternaries/map
- Use `splitProps()` and `mergeProps()` for prop handling

### Solid Query
- **Options must be a function**: `createQuery(() => ({ queryKey, queryFn }))`
- Signals work inside the options function: `queryKey: ['todos', filter()]`

### Vitest + SolidJS Testing
- See `.agents/skills/vitest-solid/SKILL.md` for testing patterns (render takes a function, no rerender, etc.)

### Tailwind v4
- Scale shifted: `shadow-sm` → `shadow-xs`, `rounded` → `rounded-sm`
- No more `bg-opacity-*` - use `bg-black/50` modifier syntax
- Config is CSS-first (`@theme` directive), not `tailwind.config.js`

See `.agents/skills/` for detailed patterns and examples.

## Current Data Sources

| Source | Types |
|--------|-------|
| WakaTime | code:session (aggregated from heartbeats) |
| Facebook | message, message:photo, message:share, message:gif, etc.; post, comment, reaction, group:join, event:rsvp, friend:added |
| Google Search | google:search, google:visit |
| Spotify | listen:track, listen:podcast, listen:audiobook |
| Spotify Friends | listen:track:friend (friends' listening activity via unofficial API) |
| Discord | message:dm, message:group, message:dm:attachment, message:group:attachment |
| YouTube | youtube:watch, youtube:search, youtube:like, youtube:subscribe, youtube:view |
| Skype | message:dm, message:group |
| Google Fit | activity:walking, activity:running, activity:biking, etc. |
| Google Location | location:visit, location:transit |
| Reddit | post, comment, message, vote |
| Monzo | transaction, transaction:topup, transaction:credit, transaction:transport, etc. |
| Amex | transaction, transaction:payment, transaction:refund, transaction:groceries, transaction:food, etc. |
| Chrome | browse |
| Trakt | trakt:movie, trakt:episode |
| Swarm | location:visit |
| Google Play Store | playstore:install |
| Google Calendar | event, event:all-day |
| LinkedIn | message, connection, job, education |
| GitHub | github:issue, github:pr, github:comment, github:review |
| Google Keep | note:text, note:list |
| Google Chat | message |
| Instagram | instagram:message:dm |
| Google Timeline | activity, visit (new Timeline.json format) |
| SMS Backup & Restore | sms:sent, sms:received, mms:sent, mms:received, call:incoming, call:outgoing, call:missed |
| Google Messages | sms:sent, sms:received, mms:sent, mms:received, rcs:sent, rcs:received (live via tools/timeline-gmessages) |
| Minecraft | minecraft:chat, minecraft:join, minecraft:leave, minecraft:advancement, minecraft:death |
| Claude | claude:message:user, claude:message:assistant, claude:memory |
| ChatGPT | chatgpt:message:user, chatgpt:message:assistant |
| Claude Code | claude-code:message:user, claude-code:message:assistant |
| Amp | amp:message:user, amp:message:assistant |
| OpenCode | opencode:message:user, opencode:message:assistant |
| Conductor | conductor:message:user, conductor:message:assistant |
| T3 Code | t3code:message:user, t3code:message:assistant |
| Codex | codex:message:user, codex:message:assistant |
| Fitbit (Takeout) | sleep, sleep:nap, daily:readiness, daily:stress, daily:hrv |
| Google Health (replaces Fitbit API sync) | sleep, sleep:nap, daily:hrv, daily:spo2, daily:breathing, daily:heart, daily:activity, daily:temperature, daily:azm, daily:weight |
| Thriva | thriva:biomarker, thriva:order |

## Source Setup

See `docs/user/source-setup.md` for credentials and setup instructions for API-based sources (Monzo, Thriva, Google Health, Spotify, Trakt, GitHub, WakaTime).

## API Integration Best Practices

When implementing API-based parsers/sync sources:

### Rate Limiting
1. **Check response headers** for rate limit info. Two common patterns:
   - **Quota tracking**: `X-RateLimit-Remaining` tells you calls left (no delay needed between requests)
   - **Throttling**: `Retry-After` tells you to slow down (must wait between requests)
2. **Read the API docs** to understand which pattern applies
3. **On 429 errors**: Check for reset/retry header, stop sync and resume later
4. **Never guess** at intervals - always use the headers

### Incremental Sync
1. Store the latest synced timestamp/ID
2. Sync recent data first (most useful)
3. Backfill historical data gradually if quota allows
4. Exit cleanly when quota low - scheduler will resume

### Error Handling
1. Distinguish between retryable (429, 503) and permanent (401, 404) errors
2. Log rate limit state for debugging
3. Fail gracefully - partial sync is better than no sync
