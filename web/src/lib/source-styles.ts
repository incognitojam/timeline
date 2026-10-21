import { sourceColor } from "@shared/sources";
import {
  IconAmericanExpress,
  IconAutoAwesome,
  IconBloodtype,
  IconBolt,
  IconBuild,
  IconCircle,
  IconClaude,
  IconCleaningServices,
  IconCloudUpload,
  IconCode,
  type IconComponent,
  IconDeleteSweep,
  IconDiscord,
  IconEdit,
  IconFacebook,
  IconFavorite,
  IconFitbit,
  IconGitHub,
  IconGoogle,
  IconGoogleCalendar,
  IconGoogleChat,
  IconGoogleChrome,
  IconGoogleFit,
  IconGoogleKeep,
  IconGoogleMaps,
  IconGoogleMessages,
  IconGooglePlay,
  IconHub,
  IconImage,
  IconInbox,
  IconInstagram,
  IconLabel,
  IconLinkedIn,
  IconLocationOn,
  IconMenuBook,
  IconMinecraft,
  IconMonzo,
  IconOpenAI,
  IconPhone,
  IconReddit,
  IconScreenshotMonitor,
  IconSearch,
  IconSimpleSkype,
  IconSpotify,
  IconSteam,
  IconSwarm,
  IconTrakt,
  IconWakaTime,
  IconYouTube,
} from "../ui/icons";

// Shared source styling for event sources
// Brand colors are defined in the shared source registry and exposed here via
// inline styles (--source-color).
// CSS classes (.source-badge, .source-card, .source-icon) use color-mix()
// to derive background/border from the --source-color custom property

const SOURCE_ICONS: Record<string, IconComponent> = {
  // Music & Entertainment
  spotify: IconSpotify,
  youtube: IconYouTube,
  trakt: IconTrakt,

  // Social & Messaging
  discord: IconDiscord,
  reddit: IconReddit,
  linkedin: IconLinkedIn,
  facebook: IconFacebook,
  skype: IconSimpleSkype,
  live: IconSimpleSkype,
  instagram: IconInstagram,
  swarm: IconSwarm,

  // Google services
  google: IconGoogle,
  "google-location": IconLocationOn,
  "google-takeout": IconGoogle,
  "google-timeline": IconLocationOn,
  "google-fit": IconGoogleFit,
  "google-search": IconSearch,
  chrome: IconGoogleChrome,
  "google-calendar": IconGoogleCalendar,
  "google-keep": IconGoogleKeep,
  "google-chat": IconGoogleChat,
  "google-playstore": IconGooglePlay,
  "google-places": IconGoogleMaps,

  // Finance & Health
  amex: IconAmericanExpress,
  monzo: IconMonzo,
  fitbit: IconFitbit,
  "google-health": IconFavorite,
  thriva: IconBloodtype,

  // Coding & Dev tools
  wakatime: IconWakaTime,
  github: IconGitHub,
  claude: IconClaude,
  chatgpt: IconOpenAI,
  "claude-code": IconClaude,
  amp: IconBolt,
  opencode: IconBuild,
  conductor: IconAutoAwesome,
  t3code: IconCode,
  codex: IconOpenAI,

  // Gaming
  steam: IconSteam,
  minecraft: IconMinecraft,

  // Other
  journal: IconMenuBook,
  phone: IconPhone,
  "sms-backup-restore": IconPhone,
  "auto-detect": IconAutoAwesome,
  "google-messages": IconGoogleMessages,
  manual: IconEdit,
  thumbhash: IconImage,
  recall: IconScreenshotMonitor,
  backup: IconCloudUpload,
  "inbox-rclone": IconInbox,
  "attachment-descriptions": IconLabel,
  "render-sweep": IconCleaningServices,
  embeddings: IconHub,
  "media-evict": IconDeleteSweep,
};

const DEFAULT_ICON = IconCircle;
const SOURCE_FAMILY_KEYS = ["backup", "spotify", "steam"] as const;

function getSourceFamilyKey(source: string): string | null {
  for (const key of SOURCE_FAMILY_KEYS) {
    if (source === key || source.startsWith(`${key}-`)) return key;
  }
  return null;
}

export function getSourceIcon(source: string): IconComponent {
  if (Object.hasOwn(SOURCE_ICONS, source)) return SOURCE_ICONS[source];
  const familyKey = getSourceFamilyKey(source);
  if (familyKey) return SOURCE_ICONS[familyKey];
  return DEFAULT_ICON;
}

export function hasSourceIcon(source: string): boolean {
  return Object.hasOwn(SOURCE_ICONS, source) || getSourceFamilyKey(source) !== null;
}

// Get the actual color value for a source
export function getSourceColorValue(source: string): string {
  return sourceColor(source);
}

// For inline styles, set the --source-color custom property to actual color value
export function getSourceColorStyle(source: string): { "--source-color": string } {
  return { "--source-color": getSourceColorValue(source) };
}

export interface CssColors {
  text: string;
  bg: string;
}

// For map popups and other raw HTML contexts
export function getSourceCssColors(source: string): CssColors {
  const color = getSourceColorValue(source);
  return {
    text: color,
    bg: `color-mix(in srgb, ${color} 20%, transparent)`,
  };
}
