---
"timeline": patch
---

T3 Code sync no longer holds the database write lock for a whole run. It compares rows without the lock, so a sync with nothing new takes no write lock, and writes what changed in short transactions, so other sources and writers keep working during a long rename, archive or first import. A run that fails partway is finished by the next one.
