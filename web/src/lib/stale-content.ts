export const STALE_CONTENT_CLASS = "opacity-50 pointer-events-none";

export function staleContentClass(isStale: boolean): string {
  return isStale ? STALE_CONTENT_CLASS : "";
}
