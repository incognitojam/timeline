---
"timeline": patch
---

The Settings page's update check now queries GitHub releases without credentials. Previously it sent the GitHub sync token, so an expired token made the check fail with "GitHub denied the release check" even though the releases are public.
