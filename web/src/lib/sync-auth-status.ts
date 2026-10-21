import type { SyncSourceInfo } from "./api";

export const syncStatusBadgeClass = "inline-flex items-center rounded-sm border border-current/30 bg-current/20 px-2 py-0.5 text-xs shrink-0";

export function syncAuthStatusBadge(status: SyncSourceInfo["authStatus"]): {
  label: string;
  tone: string;
} | null {
  if (status === "connected") return { label: "Connected", tone: "text-green-400" };
  if (status === "needs-reauth") return { label: "Re-auth required", tone: "text-yellow-400" };
  if (status === "not-configured") return { label: "Not configured", tone: "text-muted-foreground" };
  return null;
}
