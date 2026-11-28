export const guidPattern = /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i;
export const compact = (id: string) => id.toLowerCase().replaceAll("-", "");

export function ids(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && guidPattern.test(id))) {
    throw new Error("Expected a list of Jellyfin IDs");
  }
  return [...new Set<string>(value.map(compact))];
}
