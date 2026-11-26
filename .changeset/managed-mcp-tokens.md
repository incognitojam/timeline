---
"timeline": minor
---

MCP tokens can be managed with `timeline-service mcp-token create --label <label> [--read-only] [--tailnet-only]`, `list` and `revoke <id or label>`, without editing the env file or restarting. A read-only token's sessions are not offered the tools that change anything, and a tailnet-only token is refused over public access. Revoking a token stops it on its next request, including in sessions it already opened. `list` and the MCP sessions page show which token was used and by which client. Tokens in `MCP_TOKENS` keep working with full access.
