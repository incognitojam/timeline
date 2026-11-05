import type { PlatformSource } from "../platforms/types";

/** A source that belongs to the app itself rather than to a platform. */
export type SystemSource = PlatformSource & { color: string };

const BACKUP_COLOR = "#64748b";

/** Built-in event sources, ingestion channels, and maintenance jobs. */
export const SYSTEM_SOURCES: readonly SystemSource[] = [
  { id: "journal", label: "Journal", color: "#8b5cf6", eventTypes: ["journal:qa", "journal:reflection"] },
  {
    id: "manual",
    label: "Manual",
    color: "#6366f1",
    eventTypes: [
      "note",
      "transport:train",
      "transport:flight",
      "transport:bus",
      "transport:taxi",
      "transport:car",
      "transport:tube",
      "transport:ferry",
      "transport:tram",
    ],
  },
  { id: "auto-detect", label: "Auto-detect", color: "#9ca3af" },
  { id: "inbox-rclone", label: "Inbox Sync", color: "#3b82f6" },
  { id: "google-places", label: "Google Places", color: "#34A853" },
  { id: "thumbhash", label: "ThumbHash", color: "#a78bfa" },
  { id: "attachment-descriptions", label: "Attachment Descriptions", color: "#c084fc" },
  { id: "render-sweep", label: "Render Sweep", color: "#94a3b8" },
  { id: "embeddings", label: "Embeddings", color: "#2dd4bf" },
  { id: "backup", label: "Backup", color: BACKUP_COLOR },
  { id: "backup-app-state", label: "App State Backup", color: BACKUP_COLOR },
  { id: "backup-offsite", label: "Offsite Backup", color: BACKUP_COLOR },
  { id: "media-evict", label: "Media Eviction", color: "#78716c" },
];
