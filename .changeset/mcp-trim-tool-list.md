---
"timeline": minor
---

Timeline's MCP server offers 13 tools instead of 17, and its tool list is 23% smaller (17,494 to 13,450 characters measured, with the rest of this release's MCP changes). `get_summary` is gone: `query_events` with `group_by_conversation`, `get_schema` and `run_sql` cover what it showed. `list_mcp_sessions` and `get_mcp_session` are now part of `search_mcp_tool_calls`: pass `sessions: true` to list sessions, or `session_id: "current"` (or a session id) for one session's details and calls; an unknown id is an error. `remember_contact_fact` is gone: save a fact about a person with `save_memory_note` and its `contact` parameter. `get_contact_info` lists the memory notes linked to a contact, and still shows the facts saved on the contact before, which are kept as they were.
