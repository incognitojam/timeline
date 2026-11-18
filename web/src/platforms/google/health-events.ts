import type { TimelineEvent } from "../../lib/types";
import { isSleepEvent, SLEEP_TYPES } from "./health/sleep";

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

/**
 * Drops the day's health events the event stream would show twice: daily
 * metrics, which the health panel shows, and legacy fitbit sleep on days
 * google-health (its successor, and the canonical source) recorded sleep too.
 */
export function withoutDuplicateHealthEvents<E extends Pick<TimelineEvent, "source" | "type">>(
  events: readonly E[],
): E[] {
  const hasGoogleHealthSleep = events.some(isSleepEvent);
  return events.filter(
    (e) =>
      !DAILY_HEALTH_METRIC_TYPES.has(e.type) &&
      !(hasGoogleHealthSleep && e.source === "fitbit" && SLEEP_TYPES.has(e.type)),
  );
}
