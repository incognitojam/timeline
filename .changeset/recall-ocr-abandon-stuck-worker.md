---
"timeline": patch
---

If a text recognition worker is still running after Timeline sends it KILL, Timeline stops waiting for it and tries a fresh worker on the next capture. If a second worker gets stuck too, captures are skipped until one of them exits.
