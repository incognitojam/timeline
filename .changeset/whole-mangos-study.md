---
"timeline": patch
---

Avoid downloading Google Messages attachments again when a verified full-size copy is already stored. Missing or corrupt files are fetched and repaired, and thumbnails remain eligible for full-size upgrades.

When upgrading, rebuild and reinstall `timeline-gmessages` from `tools/timeline-gmessages` alongside Timeline. Older sidecar binaries do not support the new sync protocol.
