import type {
  DiscordComponent,
  DiscordGalleryItem,
  DiscordUnfurledMedia,
} from "@shared/discord-components";
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { discordMentionsToPlainText } from "../../lib/discord-mentions";
import { viewerTimeZone } from "../../lib/discord-timestamps";
import { IconChevronDown, IconImage, IconOpenInNew } from "../../ui/icons";
import { Markdown, sanitizeLinkUri } from "../Markdown";
import { DiscordAttachmentFallback } from "./DiscordAttachmentFallback";
import { discordUserResolver } from "./DiscordContent";
import { DiscordEmoji } from "./DiscordEmoji";
import { externalLinkProps, hexColor, pickImageSrc } from "./discord-media";

const TEXT_CLASS =
  "prose prose-sm dark:prose-invert max-w-none break-words prose-headings:mt-0 prose-headings:mb-1 prose-p:my-0 prose-ul:my-1 prose-ol:my-1 prose-pre:my-1";
const SUBTEXT_CLASS = "text-xs text-muted-foreground break-words [&_a]:underline";
const BUTTON_LINK_STYLE = 5;
const BUTTON_STYLE_CLASS: Record<number, string> = {
  1: "bg-primary/80 text-primary-foreground",
  3: "bg-green-700/80 text-white",
  4: "bg-red-700/80 text-white",
};
const NEUTRAL_BUTTON_CLASS = "bg-muted text-foreground";
const INERT_TITLE = "Interactive only in Discord";

interface TextBlock {
  subtext: boolean;
  text: string;
}

/** Split on Discord's `-# ` subtext lines, which Markdown would show literally. */
export function splitDiscordSubtext(content: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let inFence = false;
  for (const line of content.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const subtext = !inFence && line.startsWith("-# ");
    const text = subtext ? line.slice(3) : line;
    const last = blocks.at(-1);
    if (last?.subtext === subtext) last.text += `\n${text}`;
    else blocks.push({ subtext, text });
  }
  return blocks;
}

// Discord keeps a lone newline as a line break; Markdown would collapse it to a space.
function withHardBreaks(text: string): string {
  return text.replace(/(?<!\n)\n(?!\n)/g, "  \n");
}

function DiscordTextDisplay(props: { content: string; rawData: unknown }): JSX.Element {
  const blocks = () =>
    splitDiscordSubtext(
      discordMentionsToPlainText(
        props.content,
        props.rawData,
        { user: discordUserResolver },
        { timeZone: viewerTimeZone() },
      ),
    );
  return (
    <div class="flex flex-col gap-0.5">
      <For each={blocks()}>
        {(block) => (
          <Markdown
            markdown={withHardBreaks(block.text)}
            class={block.subtext ? SUBTEXT_CLASS : TEXT_CLASS}
          />
        )}
      </For>
    </div>
  );
}

function Spoiler(props: { hidden: boolean; children: JSX.Element }): JSX.Element {
  const [revealed, setRevealed] = createSignal(false);
  const concealed = () => props.hidden && !revealed();
  return (
    <div class={`relative ${concealed() ? "overflow-hidden rounded-sm" : ""}`}>
      <div class={concealed() ? "blur-xl select-none pointer-events-none" : undefined} inert={concealed()}>
        {props.children}
      </div>
      <Show when={concealed()}>
        <button
          type="button"
          class="absolute inset-0 flex items-center justify-center bg-background/20 text-xs font-semibold cursor-pointer"
          onClick={(event) => {
            event.stopPropagation();
            setRevealed(true);
          }}
        >
          Spoiler
        </button>
      </Show>
    </div>
  );
}

/** Media is only ever remote, and signed attachment URLs stop working after they expire. */
function ComponentImage(props: {
  media: DiscordUnfurledMedia;
  alt: string | null;
  class: string;
}): JSX.Element {
  const [failed, setFailed] = createSignal(false);
  const src = () => (failed() ? undefined : pickImageSrc(props.media));
  return (
    <Show
      when={src()}
      fallback={
        <div
          role="img"
          aria-label={props.alt ?? "Image unavailable"}
          title="Image unavailable"
          class={`${props.class} flex flex-col items-center justify-center gap-1 bg-muted/60 text-xs text-muted-foreground text-center`}
        >
          <IconImage class="h-5 w-5 shrink-0" aria-hidden />
          <span>Image unavailable</span>
        </div>
      }
    >
      {(url) => (
        <img
          src={url()}
          alt={props.alt ?? ""}
          loading="lazy"
          class={props.class}
          onError={() => setFailed(true)}
        />
      )}
    </Show>
  );
}

function GalleryItem(props: { item: DiscordGalleryItem; wide: boolean }): JSX.Element {
  const imageClass = () =>
    `w-full rounded-sm border border-border/40 object-cover ${props.wide ? "max-h-80 min-h-24" : "h-40"}`;
  const videoSrc = () =>
    props.item.media.content_type?.startsWith("video/")
      ? sanitizeLinkUri(props.item.media.url)
      : "";
  const link = () => externalLinkProps(props.item.media.url);
  return (
    <div class={props.wide ? "col-span-2" : undefined}>
      <Spoiler hidden={props.item.spoiler}>
        <Show
          when={videoSrc()}
          fallback={
            <Show
              when={link()}
              fallback={
                <ComponentImage media={props.item.media} alt={props.item.description} class={imageClass()} />
              }
            >
              {(href) => (
                <a {...href()} class="block">
                  <ComponentImage media={props.item.media} alt={props.item.description} class={imageClass()} />
                </a>
              )}
            </Show>
          }
        >
          {(src) => (
            <video src={src()} controls preload="metadata" class="w-full max-h-80 rounded-sm block" />
          )}
        </Show>
      </Spoiler>
    </div>
  );
}

function DiscordMediaGallery(props: { items: DiscordGalleryItem[] }): JSX.Element {
  // An odd count leaves the first item full width, as Discord's mosaic does.
  const isWide = (index: number) => index === 0 && props.items.length % 2 === 1;
  return (
    <div class="grid grid-cols-2 gap-1">
      <For each={props.items}>
        {(item, index) => <GalleryItem item={item} wide={isWide(index())} />}
      </For>
    </div>
  );
}

function DiscordButton(props: {
  button: Extract<DiscordComponent, { kind: "button" }>;
}): JSX.Element {
  const styleClass = () => BUTTON_STYLE_CLASS[props.button.style ?? 0] ?? NEUTRAL_BUTTON_CLASS;
  const baseClass = () =>
    `inline-flex items-center gap-1.5 rounded-sm px-3 py-1 text-sm font-medium ${styleClass()} ${props.button.disabled ? "opacity-50" : ""}`;
  const link = () =>
    props.button.style === BUTTON_LINK_STYLE && !props.button.disabled
      ? externalLinkProps(props.button.url)
      : null;
  const body = () => (
    <>
      <Show when={props.button.emoji}>
        {(emoji) => (
          <Show when={emoji().id} fallback={<span>{emoji().name}</span>}>
            {(id) => <DiscordEmoji id={id()} name={emoji().name} size="preview" />}
          </Show>
        )}
      </Show>
      <Show when={props.button.label ?? (props.button.emoji ? null : "Button")}>
        {(label) => <span>{label()}</span>}
      </Show>
    </>
  );
  return (
    <Show
      when={link()}
      fallback={
        <span class={`${baseClass()} cursor-default`} title={INERT_TITLE}>
          {body()}
        </span>
      }
    >
      {(href) => (
        <a {...href()} class={`${baseClass()} hover:underline`}>
          {body()}
          <IconOpenInNew class="h-3.5 w-3.5" aria-hidden />
        </a>
      )}
    </Show>
  );
}

function ComponentNode(props: { component: DiscordComponent; rawData: unknown }): JSX.Element {
  return (
    <Switch>
      <Match when={props.component.kind === "text" && props.component}>
        {(text) => <DiscordTextDisplay content={text().content} rawData={props.rawData} />}
      </Match>
      <Match when={props.component.kind === "container" && props.component}>
        {(container) => (
          <div
            class="rounded-md border border-border/60 bg-muted/30 overflow-hidden max-w-lg text-sm"
            style={
              hexColor(container().accentColor)
                ? { "border-left": `4px solid ${hexColor(container().accentColor)}` }
                : undefined
            }
          >
            <Spoiler hidden={container().spoiler}>
              <div class="p-3">
                <ComponentList components={container().components} rawData={props.rawData} />
              </div>
            </Spoiler>
          </div>
        )}
      </Match>
      <Match when={props.component.kind === "section" && props.component}>
        {(section) => (
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <ComponentList components={section().components} rawData={props.rawData} />
            </div>
            <Show when={section().accessory}>
              {(accessory) => (
                <div class="shrink-0">
                  <ComponentNode component={accessory()} rawData={props.rawData} />
                </div>
              )}
            </Show>
          </div>
        )}
      </Match>
      <Match when={props.component.kind === "thumbnail" && props.component}>
        {(thumbnail) => (
          <Spoiler hidden={thumbnail().spoiler}>
            <ComponentImage
              media={thumbnail().media}
              alt={thumbnail().description}
              class="w-20 h-20 rounded-sm object-cover border border-border/40"
            />
          </Spoiler>
        )}
      </Match>
      <Match when={props.component.kind === "gallery" && props.component}>
        {(gallery) => <DiscordMediaGallery items={gallery().items} />}
      </Match>
      <Match when={props.component.kind === "file" && props.component}>
        {(file) => (
          <Spoiler hidden={file().spoiler}>
            <DiscordAttachmentFallback
              attachments={[
                {
                  id: file().media.url,
                  filename: file().name,
                  size: file().size,
                  url: file().media.url,
                },
              ]}
            />
          </Spoiler>
        )}
      </Match>
      <Match when={props.component.kind === "separator" && props.component}>
        {(separator) => (
          <Show
            when={separator().divider}
            fallback={<div class={separator().large ? "h-3" : "h-1"} />}
          >
            <hr class={`border-border/60 ${separator().large ? "my-2" : "my-0.5"}`} />
          </Show>
        )}
      </Match>
      <Match when={props.component.kind === "action-row" && props.component}>
        {(row) => (
          <div class="flex flex-wrap items-center gap-1.5">
            <For each={row().components}>
              {(child) => <ComponentNode component={child} rawData={props.rawData} />}
            </For>
          </div>
        )}
      </Match>
      <Match when={props.component.kind === "button" && props.component}>
        {(button) => <DiscordButton button={button()} />}
      </Match>
      <Match when={props.component.kind === "select" && props.component}>
        {(select) => (
          <div
            class={`flex items-center justify-between gap-2 w-full min-w-48 max-w-sm rounded-sm border border-border/60 bg-background/50 px-3 py-1 text-sm text-muted-foreground cursor-default ${select().disabled ? "opacity-50" : ""}`}
            title={INERT_TITLE}
          >
            <span class="truncate">{select().placeholder ?? "Make a selection"}</span>
            <IconChevronDown class="h-4 w-4 shrink-0" aria-hidden />
          </div>
        )}
      </Match>
      <Match when={props.component.kind === "unknown" && props.component}>
        {(unknown) => (
          <div class="text-xs italic text-muted-foreground">
            Unsupported Discord component
            <Show when={unknown().type !== null}> (type {unknown().type})</Show>
          </div>
        )}
      </Match>
    </Switch>
  );
}

function ComponentList(props: { components: DiscordComponent[]; rawData: unknown }): JSX.Element {
  return (
    <div class="flex flex-col gap-2">
      <For each={props.components}>
        {(component) => <ComponentNode component={component} rawData={props.rawData} />}
      </For>
    </div>
  );
}

export function DiscordComponents(props: {
  components: DiscordComponent[];
  rawData: unknown;
}): JSX.Element {
  return (
    <div class="max-w-lg">
      <ComponentList components={props.components} rawData={props.rawData} />
    </div>
  );
}
