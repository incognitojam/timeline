import { IconArrowDownward, IconArrowUpward, IconCheck, type IconComponent } from "../ui/icons";

// ============================================================================
// Formatting Utilities
// ============================================================================

/**
 * Format sleep duration in hours and minutes
 */
export function formatSleepDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

/**
 * Format fractional hours as HH:MM time string
 */
export function formatTimeOfDay(hours: number): string {
  const normalized = ((hours % 24) + 24) % 24;
  let hh = Math.floor(normalized);
  let mm = Math.round((normalized - hh) * 60);
  if (mm === 60) { mm = 0; hh = (hh + 1) % 24; }
  return `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
}

/**
 * Format heart rate
 */
export function formatHeartRate(bpm: number): string {
  return `${Math.round(bpm)} bpm`;
}

/**
 * Format HRV
 */
export function formatHRV(rmssd: number): string {
  return `${Math.round(rmssd)} ms`;
}

/**
 * Format SpO2 percentage
 */
export function formatSpO2(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * Format weight in kg
 */
export function formatWeight(kg: number): string {
  return `${kg.toFixed(1)} kg`;
}

/**
 * Format steps count
 */
export function formatSteps(count: number): string {
  return Math.round(count).toLocaleString();
}

/**
 * Format efficiency percentage
 */
export function formatEfficiency(value: number): string {
  return `${Math.round(value)}%`;
}

// ============================================================================
// Biomarker Utilities
// ============================================================================

export type BiomarkerLevel = "optimal" | "normal" | "abnormal" | "highly_abnormal";

/**
 * Sort reference ranges by lower bound (open-ended lower bounds first),
 * dropping ranges with no bounds at all.
 */
export function sortReferenceRanges(ranges: BiomarkerReferenceRange[]): BiomarkerReferenceRange[] {
  return ranges
    .filter(r => r.lower_bound !== null || r.upper_bound !== null)
    .sort((a, b) => (a.lower_bound ?? -Infinity) - (b.lower_bound ?? -Infinity));
}

/**
 * Full extent covered by a set of reference ranges, extended by 10% on each
 * side for open-ended ranges. Falls back to 0–100 when unbounded.
 */
export function referenceRangeExtent(ranges: BiomarkerReferenceRange[]): { min: number; max: number } {
  if (ranges.length === 0) return { min: 0, max: 100 };

  let min = Infinity;
  let max = -Infinity;
  for (const r of ranges) {
    if (r.lower_bound !== null && r.lower_bound < min) min = r.lower_bound;
    if (r.upper_bound !== null && r.upper_bound > max) max = r.upper_bound;
  }

  if (min === Infinity) min = 0;
  if (max === -Infinity) max = 100;

  if (max <= min) max = min + 1;

  const range = max - min;
  if (range > 0) {
    min = Math.max(0, min - range * 0.1);
    max = max + range * 0.1;
  }

  return { min, max };
}

/**
 * Calculate nice axis bounds that produce clean tick intervals.
 */
export function niceAxisBounds(dataMin: number, dataMax: number, padding = 0.1): { min: number; max: number } {
  const span = Math.max(dataMax - dataMin, 1);
  const midpoint = (dataMin + dataMax) / 2;
  const paddedMin = midpoint - span / 2 - span * padding;
  const paddedMax = midpoint + span / 2 + span * padding;

  // Choose a "nice" step size (1, 2, 5, 10, 20, 50, etc.)
  const rawStep = (paddedMax - paddedMin) / 5; // Aim for ~5 ticks
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const niceStep = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = niceStep * magnitude;

  return {
    min: Math.floor(paddedMin / step) * step,
    max: Math.ceil(paddedMax / step) * step,
  };
}

/** Normalize a value's position within bounds, keeping markers on the range bar. */
export function normalizeRangePosition(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/**
 * Get CSS color for biomarker level
 */
export function getBiomarkerLevelColor(level: BiomarkerLevel): string {
  switch (level) {
    case "optimal": return "text-green-400";
    case "normal": return "text-foreground";
    case "abnormal": return "text-yellow-400";
    case "highly_abnormal": return "text-red-400";
  }
}

// ============================================================================
// Health Panel Utilities
// ============================================================================

import type { BiomarkerReferenceRange, RangeStatus } from "./api";

/**
 * Format breathing rate
 */
export function formatBreathingRate(value: number): string {
  return `${value.toFixed(1)}/min`;
}

/**
 * Format skin temperature variation
 */
export function formatSkinTemp(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}°C`;
}

/**
 * Format active minutes
 */
export function formatActiveMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remaining = mins % 60;
  return remaining > 0 ? `${hours}h ${remaining}m` : `${hours}h`;
}

/**
 * Format calories
 */
export function formatCalories(value: number): string {
  return value.toLocaleString();
}

/**
 * Get icon for range status
 */
export function getRangeStatusIcon(status: RangeStatus): IconComponent {
  switch (status) {
    case "above": return IconArrowUpward;
    case "below": return IconArrowDownward;
    case "in_range": return IconCheck;
  }
}

/**
 * Get CSS color class for range status
 */
export function getRangeStatusColor(status: RangeStatus): string {
  switch (status) {
    case "above": return "text-yellow-400";
    case "below": return "text-yellow-400";
    case "in_range": return "text-green-400";
  }
}

/**
 * Get status description text
 */
export function getRangeStatusText(status: RangeStatus, low: number, high: number): string {
  if (low === 0 && high === 0) return "No baseline data";
  switch (status) {
    case "above": return `Above range (${Math.round(low)}-${Math.round(high)})`;
    case "below": return `Below range (${Math.round(low)}-${Math.round(high)})`;
    case "in_range": return "In personal range";
  }
}

// ============================================================================
// Sleep Score Utilities
// ============================================================================

/**
 * Get CSS color class for a sleep score value
 */
export function getSleepScoreColor(score: number): string {
  if (score >= 80) return "text-green-400";
  if (score >= 60) return "text-yellow-400";
  if (score >= 40) return "text-orange-400";
  return "text-red-400";
}

/**
 * Get a label describing the sleep score range
 */
export function getSleepScoreLabel(score: number): string {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Fair";
  return "Poor";
}

/**
 * Get hex color for sleep score (for charts)
 */
export function getSleepScoreChartColor(score: number): string {
  if (score >= 80) return "#4ade80"; // green-400
  if (score >= 60) return "#facc15"; // yellow-400
  if (score >= 40) return "#fb923c"; // orange-400
  return "#f87171"; // red-400
}
