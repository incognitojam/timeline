import { importGoogleLocation } from "../../parsers/google-location";
import type { SeedSource } from "../context";
import { GOOGLE_ACCOUNT } from "./google-data";
import { locationPlan, type PlanSegment, timelineSplitIndex } from "./google-location-plan";

const MONTH_NAMES = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

const e7 = (deg: number) => Math.round(deg * 1e7);

/**
 * Takeout "Location History (Timeline)/Semantic Location History" monthly
 * files for the older half of the range (the newer half comes from the
 * on-device Timeline.json export in google-timeline).
 */
export const googleLocationSeed: SeedSource = {
  name: "google-location",
  produces: { "google-location": ["location:visit", "location:transit"] },
  async seed(ctx) {
    const rng = ctx.rng("google-location");
    const plan = locationPlan(ctx);
    const splitDay = ctx.days[timelineSplitIndex(ctx)];
    if (!splitDay) throw new Error("Seed range too short for a location split");
    const split = ctx.localDate(splitDay.date, 0).getTime();

    const months = new Map<string, object[]>();
    for (const segment of plan.segments) {
      if (segment.start.getTime() >= split) break;
      const key = localMonthKey(ctx.localOffset(segment.start), segment.start);
      let list = months.get(key);
      if (!list) {
        list = [];
        months.set(key, list);
      }
      list.push(toTimelineObject(segment, rng.float(60, 99)));
    }

    const stage = ctx.stage("google-location");
    for (const [key, timelineObjects] of months) {
      const [year, month] = key.split("-") as [string, string];
      ctx.writeStaged(
        "google-location",
        `Takeout/Location History (Timeline)/Semantic Location History/${year}/${year}_${MONTH_NAMES[Number(month) - 1]}.json`,
        JSON.stringify({ timelineObjects }),
      );
    }
    await importGoogleLocation(ctx.db, stage, GOOGLE_ACCOUNT);
  },
};

function localMonthKey(offset: string, at: Date): string {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [hh, mm] = offset.slice(1).split(":").map(Number) as [number, number];
  return new Date(at.getTime() + sign * (hh * 60 + mm) * 60_000).toISOString().slice(0, 7);
}

function toTimelineObject(segment: PlanSegment, confidence: number): object {
  const duration = { startTimestamp: segment.start.toISOString(), endTimestamp: segment.end.toISOString() };
  if (segment.kind === "visit") {
    const p = segment.place;
    return {
      placeVisit: {
        location: {
          latitudeE7: e7(p.lat),
          longitudeE7: e7(p.lng),
          placeId: p.placeId,
          address: p.address,
          name: p.name,
          ...(p.semantic === "HOME" ? { semanticType: "TYPE_HOME" } : p.semantic === "WORK" ? { semanticType: "TYPE_WORK" } : {}),
          sourceInfo: { deviceTag: 1_482_335_190 },
          locationConfidence: Math.round(confidence * 10) / 10,
        },
        duration,
        placeConfidence: confidence > 75 ? "HIGH_CONFIDENCE" : "MEDIUM_CONFIDENCE",
        centerLatE7: e7(p.lat),
        centerLngE7: e7(p.lng),
        visitConfidence: Math.round(confidence),
        locationAssertionType: "ASSERTION_TYPE_UNSPECIFIED",
      },
    };
  }
  return {
    activitySegment: {
      startLocation: { latitudeE7: e7(segment.from.lat), longitudeE7: e7(segment.from.lng), sourceInfo: { deviceTag: 1_482_335_190 } },
      endLocation: { latitudeE7: e7(segment.to.lat), longitudeE7: e7(segment.to.lng), sourceInfo: { deviceTag: 1_482_335_190 } },
      duration,
      distance: segment.distanceM,
      activityType: segment.mode,
      confidence: confidence > 70 ? "HIGH" : "MEDIUM",
      activities: [
        { activityType: segment.mode, probability: Math.round(confidence * 10) / 10 },
        { activityType: segment.mode === "WALKING" ? "IN_BUS" : "WALKING", probability: Math.round((100 - confidence) * 7) / 10 },
      ],
    },
  };
}
