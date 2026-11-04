---
"timeline": patch
---

Re-importing, renaming or archiving a long conversation no longer stalls syncs for minutes. Updates that leave a conversation's title, timing and membership unchanged, such as raw-data refreshes, skip the conversation list entirely, and renaming or deleting every message of a conversation now takes time proportional to its size instead of its size squared.
