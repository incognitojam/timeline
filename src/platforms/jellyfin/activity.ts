import type { Database } from "../../db/sqlite";
import { z } from "zod";

import { sessionInstants } from "./parser";
import { compact, guidPattern } from "./ids";

export const guid = z.string().regex(guidPattern);

const mediaType = {
  Movie: "jellyfin:movie",
  Episode: "jellyfin:episode",
  "MediaBrowser.Controller.Entities.Movies.Movie": "jellyfin:movie",
  "MediaBrowser.Controller.Entities.TV.Episode": "jellyfin:episode",
} as const;

const item = z.strictObject({
  Type: z.enum(Object.keys(mediaType) as [keyof typeof mediaType, ...(keyof typeof mediaType)[]]),
  Name: z.string().nullable(),
  ProductionYear: z.int().nullable(),
  SeriesName: z.string().nullable(),
  SeriesId: guid.nullable(),
  ParentIndexNumber: z.int().nullable(),
  IndexNumber: z.int().nullable(),
  RunTimeTicks: z.int().nonnegative().nullable(),
  ProviderIds: z.record(z.string(), z.string()),
});
export const activityRow = z.strictObject({
  Id: z.int().positive(),
  Type: z.enum(["VideoPlayback", "VideoPlaybackStopped"]),
  // SQLite stores these UTC DateTime values without a mandatory suffix.
  DateCreated: z.string().regex(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,7})?Z?$/),
  UserId: guid,
  ItemId: z.union([guid, z.literal(""), z.null()]),
  Name: z.string().min(1),
  item: item.nullable(),
});
export type ActivityRow = z.infer<typeof activityRow>;

export function utc(row: ActivityRow) {
  const value = row.DateCreated.replace(" ", "T").replace(/Z$/, "");
  const [seconds, fraction = ""] = value.split(".");
  const iso = seconds + "." + fraction.padEnd(7, "0") + "Z";
  const ms = Date.parse(iso.slice(0, 23) + "Z");
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== seconds)
    throw new Error("Invalid UTC activity date");
  return { iso, ms };
}

function observation(row: ActivityRow) {
  const time = utc(row);
  const verb = row.Type === "VideoPlayback" ? " is playing " : " has finished playing ";
  const parts = row.Name.split(verb);
  const description = parts.length === 2 ? parts[1] : null;
  const details = description?.split(" on ");
  const title = row.item?.Name;
  const series = row.item?.SeriesName;
  const prefix = (series && title ? [series + " - " + title, title] : [title])
    .filter(Boolean)
    .map((name) => name + " on ")
    .find((candidate) => description?.startsWith(candidate));
  const device = prefix && description ? description.slice(prefix.length) : details?.length === 2 ? details[1] : null;
  return { row, ...time, device, description };
}
type Observation = ReturnType<typeof observation>;
const compatible = (a: string | null, b: string | null) => !a || !b || a === b;

function pair(observations: Observation[]) {
  const stops = new Map<number, Observation>();
  const open = new Map<string, { start: Observation; ambiguous: boolean }[]>();
  for (const obs of observations) {
    if (!obs.row.ItemId) continue;
    const key = compact(obs.row.ItemId);
    const active = (open.get(key) ?? []).filter((p) => obs.ms - p.start.ms <= 12 * 3600000);
    open.set(key, active);
    const matches = active.filter(({ start }) => {
      if (start.device && obs.device) return start.device === obs.device;
      return compatible(start.description, obs.description);
    });
    if (obs.row.Type === "VideoPlayback") {
      for (const p of matches) p.ambiguous = true;
      active.push({ start: obs, ambiguous: matches.length > 0 });
    } else if (matches.length === 1) {
      const p = matches[0];
      if (!p.ambiguous && obs.iso > p.start.iso) stops.set(p.start.row.Id, obs);
      active.splice(active.indexOf(p), 1);
    } else if (matches.length > 1) {
      for (const p of matches) p.ambiguous = true;
      // One stop consumes one concurrent play. When the device is common to
      // all candidates they are interchangeable for subsequent stops.
      if (matches.every((p) => p.start.device === matches[0].start.device)) {
        active.splice(active.indexOf(matches[0]), 1);
      }
    }
  }
  return stops;
}

export function reconcileActivity(db: Database, account: string, zone: string, fileRows?: ReadonlySet<number>) {
  const [server, user] = account.split("/");
  const evidence = db
    .query<{ raw_data: string }, [string, string]>(
      "SELECT raw_data FROM jellyfin_activity_evidence WHERE server_id=? AND user_id=?",
    )
    .all(server, user);
  const counts = {
    eventsAdded: 0,
    eventsUpdated: 0,
    createdEstimated: 0,
    createdUnknown: 0,
    updatedEstimated: 0,
    updatedUnknown: 0,
    evidenceOnlyStops: 0,
    supersededRows: 0,
  };
  if (!evidence.length) return counts;
  const observations = evidence
    .map((e) => observation(JSON.parse(e.raw_data)))
    .sort((a, b) => a.iso.localeCompare(b.iso) || a.row.Id - b.row.Id);
  const stops = pair(observations);
  const sessions = db
    .query<
      { id: number; timestamp: string | null; local: string; item: string; device: string | null },
      [string]
    >(`SELECT id,timestamp,json_extract(raw_data,'$.session.DateCreated') AS local,
    json_extract(raw_data,'$.session.ItemId') AS item,json_extract(raw_data,'$.session.DeviceName') AS device FROM events
    WHERE source='jellyfin' AND source_account=? COLLATE NOCASE AND source_id LIKE 'session/%'`)
    .all(account);
  const starts = observations.filter((e) => e.row.Type === "VideoPlayback");
  const byItem = new Map<string, Observation[]>();
  for (const start of starts) {
    if (!start.row.ItemId) continue;
    const item = compact(start.row.ItemId);
    const current = byItem.get(item);
    if (current) current.push(start);
    else byItem.set(item, [start]);
  }
  const matched = new Set<number>();
  const timed = sessions
    .map((session) => ({
      ...session,
      instants: session.timestamp ? [Date.parse(session.timestamp)] : sessionInstants(session.local, zone),
    }))
    .filter((session) => session.instants.length)
    .sort((a, b) => a.instants[0] - b.instants[0] || a.id - b.id);
  for (const session of timed) {
    // The plugin records after playback begins. Match each row to the latest
    // compatible start still in progress, reserving that start only once.
    const candidates = byItem.get(compact(session.item)) ?? [];
    const choices = new Set<number>();
    for (const instant of session.instants) {
      let latest: Observation | undefined;
      let tied = false;
      for (const start of candidates) {
        const stop = stops.get(start.row.Id);
        if (start.ms > instant) break;
        if (instant - start.ms > 90000 || (stop && stop.ms < instant) || matched.has(start.row.Id)) continue;
        if (
          !compatible(start.device, session.device) ||
          (start.description && session.device && !start.description.endsWith(" on " + session.device))
        )
          continue;
        tied = latest?.iso === start.iso;
        latest = start;
      }
      if (tied) {
        choices.clear();
        break;
      }
      if (latest) choices.add(latest.row.Id);
    }
    if (choices.size === 1) for (const id of choices) matched.add(id);
  }
  const pairedStops = new Set([...stops.values()].map((obs) => obs.row.Id));
  for (const obs of observations) {
    if (fileRows?.has(obs.row.Id) && obs.row.Type === "VideoPlaybackStopped" && !pairedStops.has(obs.row.Id))
      counts.evidenceOnlyStops++;
  }
  for (const s of starts) {
    const id = "activity/" + s.row.Id;
    const stop = stops.get(s.row.Id);
    if (matched.has(s.row.Id)) {
      if (fileRows?.has(s.row.Id)) counts.supersededRows++;
      if (stop && fileRows?.has(stop.row.Id)) counts.supersededRows++;
      db.run("DELETE FROM events WHERE source='jellyfin' AND source_account=? AND source_id=?", [account, id]);
      continue;
    }
    const elapsed = stop ? stop.ms - s.ms : null;
    const raw = JSON.stringify({ start: s.row, stop: stop?.row ?? null, estimatedElapsedMs: elapsed });
    if (s.row.item && !Object.hasOwn(mediaType, s.row.item.Type))
      throw new Error("Unsupported Jellyfin item.Type in stored activity evidence");
    const type = s.row.item ? mediaType[s.row.item.Type] : "jellyfin:activity";
    const old = db
      .query<{ raw_data: string; type: string }, [string, string]>(
        "SELECT raw_data,type FROM events WHERE source='jellyfin' AND source_account=? AND source_id=?",
      )
      .get(account, id);
    if (old?.raw_data === raw && old.type === type) continue;
    const title = [s.row.item?.SeriesName, s.row.item?.Name].filter(Boolean).join(" — ") || s.row.Name;
    const label =
      elapsed === null ? "Playback started" : "Estimated elapsed time: " + Math.round(elapsed / 1000) + " seconds";
    db.run(
      `INSERT INTO events(source,source_account,source_id,type,timestamp,end_timestamp,title,content,raw_data)
      VALUES ('jellyfin',?,?,?,?,?,?,?,?) ON CONFLICT(source,source_id,source_account)
      DO UPDATE SET type=excluded.type,end_timestamp=excluded.end_timestamp,title=excluded.title,content=excluded.content,raw_data=excluded.raw_data`,
      [
        account,
        id,
        type,
        new Date(s.ms).toISOString(),
        stop ? new Date(stop.ms).toISOString() : null,
        title,
        label,
        raw,
      ],
    );
    if (old) {
      counts.eventsUpdated++;
      if (stop) counts.updatedEstimated++;
      else counts.updatedUnknown++;
    } else {
      counts.eventsAdded++;
      if (stop) counts.createdEstimated++;
      else counts.createdUnknown++;
    }
  }
  return counts;
}
