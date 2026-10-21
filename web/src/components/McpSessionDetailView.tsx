import { A, useParams } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";
import { formatRelativeTime } from "../lib/format";
import { formatAbsoluteTime, formatCallDuration, timestampToBrowserIso, transportClass } from "../lib/mcp-format";
import { useMcpSession } from "../lib/queries";
import { MCP_CALL_LIMIT } from "../lib/query-params";
import { ROUTES, safeDecode } from "../lib/routes";
import { IconChevronLeft } from "../ui/icons";
import McpToolCallRow from "./McpToolCallRow";

export default function McpSessionDetailView() {
  const params = useParams();
  const sessionId = () => (params.id ? safeDecode(params.id) : undefined);
  const query = useMcpSession(sessionId, () => ({ limit: MCP_CALL_LIMIT, offset: 0 }));
  const calls = () => query.data?.calls ?? [];

  const stats = createMemo(() => {
    return query.data?.stats ?? { call_count: 0, error_count: 0, avg_duration_ms: null };
  });
  const avgDurationLabel = createMemo(() => {
    const avgDurationMs = stats().avg_duration_ms;
    return avgDurationMs === null ? "—" : formatCallDuration(Math.round(avgDurationMs));
  });

  return (
    <div class="h-full overflow-auto">
      <div class="max-w-6xl mx-auto px-4 py-6">
        <div class="flex items-start gap-3 mb-6">
          <A
            href={ROUTES.MCP}
            class="p-2 hover:bg-accent rounded-md transition-colors"
            title="Back to MCP sessions"
          >
            <IconChevronLeft class="w-5 h-5" />
          </A>
          <div class="flex-1 min-w-0">
            <h1 class="font-display text-2xl font-medium">MCP session</h1>
            <Show when={sessionId()}>
              {(id) => (
                <div class="text-sm text-muted-foreground mt-1 font-mono truncate">
                  {id()}
                </div>
              )}
            </Show>
          </div>
          <Show when={sessionId()}>
            {(id) => (
              <a
                href={`/api/mcp/sessions/${encodeURIComponent(id())}.md`}
                target="_blank"
                rel="noreferrer"
                class="shrink-0 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
              >
                Open .md
              </a>
            )}
          </Show>
        </div>

        <Show when={query.isError}>
          <div class="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300 mb-4">
            Failed to load MCP session.
          </div>
        </Show>

        <Show
          when={query.data}
          fallback={
            <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
              MCP session not found.
            </div>
          }
        >
          {(detail) => (
            <>
              <div class="rounded-lg bg-card p-4 mb-6">
                <div class="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div class="text-xs text-muted-foreground mb-1">Client</div>
                    <div class="font-medium">
                      {detail().session.client_name ?? "Unknown client"}
                    </div>
                    <Show when={detail().session.client_version}>
                      {(version) => (
                        <div class="text-xs text-muted-foreground font-mono">{version()}</div>
                      )}
                    </Show>
                  </div>
                  <div>
                    <div class="text-xs text-muted-foreground mb-1">Transport</div>
                    <span class={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs ${transportClass(detail().session.transport)}`}>
                      {detail().session.transport}
                    </span>
                  </div>
                  <div>
                    <div class="text-xs text-muted-foreground mb-1">Token</div>
                    <div class="font-mono text-xs text-muted-foreground">
                      {detail().session.token_hash ?? "stdio"}
                    </div>
                  </div>
                  <div>
                    <div class="text-xs text-muted-foreground mb-1">Created</div>
                    <div class="font-mono" title={formatAbsoluteTime(detail().session.created_at)}>
                      {formatRelativeTime(timestampToBrowserIso(detail().session.created_at))}
                    </div>
                  </div>
                </div>
              </div>

              <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <StatTile
                  label="Total calls"
                  value={stats().call_count.toLocaleString()}
                />
                <StatTile
                  label="Errors"
                  value={stats().error_count.toLocaleString()}
                  tone={stats().error_count > 0 ? "bad" : "good"}
                />
                <StatTile
                  label="Avg duration"
                  value={avgDurationLabel()}
                />
                <StatTile
                  label="Last activity"
                  value={formatRelativeTime(timestampToBrowserIso(detail().session.last_activity_at))}
                />
              </div>

              <div>
                <h2 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Tool calls</h2>
                <Show when={calls().length < stats().call_count}>
                  <p class="text-sm text-muted-foreground mb-3">
                    Showing latest {calls().length.toLocaleString()} of {stats().call_count.toLocaleString()} calls.
                  </p>
                </Show>
                <Show
                  when={calls().length > 0}
                  fallback={
                    <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                      No tool calls recorded for this session.
                    </div>
                  }
                >
                  <div class="rounded-lg border border-border overflow-hidden">
                    <table class="w-full text-sm">
                      <thead>
                        <tr class="border-b border-border bg-muted/50">
                          <th class="text-left px-3 py-2 font-medium">Tool</th>
                          <th class="text-left px-3 py-2 font-medium">Duration</th>
                          <th class="text-left px-3 py-2 font-medium">Result size</th>
                          <th class="text-left px-3 py-2 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={calls()}>
                          {(call) => <McpToolCallRow call={call} />}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

function StatTile(props: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
}) {
  const toneClass = () => {
    switch (props.tone) {
      case "good":
        return "text-green-400";
      case "bad":
        return "text-red-400";
      default:
        return "";
    }
  };

  return (
    <div class="rounded-lg bg-card p-3">
      <div class="text-xs text-muted-foreground mb-1">{props.label}</div>
      <div class={`text-xl font-semibold font-mono ${toneClass()}`}>{props.value}</div>
    </div>
  );
}
