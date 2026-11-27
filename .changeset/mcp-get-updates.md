---
"timeline": minor
---

Add a `get_updates` MCP tool for catching an agent up in one call: messages added since its last check, grouped by conversation, one line a day of sleep, resting heart rate, HRV and other health records for the last two weeks on a broad check, and a count per source of other new events. Each conversation is headed with the id to pass back, and the last page ends with the checkpoint to pass next time, which also picks up old messages imported late.
