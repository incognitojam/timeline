import { getDb } from "../../db/schema";
import { getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import type { SyncSource } from "../../sync/types";
import { columns, saveSession, sessionRow, type Item } from "./parser";

function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (id) => typeof id === "string" && /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(id),
    )
  ) {
    throw new Error("Expected a list of Jellyfin IDs");
  }
  return [...new Set<string>(value.map((id) => id.replaceAll("-", "").toLowerCase()))];
}

function settings(config: Record<string, unknown> = {}) {
  const users = ids(config.users);
  if (!users.length) throw new Error("Select at least one Jellyfin user ID");
  const libraries = ids(config.libraries ?? []);
  const zone = config.timezone;
  if (typeof zone !== "string" || !zone) throw new Error("Set the Jellyfin server time zone");
  new Intl.DateTimeFormat("en", { timeZone: zone });
  const url = new URL(String(config.url));
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Invalid Jellyfin server URL");
  const token = process.env.JELLYFIN_TOKEN;
  if (!token) throw new Error("Set JELLYFIN_TOKEN in the service secrets");
  return { users, libraries, zone, base: url.href.replace(/\/$/, ""), token };
}

async function loadItems(
  request: (path: string) => Promise<{ Items: Item[] } | Item[]>,
  user: string,
  itemIds: string[],
  libraries: string[],
) {
  const metadata = new Map<string, Item>();

  const query = new URLSearchParams({
    userId: user,
    ids: itemIds.join(","),
    fields: "ProviderIds",
    enableUserData: "false",
    recursive: "true",
  });

  const page = await request("/Items?" + query);
  if (Array.isArray(page) || !Array.isArray(page.Items)) throw new Error("Invalid Jellyfin items response");
  for (const item of page.Items) {
    if (typeof item.Id !== "string" || !itemIds.includes(item.Id.replaceAll("-", "").toLowerCase()))
      throw new Error("Unexpected Jellyfin item");
    if (libraries.length) {
      const ancestors = await request("/Items/" + item.Id + "/Ancestors?userId=" + user);
      if (!Array.isArray(ancestors)) throw new Error("Invalid Jellyfin ancestors response");
      if (!ancestors.some((parent) => libraries.includes(parent.Id.replaceAll("-", "").toLowerCase()))) continue;
    }
    const { Id, Name, SeriesName, SeriesId, ParentIndexNumber, IndexNumber, ProductionYear, ProviderIds } = item;
    metadata.set(Id.replaceAll("-", "").toLowerCase(), {
      Id,
      Name,
      SeriesName,
      SeriesId,
      ParentIndexNumber,
      IndexNumber,
      ProductionYear,
      ProviderIds,
    });
  }
  return metadata;
}

export const jellyfinSyncSource: SyncSource = {
  name: "jellyfin",
  description: "Import movie and episode sessions from Playback Reporting",
  enabled: true,
  defaultInterval: "1d",
  configSchema: [
    { key: "url", type: "string", label: "Server URL", required: true },
    { key: "users", type: "string-list", label: "User IDs to import", required: true },
    { key: "timezone", type: "string", label: "Server time zone", required: true, placeholder: "Europe/London" },
    { key: "libraries", type: "string-list", label: "Library IDs (optional)" },
  ],
  async canSync(config) {
    try {
      settings(config);
      return null;
    } catch (error) {
      return String(error);
    }
  },
  async sync(options) {
    const started = Date.now();
    let eventsAdded = 0,
      eventsUpdated = 0;
    try {
      const { users, libraries, base, token, zone } = settings(options.config.sources.jellyfin);
      const cooldown = "jellyfin/retry/" + base;
      const retryAt = getSyncState<number>(getAppStateDb(), cooldown);
      if (retryAt && started < retryAt) {
        return {
          source: "jellyfin",
          success: true,
          skipped: true,
          eventsAdded,
          eventsUpdated,
          durationMs: Date.now() - started,
          metadata: { skipReason: "Jellyfin requested a later retry" },
        };
      }
      async function request(path: string, body?: object) {
        const response = await fetch(base + path, {
          method: body ? "POST" : "GET",
          redirect: "error",
          signal: options.signal,
          headers: { Authorization: 'MediaBrowser Token="' + token + '"', "Content-Type": "application/json" },
          body: body && JSON.stringify(body),
        });
        if (response.status === 429) {
          const retry = response.headers.get("Retry-After");
          if (retry) {
            const until = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
            if (Number.isFinite(until)) setSyncState(getAppStateDb(), cooldown, until);
          }
        }
        if (!response.ok) throw new Error("Jellyfin HTTP " + response.status);
        return response.json();
      }
      const { Id: server } = await request("/System/Info/Public");
      if (typeof server !== "string" || !server) throw new Error("Missing Jellyfin server ID");
      for (const user of users) {
        const account = server + "/" + user;
        const key = "jellyfin/sessions/" + account;
        const state = getSyncState<{ lastFull: number; latestDay: string; filter: string }>(getAppStateDb(), key);
        const filter = JSON.stringify([libraries.sort(), zone]);
        const full = !state || state.filter !== filter || started - state.lastFull >= 7 * 86400000;
        let latestDay = full ? "" : state.latestDay;
        if (latestDay && !/^\d{4}-\d{2}-\d{2}$/.test(latestDay)) throw new Error("Invalid Jellyfin checkpoint");
        const since = latestDay ? `AND DateCreated >= date('${latestDay}', '-2 days')` : "";
        let cursor = 0;
        for (;;) {
          const sql = `SELECT rowid AS RowId, ${columns.slice(1).join(", ")}
            FROM PlaybackActivity WHERE UserId='${user}' AND ItemType IN ('Movie','Episode')
            ${since} AND rowid > ${cursor} ORDER BY rowid LIMIT 100`;
          const page = await request("/user_usage_stats/submit_custom_query", {
            CustomQueryString: sql,
            ReplaceUserId: false,
          });
          if (
            !Array.isArray(page.results) ||
            (page.message &&
              !(page.results.length === 0 && page.message.startsWith("Query executed, no data returned.")))
          )
            throw new Error("Playback Reporting query failed");
          if (!page.results.length) break;
          if (JSON.stringify(page.colums) !== JSON.stringify(columns))
            throw new Error("Unexpected Playback Reporting columns");
          const rows = page.results.map((value: unknown) => sessionRow(value, user)) as ReturnType<typeof sessionRow>[];
          const itemIds = [...new Set(rows.map((row) => row.ItemId))];
          const metadata = await loadItems(request, user, itemIds, libraries);
          const changes = getDb().transaction(() => {
            let added = 0;
            let updated = 0;
            for (const row of rows) {
              const next = Number(row.RowId);
              if (!Number.isSafeInteger(next) || next <= cursor)
                throw new Error("Invalid Playback Reporting row order");
              cursor = next;
              const day = row.DateCreated.slice(0, 10);
              if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Invalid Jellyfin session date");
              if (day > latestDay) latestDay = day;
              const item = metadata.get(row.ItemId);
              if (libraries.length && !item) continue;
              const saved = saveSession(getDb(), account, row, zone, item);
              added += saved.added;
              updated += saved.updated;
            }
            return { added, updated };
          })();
          eventsAdded += changes.added;
          eventsUpdated += changes.updated;
          if (rows.length < 100) break;
        }
        setSyncState(getAppStateDb(), key, { latestDay, lastFull: full ? started : state.lastFull, filter });
      }
      return { source: "jellyfin", success: true, eventsAdded, eventsUpdated, durationMs: Date.now() - started };
    } catch (error) {
      return {
        source: "jellyfin",
        success: false,
        eventsAdded,
        eventsUpdated,
        durationMs: Date.now() - started,
        error: String(error),
      };
    }
  },
};
