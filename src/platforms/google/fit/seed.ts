import type { SeedSource } from "../../../seed/context";
import { GOOGLE_ACCOUNT } from "../seed-data/google-data";
import { locationPlan, type MoveMode, timelineSplitIndex } from "../seed-data/location-plan";

/** Google Fit activity codes (see ACTIVITY_TYPES in src/platforms/google/fit/parser.ts). */
const CODE = { biking: 1, still: 3, inVehicle: 5, walking: 7, running: 8, hiking: 42, strength: 89, yoga: 112 } as const;

const MOVE_CODES: Partial<Record<MoveMode, number>> = {
  WALKING: CODE.walking,
  RUNNING: CODE.running,
  CYCLING: CODE.biking,
  IN_PASSENGER_VEHICLE: CODE.inVehicle,
};

interface FitPoint {
  fitValue: { value: { intVal: number } }[];
  originDataSourceId: string;
  endTimeNanos: string;
  dataTypeName: string;
  startTimeNanos: string;
  modifiedTimeMillis: string;
}

const nanos = (ms: number) => `${ms}000000`;

/**
 * Takeout "Fit/All Data" merged activity segments, derived from the shared
 * location plan (commute walks and rides, runs, hikes, longer drives) plus
 * yoga/strength sessions logged at home. Alex used Fit for the older half of
 * the range, before Fitbit/Google Health took over.
 */
export const googleFitSeed: SeedSource = {
  name: "google-fit",
  produces: {
    "google-fit": ["activity:walking", "activity:running", "activity:biking", "activity:hiking", "activity:in-vehicle", "activity:yoga", "activity:strength-training"],
  },
  async seed(ctx) {
    const rng = ctx.rng("google-fit");
    const plan = locationPlan(ctx);
    const splitDay = ctx.days[timelineSplitIndex(ctx)];
    if (!splitDay) throw new Error("Seed range too short for a Fit cutoff");
    const cutoff = ctx.localDate(splitDay.date, 0).getTime();
    const points: FitPoint[] = [];
    const origin = "derived:com.google.activity.segment:com.google.android.gms:merge_activity_segments";

    const push = (code: number, start: number, end: number) => {
      points.push({
        fitValue: [{ value: { intVal: code } }],
        originDataSourceId: origin,
        endTimeNanos: nanos(end),
        dataTypeName: "com.google.activity.segment",
        startTimeNanos: nanos(start),
        modifiedTimeMillis: String(end + rng.int(60, 3600) * 1000),
      });
    };

    for (const segment of plan.segments) {
      const start = segment.start.getTime();
      if (start >= cutoff) break;
      const end = segment.end.getTime();
      if (segment.kind === "move") {
        const code = MOVE_CODES[segment.mode];
        if (code === undefined) continue;
        if (code === CODE.walking && end - start < 8 * 60_000) continue;
        if (code === CODE.inVehicle && segment.distanceM < 20_000) continue;
        push(code, start, end);
      } else if (segment.place.category === "Trailhead") {
        push(CODE.hiking, start + rng.int(5, 15) * 60_000, end - rng.int(5, 15) * 60_000);
      } else if (rng.chance(0.08)) {
        // Fit also records "still" stretches; the importer skips them.
        push(CODE.still, start, Math.min(end, start + 3_600_000));
      }
    }

    for (const day of ctx.days) {
      const t0 = ctx.localDate(day.date, 0).getTime();
      if (t0 >= cutoff) break;
      if (rng.chance(day.isWeekend ? 0.16 : 0.1)) {
        const start = ctx.localDate(day.date, 7, rng.int(0, 50)).getTime();
        push(rng.chance(0.6) ? CODE.yoga : CODE.strength, start, start + rng.int(20, 45) * 60_000);
      }
    }

    points.sort((a, b) => Number(a.startTimeNanos.slice(0, -6)) - Number(b.startTimeNanos.slice(0, -6)));
    ctx.writeStaged(
      "google-fit",
      "Takeout/Fit/All Data/derived_com.google.activity.segment_com.google.android.gms_merge_activity_segm.json",
      JSON.stringify({ "Data Source": { dataType: { name: "com.google.activity.segment" } }, "Data Points": points }, null, 1),
    );
    await ctx.runParserCli("platforms/google/fit/parser.ts", [ctx.stage("google-fit"), GOOGLE_ACCOUNT]);
  },
};
