---
"timeline": patch
---

Stop the image description job failing every run while the machine serving its model is offline. When the provider answers but no longer lists the model, scheduled runs are now skipped with a reason on the sync page and resume when the model is listed again. A manual run still fails, and says the model is not listed instead of claiming it is not vision-capable.
