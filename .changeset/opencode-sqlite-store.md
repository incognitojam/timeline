---
"timeline": minor
---

OpenCode imports now read OpenCode's `opencode.db` database, so sessions from OpenCode 1.2 onward, including OpenCode 2, appear in Timeline alongside those from the older JSON `storage/` folder, each message once. Point the OpenCode source at OpenCode's data directory (usually `~/.local/share/opencode`); a `storage/` folder or an `opencode.db` file on its own still works. Reasoning and failed tool calls now appear in imported OpenCode turns.
