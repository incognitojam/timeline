import { useNavigate } from "@solidjs/router";
import { For, Show } from "solid-js";
import type { McpSessionSummary } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { formatAbsoluteTime, timestampToBrowserIso, transportClass } from "../lib/mcp-format";
import { useMcpSessions } from "../lib/queries";
import { MCP_SESSION_LIMIT } from "../lib/query-params";
import { buildMcpSessionUrl } from "../lib/routes";

function clientLabel(session: McpSessionSummary): string {
  const name = session.client_name ?? "Unknown client";
  return session.client_version ? `${name} ${session.client_version}` : name;
}

function tokenLabel(session: McpSessionSummary): string {
  return session.token_hash ? session.token_hash : "stdio";
}

export default function McpSessionsView() {
  const navigate = useNavigate();
  const query = useMcpSessions(() => ({ limit: MCP_SESSION_LIMIT, offset: 0 }));
  const sessions = () => query.data?.sessions ?? [];

  function openSession(session: McpSessionSummary) {
    navigate(buildMcpSessionUrl(session.id));
  }

  function handleRowKeyDown(event: KeyboardEvent, session: McpSessionSummary) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openSession(session);
  }

  return (
    <div class="h-full overflow-auto">
      <div class="max-w-6xl mx-auto px-4 py-6">
        <div class="mb-6">
          <h1 class="font-display text-2xl font-medium">MCP</h1>
          <p class="text-sm text-muted-foreground mt-1">
            Tool calls grouped by MCP client session.
          </p>
        </div>

        <Show when={query.isError}>
          <div class="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300 mb-4">
            Failed to load MCP sessions.
          </div>
        </Show>

        <Show
          when={sessions().length > 0}
          fallback={
            <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
              No MCP sessions recorded yet. Calls from HTTP and stdio MCP clients will appear here after an agent invokes a tool.
            </div>
          }
        >
          <div class="rounded-lg border border-border overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border bg-muted/50">
                  <th class="text-left px-3 py-2 font-medium">Client</th>
                  <th class="text-left px-3 py-2 font-medium">Transport</th>
                  <th class="text-left px-3 py-2 font-medium">Token</th>
                  <th class="text-right px-3 py-2 font-medium">Calls</th>
                  <th class="text-right px-3 py-2 font-medium">Errors</th>
                  <th class="text-left px-3 py-2 font-medium">Last activity</th>
                </tr>
              </thead>
              <tbody>
                <For each={sessions()}>
                  {(session) => (
                    <tr
                      role="link"
                      tabIndex={0}
                      class="border-b border-border last:border-0 hover:bg-muted/30 cursor-pointer focus:outline-none focus:bg-muted/40"
                      onClick={() => openSession(session)}
                      onKeyDown={(event) => handleRowKeyDown(event, session)}
                    >
                      <td class="px-3 py-2">
                        <div class="font-medium">{clientLabel(session)}</div>
                        <div class="text-xs text-muted-foreground font-mono truncate max-w-sm">
                          {session.id}
                        </div>
                      </td>
                      <td class="px-3 py-2">
                        <span class={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${transportClass(session.transport)}`}>
                          {session.transport}
                        </span>
                      </td>
                      <td class="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {tokenLabel(session)}
                      </td>
                      <td class="px-3 py-2 text-right font-mono">
                        {session.call_count.toLocaleString()}
                      </td>
                      <td class={`px-3 py-2 text-right font-mono ${session.error_count > 0 ? "text-red-400" : "text-muted-foreground"}`}>
                        {session.error_count.toLocaleString()}
                      </td>
                      <td class="px-3 py-2">
                        <div class="font-mono" title={formatAbsoluteTime(session.last_activity_at)}>
                          {formatRelativeTime(timestampToBrowserIso(session.last_activity_at))}
                        </div>
                        <Show when={session.last_call_at}>
                          {(lastCallAt) => (
                            <div class="text-xs text-muted-foreground font-mono">
                              last call {formatRelativeTime(timestampToBrowserIso(lastCallAt()))}
                            </div>
                          )}
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </div>
    </div>
  );
}
