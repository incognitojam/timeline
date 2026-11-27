/**
 * MCP Server - Stdio Transport
 *
 * Run with: bun run mcp
 * Used by Claude Code and other MCP clients that spawn a subprocess.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config";
import { getAppStateDb } from "./db/app-state";
import { getDb, initDb } from "./db/schema";
import { wrapDatabase } from "./db/pool";
import { openVectorSearchDb } from "./embeddings/db";
import { openOnFirstUse } from "./embeddings/search";
import { configureBunSqliteForSqliteVec } from "./embeddings/sqlite-vec";
import {
  recordInvalidToolCallsFromTransport,
  type InvalidToolCallRecorder,
  recordMcpToolCall,
  upsertMcpSession,
  type RecordToolCallInput,
} from "./mcp/recording";
import { mcpInstructions, registerTools } from "./mcp-tools";
import { PRODUCT_VERSION } from "./product-version";

// The semantic_search tool loads sqlite-vec into embeddings.db, which requires
// selecting a sqlite-vec-capable SQLite library before any bun:sqlite database
// is opened in this process. Do it before getDb(). No-op unless
// TIMELINE_SQLITE_LIBRARY_PATH is set, so hosts without embeddings are unaffected.
configureBunSqliteForSqliteVec();

const db = getDb();
initDb(db);

// Resolve public URL from config + env override; used to explain clickable
// /event/<id> links in the server instructions.
const config = await loadConfig();

// stdio clients start a process per connection, so this is read at connect time.
const server = new McpServer(
  { name: "timeline", version: PRODUCT_VERSION },
  { instructions: mcpInstructions(getAppStateDb(), { publicUrl: config.server.public_url }) },
);
const sessionId = `stdio:${process.pid}:${Date.now()}`;
let invalidRecorder: InvalidToolCallRecorder | undefined;

function ensureStdioSession(): string {
  const client = server.server.getClientVersion();
  upsertMcpSession({
    id: sessionId,
    transport: "stdio",
    clientName: client?.name ?? null,
    clientVersion: client?.version ?? null,
    tokenHash: null,
  });
  return sessionId;
}

function persistToolCall(rec: Omit<RecordToolCallInput, "sessionId"> & {
  sessionId?: string;
  requestId?: RequestId;
}): void {
  try {
    const recordedSessionId = ensureStdioSession();
    recordMcpToolCall({
      sessionId: recordedSessionId,
      toolName: rec.toolName,
      args: rec.args,
      resultText: rec.resultText,
      isError: rec.isError,
      durationMs: rec.durationMs,
    });
  } finally {
    if (rec.requestId !== undefined) invalidRecorder?.markHandled(rec.requestId);
  }
}

// Register all tools from shared module.
registerTools(server, wrapDatabase(db), {
  // A single stdio client searches one query at a time, so it reads the index directly.
  semanticSearch: config.embeddings && {
    config: config.embeddings,
    embeddingsDb: openOnFirstUse(async () => wrapDatabase(openVectorSearchDb())),
  },
  recordToolCall: persistToolCall,
  defaultSessionId: ensureStdioSession,
});

// Start the server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  invalidRecorder = recordInvalidToolCallsFromTransport(transport, {
    sessionId: () => sessionId,
    recordToolCall: persistToolCall,
  });
  console.error("Timeline MCP server running");
}

main().catch(console.error);
