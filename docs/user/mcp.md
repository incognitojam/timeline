# MCP server

Timeline exposes its data to AI assistants over the [Model Context Protocol](https://modelcontextprotocol.io). Tools include `query_events`, `get_context`, `get_summary`, `export_conversation`, `list_contacts`, `get_contact_info`, `run_sql`, and `semantic_search` (which needs [embeddings](embeddings.md)).

## Local (stdio)

From a checkout, `bun run mcp` serves the tools over stdio against `./timeline.db`, or the database named by `TIMELINE_DB_PATH`. The repository's `.mcp.json` registers it for Claude Code; other clients can run the same command.

## Remote (HTTP)

The service serves MCP over Streamable HTTP when `MCP_TOKENS` is set in `~/.config/timeline/env` to a comma-separated list of tokens. Clients connect to `/mcp` with an `Authorization: Bearer <token>` header, or to `/mcp/<token>` for clients that can only take a URL.

To reach it from hosted clients such as Claude.ai custom connectors, expose the service with [Tailscale Funnel](macos-host.md#remote-access-tailscale-funnel).
