import { importTimelineData } from "./parser-timeline";
import type { SeedContext, SeedSource } from "../../../seed/context";
import { GOOGLE_ACCOUNT } from "../seed-data/google-data";
import {
  latLngString,
  localIsoWithOffset,
  locationPlan,
  planPlaces,
  type PlanSegment,
  timelineSplitIndex,
} from "../seed-data/location-plan";

/**
 * On-device Google Maps Timeline export (Timeline.json, semanticSegments) for
 * the newer half of the range. Visits carry only place ids; the importer
 * names them from the `places` table, which a real install fills via
 * src/platforms/google/places/resolve.ts (Google Places API). That script needs the
 * network, so the same rows it would write are inserted directly.
 */
export const googleTimelineSeed: SeedSource = {
  name: "google-timeline",
  produces: { "google-location": ["location:visit", "location:transit"] },
  async seed(ctx) {
    const rng = ctx.rng("google-timeline");
    const plan = locationPlan(ctx);
    const splitDay = ctx.days[timelineSplitIndex(ctx)];
    if (!splitDay) throw new Error("Seed range too short for a location split");
    const split = ctx.localDate(splitDay.date, 0).getTime();

    const upsertPlace = ctx.db.prepare(`
      INSERT INTO places (place_id, name, address, lat, lng, source)
      VALUES (?, ?, ?, ?, ?, 'google-places-api')
      ON CONFLICT(place_id) DO UPDATE SET
        name = excluded.name, address = excluded.address, lat = excluded.lat, lng = excluded.lng, source = excluded.source
    `);
    ctx.db.transaction(() => {
      for (const p of planPlaces(plan)) upsertPlace.run(p.placeId, p.name, p.address, p.lat, p.lng);
    })();

    const semanticSegments: object[] = [];
    for (const segment of plan.segments) {
      if (segment.start.getTime() < split) continue;
      semanticSegments.push(toSemanticSegment(ctx, segment, rng.float(0.6, 0.98)));
      // The export interleaves raw path samples; the importer skips them.
      if (segment.kind === "move" && rng.chance(0.2)) {
        semanticSegments.push({
          startTime: localIsoWithOffset(ctx, segment.start),
          endTime: localIsoWithOffset(ctx, segment.end),
          timelinePath: [
            { point: latLngString(segment.from.lat, segment.from.lng), time: localIsoWithOffset(ctx, segment.start) },
            { point: latLngString(segment.to.lat, segment.to.lng), time: localIsoWithOffset(ctx, segment.end) },
          ],
        });
      }
    }

    const path = ctx.writeStaged(
      "google-timeline",
      "Timeline.json",
      JSON.stringify({ semanticSegments, rawSignals: [], userLocationProfile: { frequentPlaces: [] } }),
    );
    await importTimelineData(ctx.db, path, GOOGLE_ACCOUNT);
  },
};

function toSemanticSegment(ctx: SeedContext, segment: PlanSegment, probability: number): object {
  const offsetMinutes = (at: Date) => {
    const o = ctx.localOffset(at);
    const [hh, mm] = o.slice(1).split(":").map(Number) as [number, number];
    return (o.startsWith("-") ? -1 : 1) * (hh * 60 + mm);
  };
  const base = {
    startTime: localIsoWithOffset(ctx, segment.start),
    endTime: localIsoWithOffset(ctx, segment.end),
    startTimeTimezoneUtcOffsetMinutes: offsetMinutes(segment.start),
    endTimeTimezoneUtcOffsetMinutes: offsetMinutes(segment.end),
  };
  const p = Math.round(probability * 1e6) / 1e6;
  if (segment.kind === "visit") {
    return {
      ...base,
      visit: {
        hierarchyLevel: 0,
        probability: p,
        topCandidate: {
          placeId: segment.place.placeId,
          semanticType: segment.place.semantic,
          probability: Math.round(p * 0.9 * 1e6) / 1e6,
          placeLocation: { latLng: latLngString(segment.place.lat, segment.place.lng) },
        },
      },
    };
  }
  return {
    ...base,
    activity: {
      start: { latLng: latLngString(segment.from.lat, segment.from.lng) },
      end: { latLng: latLngString(segment.to.lat, segment.to.lng) },
      distanceMeters: segment.distanceM,
      probability: p,
      topCandidate: { type: segment.mode, probability: p },
    },
  };
}
