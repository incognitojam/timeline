---
"timeline": minor
---

With the Discord DM pass turned on, `get_updates` now brings DMs up to date before answering a broad catch-up: when the last pass is over a minute old it asks for one and waits a few seconds, so the reply includes messages from the last minute. When the pass is backing off or does not finish in time, the reply answers from what is stored and says when Discord DMs last synced.
