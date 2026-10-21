import { A } from "@solidjs/router";
import { For, Show } from "solid-js";
import { formatRelativeDate } from "../lib/format";
import { useDiscordServers } from "../lib/queries";
import { buildDiscordServerUrl } from "../lib/routes";
import { IconChevronLeft } from "../ui/icons";
import ServerAvatar from "./ServerAvatar";

function formatMonthYear(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function ServersSkeleton() {
  return (
    <div class="divide-y divide-border/50">
      <For each={[1, 2, 3, 4, 5]}>
        {() => (
          <div class="flex items-center gap-3 px-4 py-3">
            <div class="w-9 h-9 rounded-2xl bg-accent animate-pulse shrink-0" />
            <div class="flex-1 space-y-2">
              <div class="h-4 w-40 bg-accent rounded animate-pulse" />
              <div class="h-3 w-28 bg-accent rounded animate-pulse" />
            </div>
            <div class="h-3 w-16 bg-accent rounded animate-pulse" />
          </div>
        )}
      </For>
    </div>
  );
}

export default function DiscordServersView() {
  const serversQuery = useDiscordServers();
  const servers = () =>
    serversQuery.isPending || serversQuery.isLoadingError
      ? null
      : serversQuery.data?.servers ?? [];

  return (
    <div class="flex flex-col h-full">
      {/* Header */}
      <div class="flex items-center gap-3 px-4 py-3 border-b border-border">
        <A
          href="/conversations"
          class="p-2 -ml-2 hover:bg-accent rounded-md transition-colors text-muted-foreground"
          title="Back to conversations"
        >
          <IconChevronLeft class="w-5 h-5" />
        </A>
        <div class="flex-1 min-w-0">
          <h1 class="font-display text-xl font-medium">Discord Servers</h1>
          <Show
            when={servers()}
            fallback={
              <Show
                when={serversQuery.isLoadingError}
                fallback={<div class="h-4 w-24 bg-accent rounded animate-pulse mt-1" />}
              >
                <p class="text-sm text-destructive">Failed to load servers</p>
              </Show>
            }
          >
            {(list) => (
              <p class="text-sm text-muted-foreground">
                <span class="font-mono">{list().length}</span> server{list().length === 1 ? "" : "s"}
              </p>
            )}
          </Show>
        </div>
      </div>

      {/* List */}
      <div class="flex-1 overflow-y-auto">
        <Show
          when={servers()}
          fallback={
            <Show when={serversQuery.isLoadingError} fallback={<ServersSkeleton />}>
              <div class="px-4 py-12 text-center text-destructive text-sm">
                Failed to load Discord servers.
              </div>
            </Show>
          }
        >
          {(list) => (
            <Show
              when={list().length > 0}
              fallback={
                <div class="px-4 py-12 text-center text-muted-foreground text-sm">
                  No Discord servers found. Sync a guild to see it here.
                </div>
              }
            >
              <div class="divide-y divide-border/50">
                <For each={list()}>
                  {(server) => (
                    <A
                      href={buildDiscordServerUrl(server.guildId)}
                      class="flex items-center gap-3 px-4 py-3 hover:bg-accent transition-colors"
                    >
                      <ServerAvatar name={server.name} iconUrl={server.iconUrl} class="w-9 h-9" />
                      <div class="flex-1 min-w-0">
                        <div class="text-sm font-medium truncate">{server.name}</div>
                        <div class="text-xs text-muted-foreground">
                          <span class="font-mono">{server.channelCount.toLocaleString()}</span> channel{server.channelCount === 1 ? "" : "s"}
                          {" · "}
                          <span class="font-mono">{server.messageCount.toLocaleString()}</span> message{server.messageCount === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div class="text-right shrink-0">
                        <div class="text-xs text-muted-foreground font-mono">{formatRelativeDate(server.lastMessage)}</div>
                        <Show when={server.firstMessage}>
                          <div class="text-[11px] text-muted-foreground/70 font-mono">
                            since {formatMonthYear(server.firstMessage)}
                          </div>
                        </Show>
                      </div>
                    </A>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}
