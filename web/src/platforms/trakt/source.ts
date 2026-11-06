const TRAKT_APPLICATION_NAMES: Record<number, string> = {
  6231: "Stremio",
  59843: "Jellyfin",
  135918: "Trakt for Web",
  174635: "timeline-mcp",
};

type TraktAction = "scrobble" | "watch" | "checkin";

const ACTION_VERBS: Record<TraktAction, string> = {
  scrobble: "scrobbled",
  watch: "marked watched",
  checkin: "checked in",
};

function isTraktAction(value: unknown): value is TraktAction {
  return value === "scrobble" || value === "watch" || value === "checkin";
}

export function describeTraktSource(rawData: string | null | undefined): string | null {
  if (!rawData) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const data = parsed as { action?: unknown; application?: unknown };
  if (!isTraktAction(data.action)) return null;
  const verb = ACTION_VERBS[data.action];

  const app = data.application;
  const appId =
    app && typeof app === "object" && "id" in app
      ? (app as { id?: unknown }).id
      : null;

  if (typeof appId === "number" && appId > 0) {
    const name = TRAKT_APPLICATION_NAMES[appId];
    return name ? `${verb} via ${name}` : `${verb} via app #${appId}`;
  }
  return verb;
}
