---
"timeline": patch
---

Skip the full media eviction inventory when a fresh filesystem size check shows the cache is below its limit, so idle maintenance releases other sync jobs sooner.

Scheduled runs record an estimated cache size when skipping inventory; exact cache and evictable totals are recorded only on full runs. They run the full inventory at least on the first scheduled run after six hours to catch filesystem accounting differences.
