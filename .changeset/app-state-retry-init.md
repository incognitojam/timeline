---
"timeline": patch
---

If preparing `app-state.db` fails when a process first opens it, for example because another writer held the lock too long during an upgrade, the next attempt opens a fresh connection and prepares it again, instead of running against a half-prepared database until the service restarts.
