export interface SourceDefinition {
  id: string;
  label: string;
  color: string;
}

type SourceRegistration = { id: string; label: string } & (
  | { color: string; colorFrom?: never }
  | { colorFrom: string; color?: never }
);

export const DEFAULT_SOURCE_COLOR = "#9ca3af";

/**
 * Source metadata shared by the service and web app. IDs are persisted in the
 * database and used in URLs; labels are presentation-only.
 */
const SOURCE_REGISTRATIONS = [
  // Music and entertainment
  { id: "spotify", label: "Spotify", color: "#1DB954" },
  { id: "spotify-friends", label: "Spotify Friends", colorFrom: "spotify" },
  { id: "spotify-playlists", label: "Spotify Playlists", colorFrom: "spotify" },
  { id: "youtube", label: "YouTube", color: "#FF0000" },
  { id: "trakt", label: "Trakt", color: "#ED1C24" },

  // Social and messaging
  { id: "discord", label: "Discord", color: "#5865F2" },
  { id: "reddit", label: "Reddit", color: "#FF4500" },
  { id: "linkedin", label: "LinkedIn", color: "#0A66C2" },
  { id: "facebook", label: "Facebook", color: "#1877F2" },
  { id: "skype", label: "Skype", color: "#00AFF0" },
  { id: "live", label: "Microsoft Live", colorFrom: "skype" },
  { id: "instagram", label: "Instagram", color: "#E4405F" },
  { id: "swarm", label: "Swarm", color: "#FFA633" },

  // Google services
  { id: "google", label: "Google", color: "#EA4335" },
  { id: "google-calendar", label: "Google Calendar", color: "#4285F4" },
  { id: "google-keep", label: "Google Keep", color: "#E37400" },
  { id: "google-chat", label: "Google Chat", color: "#00AC47" },
  { id: "google-fit", label: "Google Fit", color: "#4285F4" },
  { id: "google-search", label: "Google Search", color: "#4285F4" },
  { id: "google-location", label: "Google Location", colorFrom: "google" },
  { id: "google-playstore", label: "Google Play Store", color: "#01875f" },
  { id: "google-places", label: "Google Places", color: "#34A853" },
  { id: "google-messages", label: "Google Messages", color: "#1A73E8" },
  { id: "google-takeout", label: "Google Takeout", colorFrom: "google" },
  { id: "google-timeline", label: "Google Timeline", colorFrom: "google" },
  { id: "chrome", label: "Chrome", color: "#D99200" },

  // Finance and health
  { id: "amex", label: "American Express", color: "#006FCF" },
  { id: "monzo", label: "Monzo", color: "#FF5F5F" },
  { id: "fitbit", label: "Fitbit", color: "#00B0B9" },
  { id: "google-health", label: "Google Health", color: "#00B0B9" },
  { id: "thriva", label: "Thriva", color: "#9856c8" },

  // Coding and developer tools
  { id: "wakatime", label: "WakaTime", color: "#2595ff" },
  { id: "github", label: "GitHub", color: "#8b949e" },
  { id: "claude", label: "Claude", color: "#D97757" },
  { id: "chatgpt", label: "ChatGPT", color: "#10A37F" },
  { id: "claude-code", label: "Claude Code", colorFrom: "claude" },
  { id: "amp", label: "Amp", color: "#f87171" },
  { id: "opencode", label: "OpenCode", color: "#9ca3af" },
  { id: "conductor", label: "Conductor", color: "#a4847f" },
  { id: "t3code", label: "T3 Code", color: "#8e51ff" },
  { id: "codex", label: "Codex", color: "#74c69d" },

  // Gaming
  { id: "steam", label: "Steam", color: "#66c0f4" },
  { id: "minecraft", label: "Minecraft", color: "#62B047" },

  // Local and operational sources
  { id: "journal", label: "Journal", color: "#8b5cf6" },
  { id: "phone", label: "Phone", color: "#2dd4bf" },
  { id: "sms-backup-restore", label: "SMS Backup & Restore", colorFrom: "phone" },
  { id: "manual", label: "Manual", color: "#6366f1" },
  { id: "auto-detect", label: "Auto-detect", color: "#9ca3af" },
  { id: "thumbhash", label: "ThumbHash", color: "#a78bfa" },
  { id: "recall", label: "Recall", color: "#7c8aa3" },
  { id: "backup", label: "Backup", color: "#64748b" },
  { id: "backup-app-state", label: "App State Backup", colorFrom: "backup" },
  { id: "backup-offsite", label: "Offsite Backup", colorFrom: "backup" },
  { id: "inbox-rclone", label: "Inbox Sync", color: "#3b82f6" },
  { id: "attachment-descriptions", label: "Attachment Descriptions", color: "#c084fc" },
  { id: "render-sweep", label: "Render Sweep", color: "#94a3b8" },
  { id: "embeddings", label: "Embeddings", color: "#2dd4bf" },
  { id: "media-evict", label: "Media Eviction", color: "#78716c" },
] as const satisfies readonly SourceRegistration[];

const SOURCES_BY_ID = new Map<string, SourceDefinition>();

export const SOURCE_REGISTRY: readonly SourceDefinition[] = SOURCE_REGISTRATIONS.map((source) => {
  let color: string;
  if ("color" in source) {
    color = source.color;
  } else {
    const parent = SOURCES_BY_ID.get(source.colorFrom);
    if (!parent) {
      throw new Error(`Source ${source.id} inherits color from unknown source ${source.colorFrom}`);
    }
    color = parent.color;
  }

  const definition = { id: source.id, label: source.label, color };
  SOURCES_BY_ID.set(source.id, definition);
  return definition;
});
const SOURCE_COLOR_FAMILIES = ["backup", "spotify", "steam", "google"] as const;

export function getSourceDefinition(id: string): SourceDefinition | undefined {
  return SOURCES_BY_ID.get(id);
}

/** Unknown IDs stay visible so newly imported sources fail loudly in the UI. */
export function sourceLabel(id: string): string {
  return getSourceDefinition(id)?.label ?? id;
}

export function sourceColor(id: string): string {
  const exact = getSourceDefinition(id);
  if (exact) return exact.color;

  for (const family of SOURCE_COLOR_FAMILIES) {
    if (id.startsWith(`${family}-`)) return getSourceDefinition(family)?.color ?? DEFAULT_SOURCE_COLOR;
  }

  return DEFAULT_SOURCE_COLOR;
}

export function isRegisteredSource(id: string): boolean {
  return SOURCES_BY_ID.has(id);
}
