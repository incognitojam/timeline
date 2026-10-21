import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb, initDb } from "./db/schema";
import { wrapDatabase } from "./db/pool";
import { countTokens } from "./export/tokens";
import { registerTools } from "./mcp-tools";

/**
 * Every MCP client injects the full tools/list payload (name + description +
 * JSON Schema per tool) into the model's context at connect, so this JSON is
 * a per-session context tax on eager-loading clients. The budget makes that
 * cost visible: adding or fattening a tool that pushes past it should raise
 * the constant in the same diff, deliberately. Measured with cl100k_base as
 * an estimate — Claude's tokenizer differs by roughly ±15%.
 *
 * Registration is unconditional for all tools (feature gates are call-time),
 * so the payload is deterministic.
 */
const TOOL_SCHEMA_TOKEN_BUDGET = 3200;

describe("MCP tool schema context cost", () => {
  test(`tools/list payload stays within ${TOOL_SCHEMA_TOKEN_BUDGET} tokens`, async () => {
    const db = getDb();
    initDb(db);
    const server = new McpServer({ name: "timeline", version: "0.0.0" });
    registerTools(server, wrapDatabase(db));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "measure", version: "0.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const perTool = tools
      .map((tool) => ({ name: tool.name, tokens: countTokens(JSON.stringify(tool)) }))
      .sort((a, b) => b.tokens - a.tokens);
    const total = perTool.reduce((sum, t) => sum + t.tokens, 0);

    const table = perTool.map((t) => `  ${t.name}: ${t.tokens}`).join("\n");
    expect(
      total,
      `tools/list payload is ${total} tokens (budget ${TOOL_SCHEMA_TOKEN_BUDGET}). Per tool:\n${table}\nTrim descriptions/schemas, or raise TOOL_SCHEMA_TOKEN_BUDGET in this diff if the growth is deliberate.`,
    ).toBeLessThanOrEqual(TOOL_SCHEMA_TOKEN_BUDGET);

    await client.close();
    await server.close();
  });
});
