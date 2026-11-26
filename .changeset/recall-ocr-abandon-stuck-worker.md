---
"timeline": patch
---

Screen recall no longer stops for good when a text recognition worker cannot be ended. Timeline now gives up waiting after a few seconds, logs that it abandoned the worker, and starts a fresh one for the next capture.
