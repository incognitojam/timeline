---
"timeline": patch
---

`verify-event-people --force-rebuild` now stops before changing the people index when its check finds drift; `--rebuild` still rebuilds to repair it. The macOS host guide's rebuild runbook verifies once instead of twice, holding the service for about 31 minutes, gives the times and space measured on a 3.4-million-event database, and raises the free-space floor to 10 GB, which the rehearsal checks against the same figures.
