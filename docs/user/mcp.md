# MCP server

Timeline exposes its data to AI assistants over the [Model Context Protocol](https://modelcontextprotocol.io). Tools include `get_updates` (what was added since the agent last checked: new messages by conversation, daily health lines and counts of everything else), `query_events`, `get_context`, `get_schema`, `export_conversation`, `list_contacts`, `get_contact_info`, `run_sql`, and `semantic_search` (which needs [embeddings](embeddings.md)), plus the shared [memory](#memory) tools.

Hiding a contact keeps them out of your day-to-day view, not away from agents. The tools leave hidden contacts out of what an agent is shown without asking, as on the web app's timeline pages: catch-ups, searches and lists leave out a DM with a hidden contact and, in a group chat, their own messages, and `list_contacts` says how many contacts it left out. What a visible message says, quotes or forwards is shown as it is, with real names. Once a hidden contact is named, by name, id or identifier, or one of their events or one conversation is opened by id, the tools include them like anyone else, and `get_contact_info` says they are hidden. A conversation opened with `export_conversation`, `get_context`'s `same_conversation` or `get_updates`' `conversation_id` shows everyone's messages. Memory notes linked to a hidden contact are likewise left out of `list_memory` and the memory an agent is given when it connects, which say how many; they can be read, saved and deleted by name, and `get_contact_info` lists them. `run_sql` reads every row, and `search_mcp_tool_calls` replays what earlier calls returned, hidden contacts included.

## Local (stdio)

From a checkout, `bun run mcp` serves the tools over stdio against `./timeline.db`, or the database named by `TIMELINE_DB_PATH`. The repository's `.mcp.json` registers it for Claude Code; other clients can run the same command.

## Remote (HTTP)

The service serves MCP over Streamable HTTP at `/mcp` while at least one MCP token exists. Create tokens on the **MCP sessions** page of the web app (under **More**), or on the service host; either way the token is shown once. Timeline keeps only a hash of it, enough to check it but not to show it again:

```sh
timeline-service mcp-token create --label claude-ai --read-only
timeline-service mcp-token list
timeline-service mcp-token revoke claude-ai
```

- `--read-only`: the client is not offered the tools that change anything (`save_memory_note`, `delete_memory_note`), and a call to one is refused. Read-only means it cannot change your data or notes; [checkpoints](#checkpoints) are the exception. Its calls are still recorded with their arguments, like every client's, and other agents can read them with `search_mcp_tool_calls`, so treat what a read-only client sends as untrusted text. Every tool declares whether it writes, so a new writing tool is never offered to a read-only token by mistake. The connect-time instructions tell the agent it cannot save.
- `--tailnet-only`: the token is refused over Funnel ([public access](macos-host.md#public-access)), with the same answer as an unknown token; it works from the Mac and the tailnet.

A token's flags are fixed when it is created; to change them, create a new token and revoke the old one. The page and `list` show each token's label, flags, creation time, when it was last used and the last client name it connected with, never the token; the page also counts the `MCP_TOKENS` values without showing them. Revoke from the page, or with `revoke` and the label or the id from `list`; revoking takes effect on the next request, including requests in sessions the token already opened. The MCP sessions page shows the label of the token each session used.

Clients send the token in an `Authorization: Bearer <token>` header to `https://<node>.ts.net/mcp`. Prefer the header to putting the token in the URL as `/mcp/<token>`: clients show, store and log the URLs of their servers, so a token in the URL is easily copied into a screenshot or a log. Use the path form only for a client that cannot send a header.

To add Timeline to claude.ai, turn on [public access](macos-host.md#public-access), then open **Customize → Connectors**, choose **+ Add → Add custom connector** (on a Team or Enterprise plan an owner adds it under **Organization settings → Connectors**), give it a name and enter `https://<node>.ts.net/mcp` as the URL; its check of the server answers 401 and carries on. Under **Authentication** choose **No sign-in**, even though **Sign in now** is tagged **Detected** (Timeline's 401 advertises `Bearer`, which claude.ai reads as OAuth), and expect the warning that follows. Under **Request headers** press **+ Add header**, pick `authorization` as the **Header name**, enter `Bearer <token>` as the **Value** and leave **Required** ticked. Leave **Advanced** on **Streamable HTTP** and press **Add**. claude.ai stores the header and does not show it again. Give it a token without `--tailnet-only`, and `--read-only` unless it should save memory notes. Creating a token on the MCP sessions page shows these steps with the URL and the header value ready to copy, and whether public access is on, as the menu bar app records it; for a tailnet-only token it shows the steps for a tailnet client instead. **Connect a client** on the page shows the same steps later, without the token.

If claude.ai reports that it couldn't reach the server:

- Check that public access is on and has not ended: a timed share ends by itself, and the connector stops working until it is turned on again. Tailscale notes that [public DNS records can take up to 10 minutes](https://tailscale.com/kb/1223/funnel#dns-propagation) to appear, so a first attempt soon after turning Funnel on can fail.
- Look for `mcp.refused` lines with `"funnel":true` in `service.log` from the time of the attempt. A request that reaches the service over Funnel and is refused before a session is logged, up to 60 a minute, so a line there shows claude.ai got through, and its `status` and `authorization` fields say why it was refused: `401` with `bearer` means the token is wrong, revoked or tailnet only. Without a token, `/mcp` answers `401` with `WWW-Authenticate: Bearer`, and `/.well-known/` paths `404`; while no token exists at all, `/mcp` answers `503` and nothing is logged.

`MCP_TOKENS` in `~/.config/timeline/env`, a comma-separated list of tokens, is the older way to allow clients. It still works, and its tokens have full access, but they have no label, no record of use, and removing one means editing the file and restarting the service.

To reach it from your other devices, use [Remote Access](macos-host.md#remote-access-tailnet-only), which serves it to your tailnet. Hosted clients such as claude.ai custom connectors connect from their maker's cloud, not from your device, and claude.ai only to a public server on port 443, so they can reach it only while [public access](macos-host.md#public-access) is on; Funnel serves it on 443.

With Tailscale v1.72.0 or later in HTTP reverse-proxy mode, only MCP is available through Funnel. TCP forwarding and older proxies can expose the full service because they omit the marker. The web app, API, and status pages return a plain 403, and OAuth discovery paths under `/.well-known/` a 404, which tells clients the server has no OAuth sign-in. Keep the service on loopback and use Tailscale's HTTP reverse proxy. It clears client-supplied Funnel headers and sets `Tailscale-Funnel-Request: ?1` from connection metadata on public requests, so a proxied client cannot forge or remove the marker. A direct caller controls its own headers. See [Tailscale's proxy implementation](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go).

Each token permits 600 public requests per rolling hour across both authentication forms. Ten wrong tokens within 15 minutes lock requests from that public source IP out for 15 minutes, including valid clients sharing the address. A request with no token is answered `401` with `WWW-Authenticate: Bearer` and does not count, since hosted clients check a server without credentials before connecting. Tailscale supplies the source via `X-Forwarded-For`. A 429 response includes `Retry-After` in seconds. Restarting the service clears both limits. Localhost and tailnet requests without the marker bypass them.

Each MCP request refused before it reaches a session (401, 403, 429, and 404 on discovery paths) adds an `mcp.refused` line to `service.log`: the method, the kind of path (`mcp`, `mcp-path-token`, `well-known` or `other`, never the path itself), the status, whether it came over Funnel, whether an `Authorization` header was sent and whether it was `Bearer`, the first 80 characters of the User-Agent, the `MCP-Protocol-Version` header, and a short hash of the source address that changes when the service restarts. It never holds the token, the `Authorization` value, any other header or the request body. At most 60 such lines are written a minute; past that, the next minute's first refused request adds an `mcp.refused.suppressed` line with the number dropped.

## Checkpoints

`get_updates` can keep an agent's place under a name: put a line such as "Catch me up with `get_updates` and checkpoint `morning-brief`" in the agent's standing instructions, and each catch-up starts where that name last finished. Names are shared by every token, so give each agent its own; two agents on one name see each other's catch-ups as already read. A checkpoint moves on the last page of a catch-up with no `sources` or `conversation_id`, and only when the catch-up started at or before it. Read-only connections, such as a claude.ai connector made with `--read-only`, create and move checkpoints like any other, since a checkpoint is a bookmark, not your data; so a read-only client can move any checkpoint it names, another agent's included. A reply from a checkpoint lists where its last three moves started, so an agent can catch up again from before a move it didn't make. A checkpoint no call has used for 90 days is deleted the next time any checkpoint is created or moved.

## Memory

Timeline keeps one memory that every connected agent shares, whichever harness or machine it runs on. Agents write it during a turn, as they learn facts, preferences and corrections.

A note has a name (a lowercase slug such as `coffee-order`), a title, a one-line summary, Markdown details and a kind: `you` (preferences and profile), `topic`, `area`, `person` or `project` (about the project itself, such as an `overview`). A person note can link a Timeline contact; `get_contact_info` then lists it beside the facts saved on the contact. Details can mention another note as `[[name]]`; the link is kept as written, and the note it names need not exist yet.

A note belongs to the account or to one project. A project is named by the key the agent passes, normally the repository name, normalised to a slug such as `my-app`. Names are unique within a scope, so the account and each project can each have their own `bob`.

- `list_memory` returns the index: each note's name, title, summary and update date, by kind. With a project, the project's notes come first, then the account's.
- `get_memory_note` reads one note in full.
- `save_memory_note` creates a note, or updates the note of that name in that scope, replacing only the fields given.
- `delete_memory_note` deletes a note.

When a client connects, the server's instructions tell the agent about the memory and include the `you` notes in full and the account index, up to about 12,000 characters. Past that the agent gets the index alone and fetches the rest with the tools. A note's details can be up to 16,000 characters, so a long `you` note is named in the instructions rather than included.

Memory lives in `app-state.db` and holds at most 500 notes. Each update or delete keeps the note's previous version in the same table: the last 10 versions of each note, and the newest 2,000 overall. That covers an agent's mistake, not someone holding a token who sets out to flush it; database backups cover that, if you have them set up. Saves and reads are also recorded with other MCP tool calls for 30 days, so a note deleted by mistake, a secret included, stays there until then.

The **Memory** page in the web app (under **More**) lists the account's notes by kind, then each project's notes, overview first. A note's page shows its details with `[[name]]` linking to the note of that name in the same project, else in the account, and lets you edit its title, kind, summary and details, or delete it. Its previous versions are listed below it to view or restore; restoring keeps the version it replaces, like any other update. Notes whose latest version is a deletion appear under **Recently deleted**, where you can restore them.

Each project on the page has a **Use account memory** switch, on by default. Turned off, `list_memory` with that project lists only the project's own notes. It changes nothing else: the connect-time instructions are the same for every project and still include the account's `you` notes and index, and agents can still read account notes by name.

Any client with an MCP token that is not read-only can overwrite and delete notes, and any client can read them, and the `you` notes reach every agent at connect. While [public access](macos-host.md#public-access) is on, that includes clients on the internet.

### Importing claude.ai's memory

**Import from Claude** on the Memory page brings in the memory claude.ai has built up. In claude.ai, open **Settings → Your Claude → Memory** and choose **Export memory**; it downloads `claude-memory-<date>.zip`, your memory as Markdown files, and that is the file to choose. The full data export (**Settings → Privacy → Export data**) works too: of the files it gives you, upload `memories-000.zip`, or the JSON file inside it. The page first shows what the import would add, per kind and project, which notes are already in memory and which files it cannot import and why. Nothing is written until you press **Import**, which adds all of those notes in one go or none. If memory changed after the preview so that the import would add something else, Import refuses and you choose the file again.

Each memory file becomes a note: `preferences` and `profile` are `you` notes, and files under `topics`, `areas` and `people` keep that kind. Each claude.ai project becomes a project keyed by the title in its `index.md` as a slug (`Garden Planner` → `garden-planner`); its files keep their folder's kind, files directly in the project are `project` notes, and the project's title and description become its `overview` unless it has an overview file of its own. The note's name is the file's name, its title is that name title-cased as claude.ai shows it, its summary the file's description, and its details the file's text with its `[[name]]` links. Notes from `claude-memory-<date>.zip` are dated by the export's date, since it carries no time per file; the data export dates each file by when claude.ai last updated it. A person note is linked to a contact only when its title or aliases are, ignoring case, the name of exactly one contact; the preview lists each link.

An import never changes or deletes a note: a note whose name already exists in its scope is left as it is, so running the same import again adds nothing. It is refused if it would take memory past its 500 notes. claude.ai's older prose summaries in the same file, the account summary and one per project, are not imported.
