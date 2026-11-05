import { sourceColor } from "@shared/sources";
import {
  IconAutoAwesome,
  IconCircle,
  IconCleaningServices,
  IconCloudUpload,
  type IconComponent,
  IconDeleteSweep,
  IconEdit,
  IconGoogleMaps,
  IconHub,
  IconImage,
  IconInbox,
  IconLabel,
  IconMenuBook,
} from "../ui/icons";
import { PLATFORM_DISPLAYS } from "../platforms";
import type { PlatformDisplay } from "../platforms/types";

// Shared source styling for event sources
// Brand colors are defined in the shared source registry and exposed here via
// inline styles (--source-color).
// CSS classes (.source-badge, .source-card, .source-icon) use color-mix()
// to derive background/border from the --source-color custom property

export function buildSourceIcons(
  displays: readonly PlatformDisplay[],
  system: Readonly<Record<string, IconComponent>>,
): Record<string, IconComponent> {
  const icons = { ...system };
  for (const display of displays) {
    for (const source of display.meta.sources) {
      icons[source.id] = display.sourceIcons?.[source.id] ?? display.icon;
    }
  }
  return icons;
}

// Icons for sources that belong to the app rather than to a platform.
const SYSTEM_SOURCE_ICONS: Record<string, IconComponent> = {
  journal: IconMenuBook,
  manual: IconEdit,
  "auto-detect": IconAutoAwesome,
  "inbox-rclone": IconInbox,
  "google-places": IconGoogleMaps,
  thumbhash: IconImage,
  "attachment-descriptions": IconLabel,
  "render-sweep": IconCleaningServices,
  embeddings: IconHub,
  backup: IconCloudUpload,
  "backup-app-state": IconCloudUpload,
  "backup-offsite": IconCloudUpload,
  "media-evict": IconDeleteSweep,
};

const SOURCE_ICONS = buildSourceIcons(PLATFORM_DISPLAYS, SYSTEM_SOURCE_ICONS);
const DEFAULT_ICON = IconCircle;

export function getSourceIcon(source: string): IconComponent {
  return Object.hasOwn(SOURCE_ICONS, source) ? SOURCE_ICONS[source] : DEFAULT_ICON;
}

export function hasSourceIcon(source: string): boolean {
  return Object.hasOwn(SOURCE_ICONS, source);
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
