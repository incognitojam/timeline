---
"timeline": patch
---

MCP replies stay under 40,000 characters, small enough for claude.ai and Claude Code to pass them to the model whole. When the size stops a list of events, rows, contacts, recorded calls or a transcript early, the reply ends with what it showed and how to read on: the next page's cursor or offset, or for a transcript the cursor or `event_id` to pass (`export_conversation` now takes a `cursor`). `query_events` and `get_context` take a `limit` of at most 500; a larger one is an error that names the maximum.
