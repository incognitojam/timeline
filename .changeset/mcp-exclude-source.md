---
"timeline": minor
---

The MCP `query_events` tool takes `exclude_source`, as `get_context` does. A keyword search with no `source`, `contact` or `exclude_source` now leaves out AI-assistant sessions and screen recall, the sources the web search already leaves out by default, and its first line names them; pass `exclude_source: ""` to search them too.
