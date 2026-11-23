# MCP server

Timeline exposes its data to AI assistants over the [Model Context Protocol](https://modelcontextprotocol.io). Tools include `query_events`, `get_context`, `get_summary`, `export_conversation`, `list_contacts`, `get_contact_info`, `run_sql`, and `semantic_search` (which needs [embeddings](embeddings.md)).

## Local (stdio)

From a checkout, `bun run mcp` serves the tools over stdio against `./timeline.db`, or the database named by `TIMELINE_DB_PATH`. The repository's `.mcp.json` registers it for Claude Code; other clients can run the same command.

## Remote (HTTP)

The service serves MCP over Streamable HTTP when `MCP_TOKENS` is set in `~/.config/timeline/env` to a comma-separated list of tokens. Clients connect to `/mcp` with an `Authorization: Bearer <token>` header, or to `/mcp/<token>` for clients that can only take a URL.

To reach it from your other devices, use [Remote Access](macos-host.md#remote-access-tailnet-only), which serves it to your tailnet. Hosted clients such as Claude.ai custom connectors connect from the internet, so they can reach it only while [public access](macos-host.md#public-access) is on.

With Tailscale v1.72.0 or later in HTTP reverse-proxy mode, only MCP is available through Funnel. TCP forwarding and older proxies can expose the full service because they omit the marker. The web app, API, and status pages return a plain 403. Keep the service on loopback and use Tailscale's HTTP reverse proxy. It clears client-supplied Funnel headers and sets `Tailscale-Funnel-Request: ?1` from connection metadata on public requests, so a proxied client cannot forge or remove the marker. A direct caller controls its own headers. See [Tailscale's proxy implementation](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go).

Each configured token permits 600 public requests per rolling hour across both authentication forms. Ten missing or invalid credentials within 15 minutes lock requests from that public source IP out for 15 minutes, including valid clients sharing the address. Tailscale supplies the source via `X-Forwarded-For`. A 429 response includes `Retry-After` in seconds. Restarting the service clears both limits. Localhost and tailnet requests without the marker bypass them.
