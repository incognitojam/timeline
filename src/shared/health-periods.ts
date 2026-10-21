import {
  addDays,
  addMonths,
  addQuarters,
  addWeeks,
  addYears,
  endOfISOWeek,
  endOfMonth,
  endOfQuarter,
  endOfYear,
  format,
  startOfISOWeek,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  subDays,
  subMonths,
  subWeeks,
} from "date-fns";

export interface HealthDateRange {
  start: string;
  end: string;
}

export type HealthWindowView = "day" | "week" | "month" | "quarter" | "year";
export type HealthWindowMode = "recent" | "calendar";
export type HealthBucketUnit = "hour" | "day" | "week" | "month";

export interface HealthWindow {
  view: HealthWindowView;
  mode: HealthWindowMode;
  anchor: string;
  range: HealthDateRange;
  bucket: HealthBucketUnit;
}

export interface HealthWindowSelection {
  view: HealthWindowView;
  mode: HealthWindowMode;
  anchor: string;
}

export const HEALTH_WINDOW_ERROR =
  "Missing or invalid health window. Use ?view=day|week|month|quarter|year&mode=recent|calendar&anchor=YYYY-MM-DD";

const HEALTH_WINDOW_VIEWS = new Set<HealthWindowView>([
  "day",
  "week",
  "month",
  "quarter",
  "year",
]);
const HEALTH_WINDOW_MODES = new Set<HealthWindowMode>(["recent", "calendar"]);

export function parseHealthDateOnly(value: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid health date: ${value}`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000) throw new Error(`Invalid health date: ${value}`);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(`Invalid health date: ${value}`);
  }
  return date;
}

export function formatHealthDateOnly(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function bucketForView(view: HealthWindowView): HealthBucketUnit {
  switch (view) {
    case "day":
      return "hour";
    case "week":
    case "month":
      return "day";
    case "quarter":
      return "week";
    case "year":
      return "month";
  }
}

/**
 * Resolve the visible window for the metric-focused health views.
 *
 * Recent windows end at the anchor. Calendar windows align to their natural
 * boundaries. The three-month view uses 13 ISO-week buckets in recent mode and
 * calendar quarters once the user navigates.
 */
export function resolveHealthWindow(values: {
  view: HealthWindowView;
  mode: HealthWindowMode;
  anchor: string;
}): HealthWindow {
  const anchor = parseHealthDateOnly(values.anchor);
  let start: Date;
  let end: Date;

  if (values.mode === "recent") {
    switch (values.view) {
      case "day":
        start = anchor;
        end = anchor;
        break;
      case "week":
        start = subDays(anchor, 6);
        end = anchor;
        break;
      case "month":
        start = subDays(anchor, 29);
        end = anchor;
        break;
      case "quarter":
        start = startOfISOWeek(subWeeks(anchor, 12));
        end = anchor;
        break;
      case "year":
        start = startOfMonth(subMonths(anchor, 11));
        end = anchor;
        break;
    }
  } else {
    switch (values.view) {
      case "day":
        start = anchor;
        end = anchor;
        break;
      case "week":
        start = startOfISOWeek(anchor);
        end = endOfISOWeek(anchor);
        break;
      case "month":
        start = startOfMonth(anchor);
        end = endOfMonth(anchor);
        break;
      case "quarter":
        start = startOfQuarter(anchor);
        end = endOfQuarter(anchor);
        break;
      case "year":
        start = startOfYear(anchor);
        end = endOfYear(anchor);
        break;
    }
  }

  return {
    view: values.view,
    mode: values.mode,
    anchor: formatHealthDateOnly(values.mode === "calendar" ? start : anchor),
    range: {
      start: formatHealthDateOnly(start),
      end: formatHealthDateOnly(end),
    },
    bucket: bucketForView(values.view),
  };
}

export function parseHealthWindow(values: {
  view?: string;
  mode?: string;
  anchor?: string;
}): HealthWindow | null {
  if (
    !values.view ||
    !HEALTH_WINDOW_VIEWS.has(values.view as HealthWindowView) ||
    !values.mode ||
    !HEALTH_WINDOW_MODES.has(values.mode as HealthWindowMode) ||
    !values.anchor
  ) {
    return null;
  }

  try {
    return resolveHealthWindow({
      view: values.view as HealthWindowView,
      mode: values.mode as HealthWindowMode,
      anchor: values.anchor,
    });
  } catch {
    return null;
  }
}

export function selectHealthWindow(window: HealthWindow): HealthWindowSelection {
  return { view: window.view, mode: window.mode, anchor: window.anchor };
}

export function shiftHealthWindow(window: HealthWindow, amount: number): HealthWindow {
  if (!Number.isInteger(amount) || amount === 0) {
    throw new Error(`Invalid health window shift: ${amount}`);
  }

  if (window.mode === "recent" && amount > 0) {
    const currentCalendarWindow = resolveHealthWindow({
      view: window.view,
      mode: "calendar",
      anchor: window.anchor,
    });
    return amount === 1
      ? currentCalendarWindow
      : shiftHealthWindow(currentCalendarWindow, amount - 1);
  }

  const anchor = parseHealthDateOnly(window.anchor);
  const shifted = (() => {
    switch (window.view) {
      case "day":
        return addDays(anchor, amount);
      case "week":
        return addWeeks(anchor, amount);
      case "month":
        return addMonths(anchor, amount);
      case "quarter":
        return addQuarters(anchor, amount);
      case "year":
        return addYears(anchor, amount);
    }
  })();

  return resolveHealthWindow({
    view: window.view,
    mode: "calendar",
    anchor: formatHealthDateOnly(shifted),
  });
}

export function canShiftHealthWindowForward(window: HealthWindow, today: string): boolean {
  parseHealthDateOnly(today);
  if (window.mode === "recent") {
    const currentCalendarWindow = shiftHealthWindow(window, 1);
    return currentCalendarWindow.range.start !== window.range.start ||
      currentCalendarWindow.range.end !== window.range.end;
  }
  return shiftHealthWindow(window, 1).range.start <= today;
}
