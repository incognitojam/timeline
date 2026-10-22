---
"timeline": minor
---

Import Claude Code and Codex sessions from another machine with the new **Remote agents** sync source. Timeline generates its own SSH key from the source's settings page, shows the `authorized_keys` line to install on the remote machine alongside the read-only `tools/timeline-export` wrapper, and asks you to confirm the host key fingerprint on **Test connection**. Imported sessions use the account you set (for example `alice@laptop`), so they stay separate from the Timeline host's own. A remote machine that is asleep or offline is recorded as a deferred run until its last successful pull is older than the configured limit (24 hours by default), after which the run fails.
