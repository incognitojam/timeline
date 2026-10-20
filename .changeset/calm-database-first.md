---
"timeline": patch
---

The service now prepares its database before syncing starts. Previously, when a derived table such as conversation summaries needed rebuilding (a fresh install, a restored backup, or a copied database), a sync could collide with the rebuild, so the service failed with "database is locked" and kept restarting. Startup logs how long database preparation took.
