---
"timeline": minor
---

The MCP `query_events` and `get_context` tools now start their results with a line saying how many events are shown, which end of the matches they are (oldest or newest first), and, when more match, the `cursor` to pass for the next page. For a contact, it also gives the total number of matching events (counted up to 10,000), replacing the old "Events found" line, which only counted the page.
