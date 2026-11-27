---
"timeline": patch
---

The menu bar app now checks from the internet side that public access really answers. After Funnel comes on, Remote Access reads "public until …, checking…" until a request through Tailscale's public address gets an answer, then "public until …". If it never answers within 15 minutes, the menu says it is not confirmed reachable, why, and offers Check Again.
