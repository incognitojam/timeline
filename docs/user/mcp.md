# MCP server

Timeline exposes its data to AI assistants over the [Model Context Protocol](https://modelcontextprotocol.io). Tools include `query_events`, `get_context`, `get_summary`, `export_conversation`, `list_contacts`, `get_contact_info`, `run_sql`, and `semantic_search` (which needs [embeddings](embeddings.md)), plus the shared [memory](#memory) tools.

## Local (stdio)

From a checkout, `bun run mcp` serves the tools over stdio against `./timeline.db`, or the database named by `TIMELINE_DB_PATH`. The repository's `.mcp.json` registers it for Claude Code; other clients can run the same command.

## Remote (HTTP)

The service serves MCP over Streamable HTTP when `MCP_TOKENS` is set in `~/.config/timeline/env` to a comma-separated list of tokens. Clients connect to `/mcp` with an `Authorization: Bearer <token>` header, or to `/mcp/<token>` for clients that can only take a URL.

To reach it from your other devices, use [Remote Access](macos-host.md#remote-access-tailnet-only), which serves it to your tailnet. Hosted clients such as Claude.ai custom connectors connect from the internet, so they can reach it only while [public access](macos-host.md#public-access) is on.

With Tailscale v1.72.0 or later in HTTP reverse-proxy mode, only MCP is available through Funnel. TCP forwarding and older proxies can expose the full service because they omit the marker. The web app, API, and status pages return a plain 403. Keep the service on loopback and use Tailscale's HTTP reverse proxy. It clears client-supplied Funnel headers and sets `Tailscale-Funnel-Request: ?1` from connection metadata on public requests, so a proxied client cannot forge or remove the marker. A direct caller controls its own headers. See [Tailscale's proxy implementation](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go).

Each configured token permits 600 public requests per rolling hour across both authentication forms. Ten missing or invalid credentials within 15 minutes lock requests from that public source IP out for 15 minutes, including valid clients sharing the address. Tailscale supplies the source via `X-Forwarded-For`. A 429 response includes `Retry-After` in seconds. Restarting the service clears both limits. Localhost and tailnet requests without the marker bypass them.

## Memory

Timeline keeps one memory that every connected agent shares, whichever harness or machine it runs on. Agents write it during a turn, as they learn facts, preferences and corrections.

A note has a name (a lowercase slug such as `coffee-order`), a title, a one-line summary, Markdown details and a kind: `you` (preferences and profile), `topic`, `area`, `person` or `project` (about the project itself, such as an `overview`). A person note can link a Timeline contact. Details can mention another note as `[[name]]`; the link is kept as written, and the note it names need not exist yet.

A note belongs to the account or to one project. A project is named by the key the agent passes, normally the repository name, normalised to a slug such as `my-app`. Names are unique within a scope, so the account and each project can each have their own `bob`.

- `list_memory` returns the index: each note's name, title, summary and update date, by kind. With a project, the project's notes come first, then the account's.
- `get_memory_note` reads one note in full.
- `save_memory_note` creates a note, or updates the note of that name in that scope, replacing only the fields given.
- `delete_memory_note` deletes a note.

When a client connects, the server's instructions tell the agent about the memory and include the `you` notes in full and the account index, up to about 12,000 characters. Past that the agent gets the index alone and fetches the rest with the tools.

Memory lives in `app-state.db` and holds at most 500 notes. Each update or delete keeps the note's previous version in the same table: the last 10 versions of each note, and the newest 2,000 overall. That covers an agent's mistake, not someone holding a token who sets out to flush it; database backups cover that, if you have them set up. There is no restore tool yet. Saves and reads are also recorded with other MCP tool calls for 30 days, so a note deleted by mistake, a secret included, stays there until then.

Any client with an MCP token can read, overwrite and delete notes, and the `you` notes reach every agent at connect. While [public access](macos-host.md#public-access) is on, that includes clients on the internet.
