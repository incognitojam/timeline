---
"timeline": patch
---

Rebuilding the people index (`verify-event-people --force-rebuild`) is much faster for large group chats and reuses the old index's space instead of growing the database file. The verifier now names the database, event count and SQLite version and library it uses, refuses a SQLite older than 3.38 and a rebuild of a missing or empty database, and exits 2 for a rebuild that rolled back and 3 for one that committed but did not verify. The macOS host guide has a runbook for the rebuild and a rehearsal script that runs it on a copy first.
