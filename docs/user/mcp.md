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

When a client connects, the server's instructions tell the agent about the memory and include the `you` notes in full and the account index, up to about 12,000 characters. Past that the agent gets the index alone and fetches the rest with the tools. A note's details can be up to 16,000 characters, so a long `you` note is named in the instructions rather than included.

Memory lives in `app-state.db` and holds at most 500 notes. Each update or delete keeps the note's previous version in the same table: the last 10 versions of each note, and the newest 2,000 overall. That covers an agent's mistake, not someone holding a token who sets out to flush it; database backups cover that, if you have them set up. Saves and reads are also recorded with other MCP tool calls for 30 days, so a note deleted by mistake, a secret included, stays there until then.

The **Memory** page in the web app (under **More**) lists the account's notes by kind, then each project's notes, overview first. A note's page shows its details with `[[name]]` linking to the note of that name in the same project, else in the account, and lets you edit its title, kind, summary and details, or delete it. Its previous versions are listed below it to view or restore; restoring keeps the version it replaces, like any other update. Notes whose latest version is a deletion appear under **Recently deleted**, where you can restore them.

Each project on the page has a **Use account memory** switch, on by default. Turned off, `list_memory` with that project lists only the project's own notes. It changes nothing else: the connect-time instructions are the same for every project and still include the account's `you` notes and index, and agents can still read account notes by name.

Any client with an MCP token can read, overwrite and delete notes, and the `you` notes reach every agent at connect. While [public access](macos-host.md#public-access) is on, that includes clients on the internet.

### Importing claude.ai's memory

**Import from Claude** on the Memory page brings in the memory claude.ai has built up. Request the export in claude.ai under **Settings → Privacy → Export data**. Of the files it gives you, upload `memories-000.zip`, or the JSON file inside it. The page first shows what the import would add, per kind and project, which notes are already in memory and which files it cannot import and why. Nothing is written until you press **Import**, which adds all of those notes in one go or none. If memory changed after the preview so that the import would add something else, Import refuses and you choose the file again.

Each memory file becomes a note: `preferences` and `profile` are `you` notes, and files under `topics`, `areas` and `people` keep that kind. Each claude.ai project becomes a project keyed by its title as a slug (`Garden Planner` → `garden-planner`); its files keep their folder's kind, files directly in the project are `project` notes, and the project's title and description become its `overview` unless it has an overview file of its own. The note's name is the file's name, its title is that name title-cased as claude.ai shows it, its summary the file's description, and its details the file's text with its `[[name]]` links. A person note is linked to a contact only when its title or aliases are, ignoring case, the name of exactly one contact; the preview lists each link.

An import never changes or deletes a note: a note whose name already exists in its scope is left as it is, so running the same import again adds nothing. It is refused if it would take memory past its 500 notes. claude.ai's older prose summaries in the same file, the account summary and one per project, are not imported.
