import { addDays } from "date-fns";
import {
  formatHealthDateOnly,
  type HealthDateRange,
  parseHealthDateOnly,
} from "./health-periods";

export type HealthDailyValueState = "recorded" | "missing" | "future";

export interface HealthDailyValue {
  date: string;
  value: number | null;
  state: HealthDailyValueState;
}

export interface HealthDailySummary {
  total: number;
  average: number | null;
  recordedDays: number;
  missingDays: number;
  futureDays: number;
  goalMetDays: number | null;
  byDay: HealthDailyValue[];
}

function validateValue(date: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid health value for ${date}: ${value}`);
  }
}

/**
 * Fill a daily range and summarize only recorded values. A recorded zero is
 * included in the average; missing and future dates are not.
 */
export function summarizeHealthDailyValues(values: {
  range: HealthDateRange;
  completeThrough: string;
  entries: readonly { date: string; value: number }[];
  goal?: number;
}): HealthDailySummary {
  const start = parseHealthDateOnly(values.range.start);
  const end = parseHealthDateOnly(values.range.end);
  parseHealthDateOnly(values.completeThrough);
  if (start > end) {
    throw new Error(`Invalid health range: ${values.range.start} to ${values.range.end}`);
  }
  if (values.goal !== undefined && (!Number.isFinite(values.goal) || values.goal <= 0)) {
    throw new Error(`Invalid health goal: ${values.goal}`);
  }

  const byDate = new Map<string, number>();
  for (const entry of values.entries) {
    parseHealthDateOnly(entry.date);
    validateValue(entry.date, entry.value);
    if (entry.date < values.range.start || entry.date > values.range.end) {
      throw new Error(`Health value for ${entry.date} falls outside the visible range`);
    }
    if (entry.date > values.completeThrough) {
      throw new Error(`Health value for ${entry.date} falls after completeThrough`);
    }
    if (byDate.has(entry.date)) {
      throw new Error(`Duplicate health value for ${entry.date}`);
    }
    byDate.set(entry.date, entry.value);
  }

  const byDay: HealthDailyValue[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const dateString = formatHealthDateOnly(date);
    if (dateString > values.completeThrough) {
      byDay.push({ date: dateString, value: null, state: "future" });
      continue;
    }
    const value = byDate.get(dateString);
    byDay.push(
      value === undefined
        ? { date: dateString, value: null, state: "missing" }
        : { date: dateString, value, state: "recorded" },
    );
  }

  const recorded = byDay.filter(
    (day): day is HealthDailyValue & { value: number } => day.state === "recorded",
  );
  const total = recorded.reduce((sum, day) => sum + day.value, 0);
  const goal = values.goal;

  return {
    total,
    average: recorded.length > 0 ? total / recorded.length : null,
    recordedDays: recorded.length,
    missingDays: byDay.filter((day) => day.state === "missing").length,
    futureDays: byDay.filter((day) => day.state === "future").length,
    goalMetDays: goal === undefined ? null : recorded.filter((day) => day.value >= goal).length,
    byDay,
  };
}
