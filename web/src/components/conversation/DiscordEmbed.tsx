import { For, type JSX, Show } from "solid-js";
import type { TimelineEvent } from "../../lib/types";
import { IconPlayArrow } from "../../ui/icons";
import { Markdown, sanitizeLinkUri } from "../Markdown";
import { DiscordEmoji } from "./DiscordEmoji";

export interface DiscordEmbedData {
  type?: string;
  url?: string;
  title?: string;
  description?: string;
  color?: number;
  timestamp?: string;
  author?: { name: string; url?: string; icon_url?: string; proxy_icon_url?: string };
  provider?: { name?: string; url?: string };
  footer?: { text: string; icon_url?: string; proxy_icon_url?: string };
  thumbnail?: { url?: string; proxy_url?: string; width?: number; height?: number };
  image?: { url?: string; proxy_url?: string; width?: number; height?: number };
  video?: { url?: string; proxy_url?: string; width?: number; height?: number };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

// Discord attaches an "embed" object to messages that share a URL (link previews,
// videos, tweets, rich bot content). Embeds are preserved in raw_data by
// src/platforms/discord/event-converter.ts. Forwarded messages carry their embeds in
// message_snapshots[].message.embeds, so we merge both sources.
export function getDiscordEmbeds(event: TimelineEvent): DiscordEmbedData[] | null {
  if (event.source !== "discord" || !event.raw_data) return null;
  try {
    const raw = JSON.parse(event.raw_data);
    const collected: DiscordEmbedData[] = [];
    if (Array.isArray(raw.embeds)) collected.push(...raw.embeds);
    if (Array.isArray(raw.message_snapshots)) {
      for (const snap of raw.message_snapshots) {
        const snapEmbeds = snap?.message?.embeds;
        if (Array.isArray(snapEmbeds)) collected.push(...snapEmbeds);
      }
    }
    return collected.length > 0 ? collected : null;
  } catch {
    return null;
  }
}

function hexColor(n: number | undefined): string | undefined {
  if (typeof n !== "number" || n < 0 || n > 0xffffff) return undefined;
  return `#${n.toString(16).padStart(6, "0")}`;
}

// Matches Discord's footer format: "15/04/2026, 22:54".
function formatEmbedTimestamp(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString([], {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Discord's proxy_url routes through its CDN (stable, CORS-safe). Prefer it when present.
function pickImageSrc(
  m: { url?: string; proxy_url?: string } | undefined
): string | undefined {
  if (!m) return undefined;
  const href = m.proxy_url || m.url;
  if (!href) return undefined;
  const safe = sanitizeLinkUri(href);
  return safe || undefined;
}

interface SafeLink {
  href: string;
  target: string;
  rel: string;
}

function externalLinkProps(url: string | undefined): SafeLink | null {
  if (!url) return null;
  const safe = sanitizeLinkUri(url);
  if (!safe) return null;
  return { href: safe, target: "_blank", rel: "noopener noreferrer" };
}

// Poll-close notification (message type 46). Discord attaches a synthetic
// `poll_result` embed whose fields carry the outcome; the victor_* fields are
// absent when the poll ended with no votes or a tie.
function PollResultEmbed(props: { embed: DiscordEmbedData }): JSX.Element {
  const field = (name: string) =>
    props.embed.fields?.find((f) => f.name === name)?.value;
  const question = () => field("poll_question_text");
  const victorText = () => field("victor_answer_text");
  const victorEmojiId = () => field("victor_answer_emoji_id");
  const victorEmojiName = () => field("victor_answer_emoji_name");
  const victorVotes = () => Number(field("victor_answer_votes") ?? "0");
  const totalVotes = () => Number(field("total_votes") ?? "0");
  const percent = () =>
    totalVotes() > 0 ? Math.round((victorVotes() / totalVotes()) * 100) : 0;

  return (
    <div class="rounded-md border border-border/60 bg-muted/30 max-w-lg text-sm p-3 space-y-1.5">
      <div class="text-muted-foreground">
        The poll <span class="font-semibold text-foreground">{question()}</span> has
        closed.
      </div>
      <Show
        when={victorText() || victorEmojiName()}
        fallback={
          <div class="text-muted-foreground">
            No winning answer · {totalVotes()} {totalVotes() === 1 ? "vote" : "votes"}
          </div>
        }
      >
        <div class="flex items-center gap-2">
          <Show
            when={victorEmojiId()}
            fallback={
              <Show when={victorEmojiName()}>
                {(name) => <span class="text-lg leading-none">{name()}</span>}
              </Show>
            }
          >
            {(id) => <DiscordEmoji id={id()} name={victorEmojiName() ?? ""} size="inline" />}
          </Show>
          <span class="font-medium">{victorText()}</span>
          <span class="text-muted-foreground">
            Winning answer · {victorVotes()} of {totalVotes()}{" "}
            {totalVotes() === 1 ? "vote" : "votes"} ({percent()}%)
          </span>
        </div>
      </Show>
    </div>
  );
}

export function DiscordEmbed(props: { embed: DiscordEmbedData }): JSX.Element {
  const embed = () => props.embed;
  const stripe = () => hexColor(embed().color);
  const titleLink = () => externalLinkProps(embed().url);
  const authorLink = () => externalLinkProps(embed().author?.url);
  const authorIcon = () =>
    pickImageSrc({
      url: embed().author?.icon_url,
      proxy_url: embed().author?.proxy_icon_url,
    });
  const footerIcon = () =>
    pickImageSrc({
      url: embed().footer?.icon_url,
      proxy_url: embed().footer?.proxy_icon_url,
    });
  const banner = () => pickImageSrc(embed().image);
  const thumb = () => pickImageSrc(embed().thumbnail);
  const isVideoLike = () => embed().type === "video" || embed().type === "gifv";
  const fields = () => embed().fields ?? [];
  const hasFields = () => fields().length > 0;

  // Derive the final media src values so <Show when={...}> callbacks receive a
  // string (not a boolean from &&/|| short-circuits) and the compiler can hand
  // it to the child accessor verbatim.
  const bannerSrc = (): string | undefined => {
    if (banner()) return banner();
    if (isVideoLike()) return thumb();
    return undefined;
  };
  const thumbSrc = (): string | undefined => {
    if (banner() || isVideoLike()) return undefined;
    return thumb();
  };

  // `image`-type embeds from services like Gyazo are just a media share — render
  // as a bare linked image rather than a full card.
  const isPureImage = () =>
    embed().type === "image" && !embed().description && !embed().author && !hasFields();

  // Tenor/Giphy GIFs arrive as `gifv` embeds whose video is a short looping mp4.
  // Missing video url falls through to the thumbnail-with-play-overlay card.
  const gifvSrc = () =>
    embed().type === "gifv" ? pickImageSrc(embed().video) : undefined;

  return (
    <Show
      when={embed().type !== "poll_result"}
      fallback={<PollResultEmbed embed={embed()} />}
    >
    <Show when={!gifvSrc()} fallback={<GifvEmbed embed={embed()} />}>
    <Show when={!isPureImage()} fallback={<PureImageEmbed embed={embed()} />}>
      <div
        class="rounded-md border border-border/60 bg-muted/30 overflow-hidden max-w-lg text-sm"
        style={stripe() ? { "border-left": `4px solid ${stripe()}` } : undefined}
      >
        <div class="p-3 space-y-1.5">
          <Show when={embed().provider?.name || embed().author?.name}>
            <div class="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Show when={authorIcon()}>
                {(src) => (
                  <img src={src()} alt="" class="w-4 h-4 rounded-full" loading="lazy" />
                )}
              </Show>
              <Show
                when={embed().author?.name}
                fallback={<span>{embed().provider?.name}</span>}
              >
                {(name) => (
                  <Show
                    when={authorLink()}
                    fallback={<span class="font-semibold text-foreground">{name()}</span>}
                  >
                    {(link) => (
                      <a class="font-semibold text-foreground hover:underline" {...link()}>
                        {name()}
                      </a>
                    )}
                  </Show>
                )}
              </Show>
              <Show when={embed().author?.name && embed().provider?.name}>
                <span class="opacity-60">· {embed().provider?.name}</span>
              </Show>
            </div>
          </Show>

          <Show when={embed().title}>
            {(title) => (
              <Show
                when={titleLink()}
                fallback={<div class="font-semibold leading-snug">{title()}</div>}
              >
                {(link) => (
                  <a class="font-semibold leading-snug text-primary hover:underline" {...link()}>
                    {title()}
                  </a>
                )}
              </Show>
            )}
          </Show>

          <Show when={embed().description}>
            {(desc) => (
              <div class="text-sm text-foreground/90 leading-snug">
                <Markdown markdown={desc()} />
              </div>
            )}
          </Show>

          <Show when={hasFields()}>
            <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 pt-1">
              <For each={fields()}>
                {(field) => (
                  <div class={field.inline ? "col-span-1" : "col-span-2"}>
                    <div class="text-sm font-semibold">{field.name}</div>
                    <div class="text-sm text-foreground/90">
                      <Markdown markdown={field.value} />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={thumbSrc()}>
            {(src) => (
              <Show when={titleLink()} fallback={<ThumbImage src={src()} />}>
                {(link) => (
                  <a {...link()} class="block w-24">
                    <ThumbImage src={src()} />
                  </a>
                )}
              </Show>
            )}
          </Show>
        </div>

        <Show when={bannerSrc()}>
          {(src) => (
            <div class="px-3 pb-3">
              <Show
                when={titleLink()}
                fallback={<BannerImage src={src()} withPlay={isVideoLike()} />}
              >
                {(link) => (
                  <a {...link()} class="block">
                    <BannerImage src={src()} withPlay={isVideoLike()} />
                  </a>
                )}
              </Show>
            </div>
          )}
        </Show>

        <Show when={embed().footer?.text || formatEmbedTimestamp(embed().timestamp)}>
          <div class="flex items-center gap-1.5 px-3 py-2 border-t border-border/40 text-sm text-muted-foreground">
            <Show when={footerIcon()}>
              {(src) => (
                <img src={src()} alt="" class="w-3.5 h-3.5 rounded-full" loading="lazy" />
              )}
            </Show>
            <Show when={embed().footer?.text}>
              {(text) => <span>{text()}</span>}
            </Show>
            <Show when={embed().footer?.text && formatEmbedTimestamp(embed().timestamp)}>
              <span aria-hidden="true">·</span>
            </Show>
            <Show when={formatEmbedTimestamp(embed().timestamp)}>
              {(ts) => <span>{ts()}</span>}
            </Show>
          </div>
        </Show>
      </div>
    </Show>
    </Show>
    </Show>
  );
}

// Discord autoplays gifv embeds as muted looping videos with no card chrome —
// they read as inline images that happen to move.
function GifvEmbed(props: { embed: DiscordEmbedData }): JSX.Element {
  const src = () => pickImageSrc(props.embed.video);
  return (
    <video
      src={src()}
      poster={pickImageSrc(props.embed.thumbnail)}
      width={props.embed.video?.width}
      height={props.embed.video?.height}
      autoplay
      loop
      muted
      playsinline
      class="rounded-md max-w-sm max-h-80 w-auto h-auto border border-border/40 block"
    />
  );
}

function ThumbImage(props: { src: string }): JSX.Element {
  return (
    <img
      src={props.src}
      alt=""
      loading="lazy"
      class="rounded-sm w-24 h-24 object-cover border border-border/40"
    />
  );
}

function BannerImage(props: { src: string; withPlay?: boolean }): JSX.Element {
  return (
    <div class="relative">
      <img
        src={props.src}
        alt=""
        loading="lazy"
        class="w-full max-h-96 object-cover block rounded-sm"
      />
      <Show when={props.withPlay}>
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-14 h-14 rounded-full bg-black/60 flex items-center justify-center">
            <IconPlayArrow class="w-7 h-7 text-white ml-1" />
          </div>
        </div>
      </Show>
    </div>
  );
}

function PureImageEmbed(props: { embed: DiscordEmbedData }): JSX.Element {
  const src = () => pickImageSrc(props.embed.thumbnail ?? props.embed.image);
  const link = () => externalLinkProps(props.embed.url);
  return (
    <Show when={src()}>
      {(s) => (
        <Show
          when={link()}
          fallback={
            <img
              src={s()}
              alt={props.embed.title ?? ""}
              loading="lazy"
              class="rounded-md max-w-sm max-h-80 border border-border/40"
            />
          }
        >
          {(l) => (
            <a {...l()} class="inline-block">
              <img
                src={s()}
                alt={props.embed.title ?? ""}
                loading="lazy"
                class="rounded-md max-w-sm max-h-80 border border-border/40"
              />
            </a>
          )}
        </Show>
      )}
    </Show>
  );
}
