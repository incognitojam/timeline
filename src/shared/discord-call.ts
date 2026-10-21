import { isRecord } from "./guards";

export interface DiscordCallEvent {
  source?: string;
  type?: string;
  source_account?: string | null;
  timestamp?: string | Date | null;
  raw_data?: unknown;
}

export interface DiscordCallDetails {
  participation: "answered" | "missed" | "unknown";
  durationMs: number | null;
}

function parseRawData(rawData: unknown): Record<string, unknown> | null {
  if (typeof rawData !== "string") return isRecord(rawData) ? rawData : null;
  try {
    const parsed: unknown = JSON.parse(rawData);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function timestampMs(timestamp: string | Date | null | undefined): number {
  if (timestamp instanceof Date) return timestamp.getTime();
  return Date.parse(timestamp ?? "");
}

/** Parse the participation state and elapsed time stored on a Discord call message. */
export function getDiscordCallDetails(event: DiscordCallEvent): DiscordCallDetails | null {
  if (
    event.source !== "discord" ||
    !event.type?.startsWith("message:") ||
    !event.type.endsWith(":call")
  ) {
    return null;
  }

  const raw = parseRawData(event.raw_data);
  const call = isRecord(raw?.call) ? raw.call : null;
  const participants = Array.isArray(call?.participants)
    ? call.participants.filter((participant): participant is string => typeof participant === "string")
    : null;
  const participation = participants && event.source_account
    ? participants.includes(event.source_account) ? "answered" : "missed"
    : "unknown";

  const endedTimestamp = typeof call?.ended_timestamp === "string" ? call.ended_timestamp : null;
  const startedAt = timestampMs(event.timestamp);
  const endedAt = timestampMs(endedTimestamp);
  const durationMs = Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt
    ? endedAt - startedAt
    : null;

  return { participation, durationMs };
}
