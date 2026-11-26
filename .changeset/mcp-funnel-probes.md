---
"timeline": patch
---

The MCP endpoint answers a request without credentials with a `WWW-Authenticate: Bearer` challenge, and such requests no longer count toward the lockout for wrong tokens over public access, so a hosted client's credential-less checks cannot lock its address out. Over public access, OAuth discovery requests under `/.well-known/` get `404 Not Found` instead of `403`. Each refused MCP request is logged to `service.log` (path kind, status, whether an `Authorization` header was sent, a shortened User-Agent), never the token or the full source address.
