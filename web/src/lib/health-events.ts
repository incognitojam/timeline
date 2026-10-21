import type { TimelineEvent } from "./types";

// google-health (the Fitbit successor) records the same sleep nights as the
// legacy `fitbit` source. Both are ingested, so the timeline must prefer one to
// avoid showing each night twice. We treat google-health as canonical.

const SLEEP_TYPES = new Set(["sleep", "sleep:nap"]);

type SourcedEvent = Pick<TimelineEvent, "source" | "type">;

/** True if the day contains a google-health sleep/nap event. */
export function dayHasGoogleHealthSleep(events: readonly SourcedEvent[]): boolean {
  return events.some((e) => e.source === "google-health" && SLEEP_TYPES.has(e.type));
}

/** True if the event is a legacy fitbit sleep/nap (the duplicate to suppress). */
export function isFitbitSleep(event: SourcedEvent): boolean {
  return event.source === "fitbit" && SLEEP_TYPES.has(event.type);
}

// Daily health metrics render in the health panel rather than the event stream.
const DAILY_HEALTH_METRIC_TYPES = new Set([
  "daily:activity",
  "daily:heart",
  "daily:hrv",
  "daily:spo2",
  "daily:breathing",
  "daily:temperature",
  "daily:vo2max",
  "daily:azm",
  "daily:weight",
]);

/** True if the event is a daily health metric from either health source. */
export function isDailyHealthMetric(event: SourcedEvent): boolean {
  return DAILY_HEALTH_METRIC_TYPES.has(event.type);
}
