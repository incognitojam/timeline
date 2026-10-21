const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;

export function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve the timeline `?date=` query param to a `YYYY-MM-DD` string,
 * defaulting to today when missing or malformed.
 */
export function resolveTimelineDate(
  raw: string | string[] | null | undefined,
): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && DATE_PARAM_RE.test(value) ? value : getToday();
}
