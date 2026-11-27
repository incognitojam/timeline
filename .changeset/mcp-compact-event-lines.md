---
"timeline": minor
---

MCP `query_events`, `get_context` and `semantic_search` list events in a more compact form, like a conversation export: a `## <day>` line, a `[source/type]` line (or `[source] <conversation>` for messages) for each run of events that share it, then one `HH:MM #<id> …` line per event, in UTC. Times no longer show seconds, offset timestamps are converted to UTC, Spotify listens no longer repeat the track name, texts and calls show their direction (`sms:sent`, `call:missed`), and previews stay on one line. Results are 25–40% smaller for day and contact queries.
