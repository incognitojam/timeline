import { formatDuration } from "./format";
import type { McpTransport } from "./api";

export function timestampToBrowserIso(timestamp: string): string {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(timestamp)) return timestamp;
  return `${timestamp.replace(" ", "T")}Z`;
}

export function formatAbsoluteTime(timestamp: string): string {
  const date = new Date(timestampToBrowserIso(timestamp));
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatCallDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return formatDuration(ms);
}

export function estimateTokens(chars: number): string {
  return `~${Math.round(chars / 4).toLocaleString()} tokens`;
}

export function transportClass(transport: McpTransport): string {
  return transport === "http"
    ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
    : "border-amber-500/30 bg-amber-500/10 text-amber-300";
}
