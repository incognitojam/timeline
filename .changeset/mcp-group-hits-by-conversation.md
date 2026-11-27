---
"timeline": minor
---

The MCP `query_events` and `semantic_search` tools take `group_by_conversation: true` to return one line per conversation (or per source and type for events outside one) instead of the events: its hit count, the dates of its first and last hit, and an event id to pass to `export_conversation`. A keyword search now shows every conversation it touches, rather than only those among the newest 50 hits. Calls without the option return what they did before.
