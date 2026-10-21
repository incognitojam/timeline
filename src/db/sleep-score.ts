/**
 * Custom sleep quality score (0-100) derived from Fitbit sleep data.
 *
 * Based on published sleep science:
 * - Duration: Hirshkowitz et al. 2015 (National Sleep Foundation) — 7-9h optimal
 * - Deep sleep: AASM guidelines — 13-23% of total sleep
 * - REM sleep: Carskadon & Dement 2005 — 20-25% of total sleep
 * - Continuity: Ohayon et al. 2017 — >85% efficiency, WASO <20min
 * - Onset latency: Ohayon et al. 2017 — 10-20min ideal
 */

export interface SleepScoreInput {
  durationMs: number;
  efficiency: number; // 0-100
  minutesToFallAsleep: number;
  deepMinutes?: number;
  lightMinutes?: number;
  remMinutes?: number;
  wakeMinutes?: number;
}

export interface SleepScoreBreakdown {
  duration: number;
  deepSleep?: number;
  remSleep?: number;
  continuity: number;
  onsetLatency: number;
}

export interface SleepScoreResult {
  score: number; // 0-100
  breakdown: SleepScoreBreakdown;
  hasStageData: boolean;
}

/** Breakpoint pair: [inputValue, outputScore] */
type Breakpoint = [number, number];

/**
 * Piecewise linear interpolation between breakpoints.
 * Breakpoints must be sorted by input value (ascending).
 * Values below the first breakpoint get its score; above the last get its score.
 */
export function scorePiecewiseLinear(value: number, breakpoints: Breakpoint[]): number {
  if (breakpoints.length === 0) return 0;
  if (value <= breakpoints[0][0]) return breakpoints[0][1];
  if (value >= breakpoints[breakpoints.length - 1][0]) return breakpoints[breakpoints.length - 1][1];

  for (let i = 0; i < breakpoints.length - 1; i++) {
    const [x0, y0] = breakpoints[i];
    const [x1, y1] = breakpoints[i + 1];
    if (value >= x0 && value <= x1) {
      const t = (value - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }

  return breakpoints[breakpoints.length - 1][1];
}

// Duration in hours -> score
// <4h: 0, 4-7h: ramp to 100, 7-9h: 100, 9-10h: drop to 70, 10-12h: drop to 30, >12h: 20
const DURATION_BREAKPOINTS: Breakpoint[] = [
  [4, 0],
  [7, 100],
  [9, 100],
  [10, 70],
  [12, 30],
];

// Deep sleep % -> score
// <5%: 20, 5-13%: ramp to 80, 13-23%: 100, 23-30%: drop to 80, >30%: 70
const DEEP_SLEEP_BREAKPOINTS: Breakpoint[] = [
  [5, 20],
  [13, 80],
  [14, 100],
  [23, 100],
  [30, 80],
];

// REM sleep % -> score
// <10%: 20, 10-20%: ramp to 90, 20-25%: 100, 25-35%: drop to 80, >35%: 70
const REM_SLEEP_BREAKPOINTS: Breakpoint[] = [
  [10, 20],
  [20, 90],
  [21, 100],
  [25, 100],
  [35, 80],
];

// Efficiency % -> score
// <70%: 20, 70-85%: ramp to 80, 85-95%: 100
const EFFICIENCY_BREAKPOINTS: Breakpoint[] = [
  [70, 20],
  [85, 80],
  [88, 100],
];

// Wake minutes -> score (lower is better)
// >60min: 20, 60-30: ramp to 70, 30-20: ramp to 90, <20: 100
const WAKE_MINUTES_BREAKPOINTS: Breakpoint[] = [
  [0, 100],
  [20, 100],
  [30, 90],
  [60, 20],
];

// Onset latency in minutes -> score
// <5min: 70, 5-10: ramp to 100, 10-20: 100, 20-30: drop to 70, 30-45: drop to 40, >45: 20
const LATENCY_BREAKPOINTS: Breakpoint[] = [
  [0, 70],
  [5, 70],
  [10, 100],
  [20, 100],
  [30, 70],
  [45, 40],
];

// Weights with stage data
const WEIGHT_DURATION = 0.3;
const WEIGHT_DEEP = 0.2;
const WEIGHT_REM = 0.2;
const WEIGHT_CONTINUITY = 0.2;
const WEIGHT_LATENCY = 0.1;

// Weights without stage data (redistributed)
const WEIGHT_DURATION_NO_STAGES = 0.4;
const WEIGHT_CONTINUITY_NO_STAGES = 0.4;
const WEIGHT_LATENCY_NO_STAGES = 0.2;

export function calculateSleepScore(input: SleepScoreInput): SleepScoreResult {
  const durationHours = input.durationMs / 3_600_000;

  // Duration sub-score
  const durationScore = scorePiecewiseLinear(durationHours, DURATION_BREAKPOINTS);

  // Continuity sub-score: 60% efficiency + 40% wake minutes
  const efficiencyScore = scorePiecewiseLinear(input.efficiency, EFFICIENCY_BREAKPOINTS);
  const wakeScore = input.wakeMinutes != null
    ? scorePiecewiseLinear(input.wakeMinutes, WAKE_MINUTES_BREAKPOINTS)
    : efficiencyScore; // fall back to efficiency if no wake data
  const continuityScore = efficiencyScore * 0.6 + wakeScore * 0.4;

  // Onset latency sub-score
  // Treat 0 as "unknown/autodetected" — give neutral score
  const latencyScore = input.minutesToFallAsleep > 0
    ? scorePiecewiseLinear(input.minutesToFallAsleep, LATENCY_BREAKPOINTS)
    : 80;

  // Check if we have stage data
  const hasStageData = input.deepMinutes != null && input.remMinutes != null;

  if (hasStageData) {
    const totalAsleepMinutes = (input.deepMinutes ?? 0) + (input.lightMinutes ?? 0) + (input.remMinutes ?? 0);

    if (totalAsleepMinutes === 0) {
      // Edge case: all zeros — treat as no stage data
      const score = Math.round(
        durationScore * WEIGHT_DURATION_NO_STAGES +
        continuityScore * WEIGHT_CONTINUITY_NO_STAGES +
        latencyScore * WEIGHT_LATENCY_NO_STAGES
      );
      return {
        score: Math.max(0, Math.min(100, score)),
        breakdown: { duration: Math.round(durationScore), continuity: Math.round(continuityScore), onsetLatency: Math.round(latencyScore) },
        hasStageData: false,
      };
    }

    const deepPct = ((input.deepMinutes ?? 0) / totalAsleepMinutes) * 100;
    const remPct = ((input.remMinutes ?? 0) / totalAsleepMinutes) * 100;

    const deepScore = scorePiecewiseLinear(deepPct, DEEP_SLEEP_BREAKPOINTS);
    const remScore = scorePiecewiseLinear(remPct, REM_SLEEP_BREAKPOINTS);

    const score = Math.round(
      durationScore * WEIGHT_DURATION +
      deepScore * WEIGHT_DEEP +
      remScore * WEIGHT_REM +
      continuityScore * WEIGHT_CONTINUITY +
      latencyScore * WEIGHT_LATENCY
    );

    return {
      score: Math.max(0, Math.min(100, score)),
      breakdown: {
        duration: Math.round(durationScore),
        deepSleep: Math.round(deepScore),
        remSleep: Math.round(remScore),
        continuity: Math.round(continuityScore),
        onsetLatency: Math.round(latencyScore),
      },
      hasStageData: true,
    };
  }

  // No stage data — redistribute weights
  const score = Math.round(
    durationScore * WEIGHT_DURATION_NO_STAGES +
    continuityScore * WEIGHT_CONTINUITY_NO_STAGES +
    latencyScore * WEIGHT_LATENCY_NO_STAGES
  );

  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown: {
      duration: Math.round(durationScore),
      continuity: Math.round(continuityScore),
      onsetLatency: Math.round(latencyScore),
    },
    hasStageData: false,
  };
}
