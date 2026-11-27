---
"timeline": patch
---

Public access in the menu bar app now survives an app update. Funnel goes off while the update installs; the reopened app shows "Public access resumes after the update" with Stop Public Access, then "making public…" and "public until" with the same end time. It resumes only within 5 minutes of the update's quit, before the end time, and if neither the Mac nor `tailscaled` restarted in between. Quitting Timeline yourself still ends it, and after a crash or force-quit Timeline now starts tailnet only instead of resuming an unexpired share.
