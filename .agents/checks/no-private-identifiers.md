---
name: no-private-identifiers
description: Checks diffs for secrets, private infrastructure identifiers, personal data, and machine-local details that should not be committed.
severity-default: high
tools: [Bash, Read, Grep]
---

Review the diff for committed secrets or private/personal identifiers. Do not flag variable names alone, placeholder values, `example.com`, `localhost`, `127.0.0.1`, or intentionally generic service names such as `timeline`.

Look for:

- Secrets or credentials: API keys, bearer tokens, passwords, cookies, private keys, session tokens, OAuth secrets, or filled-in values for env vars such as `AUTH_PASSWORD`, `MCP_TOKENS`, or API key settings.
- Private infrastructure identifiers: personal tailnet names, private `*.ts.net` hostnames, non-public machine names, internal hostnames, private NAS/share names, or VPN-only URLs in code/docs/tests unless clearly anonymized or already part of documented project deployment architecture.
- Real personal data in tests/docs: real names, personal email addresses, phone numbers, precise home/work locations, or chat/message content from real people. Prefer Alice/Bob, `example.com`, and placeholder locations.
- Machine-local paths that would reveal a user's environment or break for others, unless they are in ignored local config or explicitly documented as examples with placeholders.
- PR/docs examples that expose a deploy target more specific than necessary. Prefer generic examples such as `https://timeline` when that is sufficient.

If a real secret is present, report it as critical and recommend removal plus rotation. If only a private hostname or personal identifier is present, recommend replacing it with a generic placeholder and checking commit history before publishing.
