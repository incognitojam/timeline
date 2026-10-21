export function clampLimit(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = value === undefined ? NaN : parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function clampOffset(value: string | undefined): number {
  const parsed = value === undefined ? NaN : parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}
