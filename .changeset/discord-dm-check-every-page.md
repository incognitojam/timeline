---
"timeline": patch
---

The Discord DM pass now checks every full page of 100 messages, not only a DM's first, before storing it, so a page that skips ahead of the stored messages fails the pass instead of losing the messages in between. This costs one extra request for each full page.
