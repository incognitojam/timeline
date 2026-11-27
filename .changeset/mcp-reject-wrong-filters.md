---
"timeline": patch
---

The MCP tools answer an unknown source or event type with an error listing the valid ones (`Unknown type "listen:trak" for spotify. Its types: listen:track, …`), and a date in the wrong format with the expected format, instead of "No events found.". `query_events` with no matches restates the filters it applied, and "not found" replies for a contact or memory note say where to look next. Date bounds may carry a UTC offset, `query_events` with a `date` takes a comma-separated `source` or `type` like its other searches, and a declared wildcard type such as `activity:*` matches its events.
