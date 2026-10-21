import {
  IconArchive,
  IconAttachFile,
  IconAudioFile,
  type IconComponent,
  IconDescription,
  IconDraft,
  IconImage,
  IconMovie,
  IconPictureAsPdf,
  IconSlideshow,
  IconTableChart,
} from "../ui/icons";

export function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/** Clock time in the viewer's locale ("08:52", "08:52 AM"). Empty for null. */
export function formatTime(ts: string | Date | null): string {
  if (!ts) return "";
  const date = ts instanceof Date ? ts : new Date(ts);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Precise short durations: "450ms", "3.2s", "1m 15s". For coarse h/m spans use formatDuration. */
export function formatPreciseDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 0) {
    const absDiff = -diffMs;
    if (absDiff < 60_000) return "in <1m";
    if (absDiff < 3600_000) return `in ${Math.floor(absDiff / 60_000)}m`;
    if (absDiff < 86400_000) return `in ${Math.floor(absDiff / 3600_000)}h`;
    return `in ${Math.floor(absDiff / 86400_000)}d`;
  }

  if (diffMs < 60_000) return "<1m ago";
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;
  return `${Math.floor(diffMs / 86400_000)}d ago`;
}

// Relative date at day granularity: "today"/"yesterday"/"3d ago", then an
// absolute "Mar 5" within a year and "Mar 2024" beyond. Sibling of
// formatRelativeTime, which is minute/hour granular. Empty string for null.
export function formatRelativeDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const diffDays = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** Full date shared by conversation date dividers and message source links. */
export function formatDateSeparator(timestamp: string | Date | null): string {
  if (!timestamp) return "";
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return date.toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatIntervalMs(ms: number): string {
  if (ms >= 86400_000) return `${ms / 86400_000}d`;
  if (ms >= 3600_000) return `${ms / 3600_000}h`;
  if (ms >= 60_000) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Compact token counts for usage stats: 950 -> "950", 12_340 -> "12.3k",
// 1_234_000 -> "1.23M", 2_400_000_000 -> "2.4B". Distinct from
// formatContextLength (llmModels.ts), which assumes round power-of-two sizes.
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [divisor, suffix] of units) {
    if (tokens >= divisor) {
      const value = tokens / divisor;
      const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
      return `${parseFloat(value.toFixed(digits))}${suffix}`;
    }
  }
  return String(tokens);
}

export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

export function getFileIcon(
  fileName: string | null | undefined,
  mimeType?: string | null,
): IconComponent {
  const mime = mimeType?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return IconImage;
  if (mime.startsWith("video/")) return IconMovie;
  if (mime.startsWith("audio/")) return IconAudioFile;
  if (mime === "application/pdf") return IconPictureAsPdf;

  const ext = fileName?.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic"].includes(ext)) return IconImage;
  if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) return IconMovie;
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return IconAudioFile;
  if (ext === "pdf") return IconPictureAsPdf;
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return IconArchive;
  if (["doc", "docx", "odt", "rtf"].includes(ext)) return IconDescription;
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return IconTableChart;
  if (["ppt", "pptx", "odp"].includes(ext)) return IconSlideshow;
  if (["txt", "md", "log"].includes(ext)) return IconDraft;
  return IconAttachFile;
}

// First + last initial of a person's name ("Alice Middle Example" -> "AE"),
// falling back to the first two characters of a single-word name. Shared by
// Avatar and other person avatars so initials stay consistent across the app.
export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

// Discord's guild acronym for an iconless server: collapse a possessive "'s ",
// replace each word with its first character, then strip spaces — keeping
// hyphens, emoji, and the original casing. This is Discord's own Guild.acronym,
// so our placeholder reads identically to the client:
//   "Example's Widget-o-matic" -> "EW-o-m", "My Cool Server" -> "MCS".
// Like Discord it uses ASCII \w, so non-Latin names pass through unshortened.
export function guildAcronym(name: string, fallback = "#"): string {
  const acronym = name
    .replace(/'s /g, " ")
    .replace(/\w+/g, (word) => word[0])
    .replace(/\s/g, "");
  return acronym || fallback;
}
