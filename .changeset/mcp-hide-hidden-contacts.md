---
"timeline": minor
---

Contacts marked hidden are now left out of Timeline's MCP tools, as they are on the web app's timeline pages. `list_contacts` no longer lists them. Keyword search, date browsing, `get_context`, `semantic_search` (with any conversation window that holds one of their messages) and conversation grouping leave out the events filed under a hidden contact: a DM with them disappears, and a group chat keeps everyone else's messages. Memory notes linked to a hidden contact are left out of `list_memory` and the connect-time memory index. `run_sql` still reads every row, and `search_mcp_tool_calls` replays earlier results.
