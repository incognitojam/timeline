import { asRecord, getSnapshotMessages, parseRawData } from "./discord-forward";

// https://docs.discord.com/developers/components/reference#component-object-component-types
const COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  USER_SELECT: 5,
  ROLE_SELECT: 6,
  MENTIONABLE_SELECT: 7,
  CHANNEL_SELECT: 8,
  SECTION: 9,
  TEXT_DISPLAY: 10,
  THUMBNAIL: 11,
  MEDIA_GALLERY: 12,
  FILE: 13,
  SEPARATOR: 14,
  CONTAINER: 17,
} as const;

const SEPARATOR_SPACING_LARGE = 2;

export interface DiscordUnfurledMedia {
  url: string;
  proxy_url?: string;
  content_type?: string;
}

export interface DiscordGalleryItem {
  media: DiscordUnfurledMedia;
  description: string | null;
  spoiler: boolean;
}

export interface DiscordButtonEmoji {
  id: string | null;
  name: string;
}

export type DiscordComponent =
  | { kind: "action-row"; components: DiscordComponent[] }
  | {
      kind: "button";
      style: number | null;
      label: string | null;
      emoji: DiscordButtonEmoji | null;
      url: string | null;
      disabled: boolean;
    }
  | { kind: "select"; placeholder: string | null; disabled: boolean }
  | { kind: "section"; components: DiscordComponent[]; accessory: DiscordComponent | null }
  | { kind: "text"; content: string }
  | { kind: "thumbnail"; media: DiscordUnfurledMedia; description: string | null; spoiler: boolean }
  | { kind: "gallery"; items: DiscordGalleryItem[] }
  | { kind: "file"; media: DiscordUnfurledMedia; name: string; size: number; spoiler: boolean }
  | { kind: "separator"; divider: boolean; large: boolean }
  | { kind: "container"; components: DiscordComponent[]; accentColor: number | null; spoiler: boolean }
  /** A type this build doesn't know, or a known type missing a required field. */
  | { kind: "unknown"; type: number | null };

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseMedia(value: unknown): DiscordUnfurledMedia | null {
  const media = asRecord(value);
  const url = asString(media?.url);
  if (!media || !url) return null;
  return {
    url,
    proxy_url: asString(media.proxy_url) ?? undefined,
    content_type: asString(media.content_type) ?? undefined,
  };
}

function parseGalleryItem(value: unknown): DiscordGalleryItem | null {
  const item = asRecord(value);
  const media = parseMedia(item?.media);
  if (!item || !media) return null;
  return { media, description: asString(item.description), spoiler: item.spoiler === true };
}

function parseButtonEmoji(value: unknown): DiscordButtonEmoji | null {
  const emoji = asRecord(value);
  const name = asString(emoji?.name);
  return emoji && name ? { id: asString(emoji.id), name } : null;
}

function parseSelect(value: Record<string, unknown>): DiscordComponent {
  return { kind: "select", placeholder: asString(value.placeholder), disabled: value.disabled === true };
}

/** Each parser returns null when a required field is missing. */
const COMPONENT_PARSERS: Readonly<Record<number, (value: Record<string, unknown>) => DiscordComponent | null>> = {
  [COMPONENT_TYPE.ACTION_ROW]: (value) => ({
    kind: "action-row",
    components: parseDiscordComponents(value.components),
  }),
  [COMPONENT_TYPE.BUTTON]: (value) => ({
    kind: "button",
    style: typeof value.style === "number" ? value.style : null,
    label: asString(value.label),
    emoji: parseButtonEmoji(value.emoji),
    url: asString(value.url),
    disabled: value.disabled === true,
  }),
  [COMPONENT_TYPE.STRING_SELECT]: parseSelect,
  [COMPONENT_TYPE.USER_SELECT]: parseSelect,
  [COMPONENT_TYPE.ROLE_SELECT]: parseSelect,
  [COMPONENT_TYPE.MENTIONABLE_SELECT]: parseSelect,
  [COMPONENT_TYPE.CHANNEL_SELECT]: parseSelect,
  [COMPONENT_TYPE.SECTION]: (value) => {
    const accessory = asRecord(value.accessory);
    return {
      kind: "section",
      components: parseDiscordComponents(value.components),
      accessory: accessory ? parseComponent(accessory) : null,
    };
  },
  [COMPONENT_TYPE.TEXT_DISPLAY]: (value) => {
    const content = asString(value.content);
    return content === null ? null : { kind: "text", content };
  },
  [COMPONENT_TYPE.THUMBNAIL]: (value) => {
    const media = parseMedia(value.media);
    return media
      ? { kind: "thumbnail", media, description: asString(value.description), spoiler: value.spoiler === true }
      : null;
  },
  [COMPONENT_TYPE.MEDIA_GALLERY]: (value) => {
    if (!Array.isArray(value.items)) return null;
    const items = value.items
      .map(parseGalleryItem)
      .filter((item): item is DiscordGalleryItem => item !== null);
    return items.length > 0 ? { kind: "gallery", items } : null;
  },
  [COMPONENT_TYPE.FILE]: (value) => {
    const media = parseMedia(value.file);
    const name = asString(value.name);
    return media && name && typeof value.size === "number"
      ? { kind: "file", media, name, size: value.size, spoiler: value.spoiler === true }
      : null;
  },
  [COMPONENT_TYPE.SEPARATOR]: (value) => ({
    kind: "separator",
    divider: value.divider !== false,
    large: value.spacing === SEPARATOR_SPACING_LARGE,
  }),
  [COMPONENT_TYPE.CONTAINER]: (value) => ({
    kind: "container",
    components: parseDiscordComponents(value.components),
    accentColor: typeof value.accent_color === "number" ? value.accent_color : null,
    spoiler: value.spoiler === true,
  }),
};

function parseComponent(value: Record<string, unknown>): DiscordComponent {
  const type = typeof value.type === "number" ? value.type : null;
  const parsed = type === null ? null : COMPONENT_PARSERS[type]?.(value);
  return parsed ?? { kind: "unknown", type };
}

/** Narrow a stored `components` array. Non-object entries carry nothing to show and are dropped. */
export function parseDiscordComponents(value: unknown): DiscordComponent[] {
  if (!Array.isArray(value)) return [];
  const components: DiscordComponent[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record) components.push(parseComponent(record));
  }
  return components;
}

/** Components on a message and on any message it forwards. */
export function getDiscordMessageComponents(rawData: unknown): DiscordComponent[] {
  const raw = parseRawData(rawData);
  return [
    ...parseDiscordComponents(asRecord(raw)?.components),
    ...getSnapshotMessages(raw).flatMap((message) => parseDiscordComponents(message.components)),
  ];
}

function collectText(components: DiscordComponent[], into: string[]): string[] {
  for (const component of components) {
    if (component.kind === "text") into.push(component.content);
    else if (component.kind === "section" || component.kind === "container") {
      collectText(component.components, into);
    }
  }
  return into;
}

/** Text Display content in reading order, or null when the components hold no text. */
export function getDiscordComponentText(components: DiscordComponent[]): string | null {
  const text = collectText(components, [])
    .map((content) => content.trim())
    .filter((content) => content.length > 0);
  return text.length > 0 ? text.join("\n") : null;
}

/**
 * Text of a Components V2 message, whose `content` Discord requires to be empty.
 * Used wherever a message's text is needed but its stored content may still be empty.
 */
export function getDiscordComponentsText(rawData: unknown): string | null {
  return getDiscordComponentText(getDiscordMessageComponents(rawData));
}
