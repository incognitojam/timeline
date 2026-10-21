# Embeddings & Vector Search (experimental)

Timeline can index events into a local vector store ([`sqlite-vec`](https://github.com/asg017/sqlite-vec))
for semantic search. This is an early foundation: a CLI that embeds events via
any OpenAI-compatible endpoint and runs nearest-neighbour search over them.

The vector index lives in `embeddings.db`, written next to `timeline.db`
(`[database].path`). Indexing reads `timeline.db` read-only and only ever writes
`embeddings.db`. Set `TIMELINE_EMBEDDINGS_DB_PATH` to override its location.

## Prerequisite: an extension-loading SQLite (macOS)

`sqlite-vec` is a loadable SQLite extension. Bun's `bun:sqlite` binds to the
system SQLite, which on macOS is built **without** dynamic extension loading, so
loading `sqlite-vec` fails with:

```
sqlite-vec is unavailable: This build of sqlite3 does not support dynamic extension loading
```

Point `bun:sqlite` at a SQLite that allows extensions via
`TIMELINE_SQLITE_LIBRARY_PATH`. Homebrew's build works:

```bash
brew install sqlite
export TIMELINE_SQLITE_LIBRARY_PATH="$(brew --prefix sqlite)/lib/libsqlite3.dylib"
```

`./test.sh` auto-detects Homebrew's SQLite on macOS, so the vector-search tests
run there (and in CI on the macOS host) without extra setup. On Linux the system
SQLite generally loads extensions already and no override is needed.

## Provider configuration

Configure the embedding model under `[embeddings]` in `config.toml`. Any
OpenAI-compatible server works — LM Studio, llama.cpp's `llama-server`, vLLM, or
a hosted API — on this machine or another one:

| Key | Required | Purpose |
|-----|----------|---------|
| `base_url` | yes | Server base URL, e.g. `http://127.0.0.1:1234/v1`; requests go to `<base_url>/embeddings` |
| `model` | yes | Model name passed to the server |
| `dimensions` | yes | Vector length the model returns (see warning below) |
| `api_key_env` | no | Name of the env var holding the API key; omit for keyless local servers |
| `profile` | no | Stable handle for this model in the index; defaults to `<model>:<dimensions>`. Use distinct names to index several models in one database |
| `document_prefix` | no | Text prepended to every indexed document, for models trained with task prompts |
| `query_prefix` | no | Text prepended to every search query, for models trained with task prompts |
| `timeout_seconds` | no | Seconds an embeddings request, including its response, may take before it fails; defaults to `60` |

`TIMELINE_EMBEDDING_BATCH_SIZE` (env) sets how many pending documents `index`
and background indexing send in each embeddings request; it defaults to `64`. A request also closes
once its documents reach
[`MAX_BATCH_BYTES`](../../src/embeddings/indexer.ts), so a run of long documents
travels in smaller requests that each finish within `timeout_seconds`.

> **`dimensions` must equal the model's true output width.** A mismatch is a
> *fatal* error (it recurs identically for every event), so `index` aborts on the
> first failed embedding rather than calling the provider once per event. No
> vector is written, the counts JSON still prints, and `index` exits nonzero. Set
> it to match the model, then re-run to resume.

Each model profile owns its own vector table in `embeddings.db`, so several
models — including ones with different vector lengths — can be indexed side by
side in one database. A profile name is pinned to a single model, dimension, and
`document_prefix`: re-running it with a different one is refused, since the
existing vectors would be incomparable with the new ones. Index an additional
model under a new `profile` name, or re-index into a fresh `embeddings.db`.
`query_prefix` only shapes query vectors, so it can change freely.

### Example: LM Studio (local, keyless)

Start LM Studio's server (`lms server start`) and load an embedding model
(e.g. `text-embedding-bge-m3`, which returns 1024 dimensions and takes no task
prompts) first, then:

```toml
[embeddings]
base_url = "http://127.0.0.1:1234/v1"
model = "text-embedding-bge-m3"
dimensions = 1024
```

### Example: llama-server on another machine

EmbeddingGemma expects task prompts on both sides:

```toml
[embeddings]
base_url = "http://gpu-box.example.ts.net:8080/v1"
model = "embeddinggemma-2"
dimensions = 768
document_prefix = "title: none | text: "
query_prefix = "task: search result | query: "
```

### Running llama-server on the Mac host

Timeline does not start the embeddings server. The versioned
[LaunchAgent template](../../deploy/macos/llama-embeddings.plist) runs
[llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` on a Mac and
unloads the model when idle.

Copy the template to your user's LaunchAgents directory:

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
cp deploy/macos/llama-embeddings.plist ~/Library/LaunchAgents/com.example.llama-embeddings.plist
```

Before loading it, edit the copy: replace the executable, model, projector, and
both log paths with absolute paths on your machine. launchd does not expand
`~` or shell variables inside the plist. For text-only embedding, remove the
`--mmproj` argument and its following path. Check that the model and configured
context fit your machine's available memory: the template disables automatic
memory fitting with `--fit off`. With llama.cpp b11471 and EmbeddingGemma 2,
automatic fitting took most of the 60-second request timeout on a measured
idle wake; disabling it let the same model wake and return a vector in under
a second.

Validate and load the edited copy:

```bash
plutil -lint ~/Library/LaunchAgents/com.example.llama-embeddings.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.llama-embeddings.plist
```

For an existing installation, preserve its `Label` and filename when copying
updated settings from the template. Boot out the existing label with
`launchctl bootout gui/$(id -u)/<label>`, wait until
`launchctl print gui/$(id -u)/<label>` reports it is gone, then bootstrap the
updated plist. A kickstart alone reuses launchd's previously loaded arguments.

The context and batch sizes follow the per-slot rule under [Usage](#usage).
Match the indexer's concurrency to the template's parallel slots. The projector
loads the vision encoder that [photo indexing](#photos) needs.

## Usage

```bash
# Embed events (--limit bounds how many events are processed)
bun run embeddings index --limit 100

# Start indexing from a date or ISO timestamp
bun run embeddings index --since 2026-01-01 --limit 100

# Override the default corpus temporarily
bun run embeddings index --limit 100 --include discord,spotify --exclude spotify:listen:podcast

# Semantic search
bun run embeddings search --limit 10 "music I listened to last winter"
```

`index` defaults to `--limit 25`; pass a larger limit for broader indexing runs.
`--concurrency` (default `8`) sets how many embeddings requests `index` keeps in
flight at once. Vectors are still written in event order, whatever order the
responses arrive in. Requests waiting in the server's queue count toward
`timeout_seconds`, so keep `--concurrency` near the number of requests the server
processes in parallel (llama-server's `--parallel` slots).

`index` uses the declared embedding corpus by default; its allowlist and
type-level denylist live in
[`EVENT_CORPUS_POLICY`](../../src/embeddings/corpus.ts). The allowlist keeps
sources excluded until they are explicitly added, avoiding unreviewed corpus
expansion. It always applies the policy denylist.

Filter with `--include` / `--exclude`. Each takes a whole source (`discord`) or a
single source/type pair (`spotify:listen:track`); both flags can be repeated and
accept comma-separated values:

- `--include discord,spotify` — only these sources
- `--exclude reddit` — drop a whole source
- `--include spotify:listen:track` — only this source/type pair
- `--exclude reddit:vote:up,reddit:vote:down` — drop these pairs

An explicit `--include` replaces the default source allowlist; `--exclude`
subtracts from whichever set is in effect. The Reddit vote exclusions always
apply. `SOURCE:TYPE` values split on the first colon, so event types that
contain colons work as expected (`spotify:listen:track`). Filters apply before
`--limit` is evaluated. They control which events are selected for indexing;
they do not delete vectors that already exist in `embeddings.db`. Re-index into
a fresh `embeddings.db` if you need old vectors removed from search results.

Indexing is idempotent: unchanged events are reused and already-embedded
documents are skipped, so interrupted or failed runs recover on re-run.
`--since` filters index candidates to events whose timestamp is on or after the
given `YYYY-MM-DD` date or ISO timestamp with a `Z` or offset timezone.

Each event is rendered as one document of at most 8,000 UTF-8 bytes
([`MAX_RENDERED_BYTES`](../../src/embeddings/content.ts)); a longer event keeps its
kind, title, and location and loses the end of its content. That keeps every
document within an 8K-token model window. With llama-server, each request must
also fit one slot: keep `--ubatch-size` at 8192 or more and `--ctx-size` at least
8192 × `--parallel`.

Pending documents are embedded in request batches. If a provider rejects a batch
with a per-input style error, Timeline splits that batch and retries smaller
groups until it can skip only the bad input. Fatal provider-wide errors still
abort the run immediately.

## Background indexing

`bun run service` keeps the index current through the `embeddings` sync
source: enable it on the Sync page once `[embeddings]` is configured. Each run
embeds the corpus events added since the previous run, walking `events.id` from
a cursor stored in `embeddings.db` for the content and model profile pair, and
stops when it catches up or its time budget runs out. A provider outage fails
the run without moving the cursor past unembedded events, so the next run
resumes where it stopped.

| Setting | Default | Purpose |
|---------|---------|---------|
| `interval` | scheduler default | How often to look for new events |
| `time_budget_ms` | `60000` | When a run stops starting new work, up to five minutes; requests already in flight finish first. Syncs run one at a time, so the others wait while this one runs |
| `concurrency` | `4` | Requests kept in flight; match llama-server's `--parallel` |
| `require_ac_power` | `false` | Skip scheduled runs while on battery or in Low Power Mode (macOS) |
| `index_images` | `false` | Also embed [photos](#photos) |
| `require_unmetered`, `skip_blocked_networks` | | Skip scheduled runs on metered networks or the Wi-Fi networks blocked in Settings, for photo downloads |

A cursor that has never run starts at the first event and re-checks every
corpus event, reusing vectors already in `embeddings.db`, so a large existing
index takes several runs to catch up before only new events remain. The
source's Sync page charts the events left past the cursor after each run,
falling to zero once it has caught up.

The cursor only moves forward, so some events still need a full
`bun run embeddings index` run:

- events whose content changed after they were embedded
- events that failed individually (the run reports them as an error)
- older events of a source newly added to the corpus policy
  (`--include <source>`)

### Photos

With `index_images` on, each run embeds photos with whatever time budget the
new events leave. EmbeddingGemma 2 embeds the image itself into the same vector
space as text, so a text query can find a photo by what it shows. This needs
llama-server started with `--mmproj`; without it the run fails with a message
saying so.

- Photos are the stored JPEG, PNG, WebP and GIF attachments
  ([`EMBEDDABLE_IMAGE_TYPES`](../../src/embeddings/images.ts)) of the corpus policy's
  sources, newest first. Each distinct image is embedded once and linked to
  every event that carries it.
- An image the local media cache lacks is fetched from remote media storage
  without being added to the cache, so a catch-up does not evict the cache's
  working set.
- Each image is downscaled to fit
  [`IMAGE_MAX_SIDE`](../../src/embeddings/images.ts) before embedding.
- An image that is missing from media storage or cannot be decoded is recorded
  in the `embedding_failures` table and skipped by later runs; delete its row to
  retry it.
- Photo vectors are kept in a separate table from event vectors, so semantic
  search over events is unchanged.

## Semantic search via MCP

The `semantic_search` MCP tool exposes the same nearest-neighbour search to
agents, ranked by similarity and returning the same `#<id>` event lines as
`query_events` (so results stay deep-linkable). It embeds the query with the
configured model and searches the profile's vector table.

The tool is gated on configuration: without an `[embeddings]` section it returns
a short setup message instead of results, so hosts that haven't opted into
embeddings are unaffected.

`sqlite-vec` requires selecting its SQLite library *before* any `bun:sqlite`
database is opened, so each server entry — `bun run mcp` (stdio), the API server
started by `bun run dev`, and `bun run service` — calls
`configureBunSqliteForSqliteVec()` at startup,
before opening a database. That picks up `TIMELINE_SQLITE_LIBRARY_PATH` the same
way the CLI does (a no-op when it is unset), so `semantic_search` works over both
the stdio and HTTP transports once the host sets that variable, configures
`[embeddings]`, and an index exists.

Embedding failures are split by how they recur:

- **Fatal** (config or provider-wide): a dimension mismatch, rejected auth, a
  missing endpoint/model, rate limiting (HTTP 429), a 5xx, an unreachable
  host, or a request that exceeds `timeout_seconds`. These would fail every event
  the same way, so `index` aborts on the first one and cancels the requests still
  in flight, rather than hammering the provider (any `Retry-After` is echoed in the error
  so you know when to resume).
- **Per-event** (input-specific, e.g. a 4xx the provider raised for one input):
  that event is skipped and indexing continues.

Either way the counts JSON still prints and `index` exits nonzero if any event
failed to embed; re-run to retry just the failures.
