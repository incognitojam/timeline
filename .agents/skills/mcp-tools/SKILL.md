---
name: mcp-tools
description: "Checklist for Timeline's MCP tools. Use when editing src/mcp-tools.ts, src/mcp/, or any tool's name, description, arguments, annotations or replies."
---

# MCP tools checklist

What the MCP specification and the client makers agree on, and the client limits that change what an agent sees. Sources were read on 2026-11-27; check them again before relying on a number.

## Practices

- **One tool per task, with no overlap.** Before adding a tool, check whether an argument on an existing one would do. A tool's description says what it is for, when to use it, and how it differs from its neighbours. ([Anthropic, Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents); [OpenAI, Function calling](https://developers.openai.com/api/docs/guides/function-calling))
- **Arguments say what they take.** Use unambiguous names (`event_id`, not `id`), types, and enums where the set is small. Every tool's schema is paid for on every connection, so the [token budget test](../../../src/mcp-tools.tokens.test.ts) sets the limit. Raise it only by what a change needs, in the same diff.
- **Wrong input is an error the model can act on.** A date in the wrong format or a value out of range is a tool execution error (`isError: true`), not a protocol error, and not an empty result. Say what would work: the closest valid values, or the format with an example. ([MCP spec 2025-11-25, Tools: error handling](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling))
- **Replies are bounded and say when they stop.** Page, filter or truncate, with defaults that keep replies small. A reply that stops early says so and gives the arguments for the next part. Show names rather than opaque ids, and also give ids the model can pass back to another tool. ([Anthropic, Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents))
- **Errors tell nothing a tool would not.** Build suggestions from declared metadata, never from data a tool would leave out, such as a hidden contact.
- **Annotations are honest.** Every tool has a `title`, `readOnlyHint`, and `openWorldHint: false` (Timeline's tools reach only its own data). A tool that writes also sets `destructiveHint` (it can overwrite or delete) and `idempotentHint` (repeating a call changes nothing more). Clients use these to decide when to ask the user. A read-only token is not offered tools whose `readOnlyHint` is false. The one exception is `get_updates`, which keeps `readOnlyHint: true` while writing [checkpoints](../../../docs/user/mcp.md#checkpoints). ([Claude directory review criteria](https://claude.com/docs/connectors/building/review-criteria.md); [MCP blog, Tool annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/))
- **Server instructions cover only what spans tools.** They do not repeat tool descriptions, and may not reach the model at all. ([MCP blog, Server instructions](https://blog.modelcontextprotocol.io/posts/2025-11-03-using-server-instructions/))
- **Measure the change.** Call the tool through a real client on the seed database (`bun run seed`, then `bun run mcp`), and compare reply sizes and the `tools/list` size before and after.

## Client limits

- **claude.ai and Desktop** cut a tool result at about 150,000 characters and a call at 240 seconds. ([Building connectors](https://claude.com/docs/connectors/building.md#design-within-the-size-and-timeout-limits))
- **Claude Code** cuts a result at 25,000 tokens by default (`MAX_MCP_OUTPUT_TOKENS`) and warns above 10,000. It saves a text result over 50,000 characters to a file unless the tool sets `_meta["anthropic/maxResultSizeChars"]`. ([Claude Code MCP](https://code.claude.com/docs/en/mcp))
- **Claude Code tool search** defers MCP tools by default. With `ENABLE_TOOL_SEARCH=auto` they load upfront while their definitions stay under 10% of the context window. Server instructions, and the description of a tool that loads upfront, are cut at 4,096 characters. ([Claude Code MCP](https://code.claude.com/docs/en/mcp))
- **Tool names** are at most 64 characters for the Claude directory. The spec allows 1–128 characters of `A-Z a-z 0-9 _ - .`. ([Review criteria](https://claude.com/docs/connectors/building/review-criteria.md); [MCP spec 2025-11-25, Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools))
- **claude.ai connects from Anthropic's cloud**, so the server must be public, on port 443. ([Custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp))
