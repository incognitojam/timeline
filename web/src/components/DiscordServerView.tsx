import { A, useNavigate, useParams } from "@solidjs/router";
import type { EChartsOption } from "echarts";
import { EChartsAutoSize } from "../ui/echarts";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { type DiscordServerDetail, type DiscordServerEmoji, fetchDiscordServer } from "../lib/api";
import { useChartTheme } from "../lib/echarts-theme";
import { formatRelativeDate, getInitials } from "../lib/format";
import { buildContactsUrl, buildConversationUrl } from "../lib/routes";
import { getSourceColorValue } from "../lib/source-styles";
import { IconChevronLeft, IconForum } from "../ui/icons";
import ServerAvatar from "./ServerAvatar";

const DISCORD = getSourceColorValue("discord");

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function EmojiTile(props: { emoji: DiscordServerEmoji }) {
  const [failed, setFailed] = createSignal(false);

  return (
    <span
      class="w-6 h-6 rounded-sm bg-background border border-border/60 overflow-hidden flex items-center justify-center shrink-0"
      title={`:${props.emoji.name}:`}
    >
      <Show
        when={!failed()}
        fallback={<span class="text-[10px] font-medium text-muted-foreground">{props.emoji.name.slice(0, 1).toUpperCase()}</span>}
      >
        <img
          src={props.emoji.imageUrl}
          alt={`:${props.emoji.name}:`}
          class="w-5 h-5 object-contain"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </Show>
    </span>
  );
}

export default function DiscordServerView() {
  const chart = useChartTheme();
  const params = useParams();
  const navigate = useNavigate();

  // Discord is the only source with servers today, so reject any other source
  // segment rather than rendering a Discord guild under e.g. /server/slack/<id>.
  // Returning null keeps createResource from fetching at all.
  const guildId = () => (params.source === "discord" ? params.id || null : null);

  // Swallow transport errors so the resource never enters the terminal errored
  // state (no ErrorBoundary above this route); a missing/failed server becomes
  // a null detail, surfaced as the "not found" branch.
  const [detailRes] = createResource(guildId, async (id) => {
    try {
      const result = await fetchDiscordServer(id);
      return "error" in result ? null : result;
    } catch {
      return null;
    }
  });

  const detail = (): DiscordServerDetail | null => (detailRes.loading ? null : detailRes.latest ?? null);
  const maxParticipant = createMemo(() => detail()?.participants[0]?.count ?? 0);

  const activityOption = (): EChartsOption | null => {
    const d = detail();
    if (!d || d.activityByMonth.length === 0) return null;
    return {
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const p = (params as { axisValue: string; value: number }[])[0];
          return `${p.axisValue}: ${p.value.toLocaleString()} messages`;
        },
      },
      grid: { left: 0, right: 0, top: 4, bottom: 0 },
      xAxis: { type: "category", data: d.activityByMonth.map((m) => m.month), show: false },
      yAxis: { type: "value", show: false },
      series: [
        {
          type: "bar",
          data: d.activityByMonth.map((m) => m.count),
          itemStyle: { color: chart.palette()[0], borderRadius: [2, 2, 0, 0] },
        },
      ],
    };
  };

  return (
    <div class="h-full flex flex-col">
      {/* Header */}
      <div class="flex items-center gap-4 p-4 border-b border-border bg-card/50">
        <button
          class="p-2 hover:bg-accent rounded-md transition-colors"
          onClick={() => navigate("/servers")}
          title="Back to servers"
        >
          <IconChevronLeft class="w-5 h-5" />
        </button>
        {/* Hide the avatar/name once we know there's no server (vs. still
            loading), so the "not found" state doesn't sit behind a skeleton. */}
        <Show when={detail() || detailRes.loading} fallback={<div class="flex-1" />}>
          {/* Empty name while loading -> guildAcronym renders its "#" fallback. */}
          <ServerAvatar name={detail()?.name ?? ""} iconUrl={detail()?.iconUrl} class="w-10 h-10" />
          <div class="flex-1 min-w-0">
            <Show
              when={detail()}
              fallback={<div class="h-6 w-48 bg-accent rounded animate-pulse" />}
            >
              {(d) => (
                <>
                  <h1 class="font-display text-xl font-medium truncate">{d().name}</h1>
                  <p class="text-sm text-muted-foreground">
                    <span class="font-mono">{d().channelCount.toLocaleString()}</span> channels · <span class="font-mono">{d().messageCount.toLocaleString()}</span> messages
                  </p>
                </>
              )}
            </Show>
          </div>
        </Show>
      </div>

      {/* Not found */}
      <Show when={!detailRes.loading && !detail()}>
        <div class="flex-1 flex items-center justify-center text-muted-foreground">
          Server not found
        </div>
      </Show>

      <Show when={detail()}>
        {(d) => (
          <div class="flex-1 flex min-h-0">
            {/* Channels by category */}
            <div class="flex-1 overflow-auto min-w-0">
              <For each={d().categories}>
                {(category) => (
                  <div>
                    <div class="sticky top-0 z-10 px-4 py-2 bg-background/95 backdrop-blur border-b border-border">
                      <span class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        {category.name ?? "Other"}
                      </span>
                      <span class="ml-2 text-xs text-muted-foreground/70 font-mono">
                        {category.channels.length}
                      </span>
                    </div>
                    <div class="divide-y divide-border/50">
                      <For each={category.channels}>
                        {(ch) => (
                          <A
                            href={buildConversationUrl("discord", ch.conversationId, ch.lastEventId)}
                            class="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors"
                          >
                            <span class="text-muted-foreground shrink-0 w-4 text-center">
                              <Show when={ch.isThread} fallback={<span aria-hidden="true">#</span>}>
                                <IconForum class="h-4 w-4" aria-hidden />
                                <span class="sr-only">Thread</span>
                              </Show>
                            </span>
                            <span class="flex-1 min-w-0 truncate text-sm">{ch.name}</span>
                            <span class="text-xs text-muted-foreground font-mono tabular-nums shrink-0">
                              {ch.messageCount.toLocaleString()}
                            </span>
                            <span class="text-xs text-muted-foreground shrink-0 w-16 text-right">
                              {formatRelativeDate(ch.lastMessage)}
                            </span>
                          </A>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>

            {/* Sidebar */}
            <div class="w-72 border-l border-border bg-card/30 overflow-auto shrink-0">
              <div class="p-4 space-y-6">
                <div>
                  <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Overview</h3>
                  <div class="space-y-2 text-sm">
                    <div class="flex justify-between">
                      <span class="text-muted-foreground">Channels</span>
                      <span class="font-mono">{d().channelCount.toLocaleString()}</span>
                    </div>
                    <div class="flex justify-between">
                      <span class="text-muted-foreground">Messages</span>
                      <span class="font-medium font-mono" style={{ color: DISCORD }}>
                        {d().messageCount.toLocaleString()}
                      </span>
                    </div>
                    <div class="flex justify-between">
                      <span class="text-muted-foreground">Emoji</span>
                      <span class="font-mono">{d().emojiCount.toLocaleString()}</span>
                    </div>
                    <div class="flex justify-between">
                      <span class="text-muted-foreground">First activity</span>
                      <span class="font-mono">{formatDate(d().firstMessage)}</span>
                    </div>
                    <div class="flex justify-between">
                      <span class="text-muted-foreground">Last activity</span>
                      <span class="font-mono">{formatDate(d().lastMessage)}</span>
                    </div>
                  </div>
                </div>

                <Show when={activityOption()}>
                  {(opt) => (
                    <div>
                      <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Activity</h3>
                      <div class="h-16">
                        <EChartsAutoSize option={chart.option(opt())} />
                      </div>
                    </div>
                  )}
                </Show>

                <Show when={d().emojiUploaders.length > 0}>
                  <div>
                    <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Custom emoji</h3>
                    <div class="space-y-3">
                      <For each={d().emojiUploaders}>
                        {(uploader) => {
                          const visibleEmoji = () => uploader.emojis.slice(0, 8);
                          const hiddenCount = () => uploader.emojis.length - visibleEmoji().length;
                          const row = (
                            <div class="space-y-2">
                              <div class="flex items-center gap-2">
                                <Show
                                  when={uploader.avatarUrl}
                                  fallback={
                                    <div
                                      class="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-semibold text-white"
                                      style={{ "background-color": DISCORD }}
                                    >
                                      {getInitials(uploader.name)}
                                    </div>
                                  }
                                >
                                  {(url) => (
                                    <img src={url()} alt="" class="w-6 h-6 rounded-full shrink-0 object-cover" />
                                  )}
                                </Show>
                                <div class="min-w-0 flex-1">
                                  <div class="flex items-baseline justify-between gap-2">
                                    <span class="text-sm truncate">{uploader.name}</span>
                                    <span class="text-xs text-muted-foreground font-mono tabular-nums shrink-0">
                                      {uploader.count.toLocaleString()}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <div class="ml-8 flex flex-wrap gap-1">
                                <For each={visibleEmoji()}>
                                  {(emoji) => <EmojiTile emoji={emoji} />}
                                </For>
                                <Show when={hiddenCount() > 0}>
                                  <span class="w-6 h-6 rounded-sm border border-border/60 bg-accent/50 flex items-center justify-center text-[10px] text-muted-foreground font-mono tabular-nums shrink-0">
                                    +{hiddenCount()}
                                  </span>
                                </Show>
                              </div>
                            </div>
                          );
                          return (
                            <Show when={uploader.contactId} fallback={row}>
                              {(cid) => (
                                <A href={buildContactsUrl({ id: cid() })} class="block hover:opacity-80 transition-opacity">
                                  {row}
                                </A>
                              )}
                            </Show>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </Show>

                <Show when={d().participants.length > 0}>
                  <div>
                    <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Top participants</h3>
                    <div class="space-y-2">
                      <For each={d().participants.slice(0, 15)}>
                        {(p) => {
                          const pct = () =>
                            maxParticipant() > 0 ? Math.max(4, (p.count / maxParticipant()) * 100) : 0;
                          const row = (
                            <div class="flex items-center gap-2">
                              <Show
                                when={p.avatarUrl}
                                fallback={
                                  <div
                                    class="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-semibold text-white"
                                    style={{ "background-color": DISCORD }}
                                  >
                                    {getInitials(p.name)}
                                  </div>
                                }
                              >
                                {(url) => (
                                  <img src={url()} alt="" class="w-6 h-6 rounded-full shrink-0 object-cover" />
                                )}
                              </Show>
                              <div class="flex-1 min-w-0">
                                <div class="flex items-baseline justify-between gap-2">
                                  <span class="text-sm truncate">{p.name}</span>
                                  <span class="text-xs text-muted-foreground font-mono tabular-nums shrink-0">
                                    {p.count.toLocaleString()}
                                  </span>
                                </div>
                                <div class="mt-1 h-1 rounded-full bg-accent overflow-hidden">
                                  <div class="h-full rounded-full" style={{ width: `${pct()}%`, "background-color": DISCORD }} />
                                </div>
                              </div>
                            </div>
                          );
                          return (
                            <Show when={p.contactId} fallback={row}>
                              {(cid) => (
                                <A href={buildContactsUrl({ id: cid() })} class="block hover:opacity-80 transition-opacity">
                                  {row}
                                </A>
                              )}
                            </Show>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
