import { describe, test, expect } from "bun:test";
import { calculateSleepScore, scorePiecewiseLinear, type SleepScoreInput } from "./sleep-score";

// All measurements below are synthetic fixtures chosen to exercise scoring boundaries.

describe("scorePiecewiseLinear", () => {
  const breakpoints: [number, number][] = [
    [0, 0],
    [50, 100],
    [100, 50],
  ];

  test("returns first score below range", () => {
    expect(scorePiecewiseLinear(-10, breakpoints)).toBe(0);
  });

  test("returns last score above range", () => {
    expect(scorePiecewiseLinear(200, breakpoints)).toBe(50);
  });

  test("interpolates midpoint", () => {
    expect(scorePiecewiseLinear(25, breakpoints)).toBe(50);
  });

  test("returns exact breakpoint values", () => {
    expect(scorePiecewiseLinear(0, breakpoints)).toBe(0);
    expect(scorePiecewiseLinear(50, breakpoints)).toBe(100);
    expect(scorePiecewiseLinear(100, breakpoints)).toBe(50);
  });

  test("handles empty breakpoints", () => {
    expect(scorePiecewiseLinear(5, [])).toBe(0);
  });
});

describe("calculateSleepScore", () => {
  test("perfect sleep scores high (~90+)", () => {
    const input: SleepScoreInput = {
      durationMs: 8 * 3_600_000, // 8 hours
      efficiency: 92,
      minutesToFallAsleep: 12,
      deepMinutes: 85, // ~18% of 470 total
      lightMinutes: 280,
      remMinutes: 105, // ~22% of 470 total
      wakeMinutes: 15,
    };
    const result = calculateSleepScore(input);
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.hasStageData).toBe(true);
    expect(result.breakdown.deepSleep).toBeDefined();
    expect(result.breakdown.remSleep).toBeDefined();
  });

  test("short sleep scores low despite good composition", () => {
    const input: SleepScoreInput = {
      durationMs: 4 * 3_600_000, // 4 hours
      efficiency: 90,
      minutesToFallAsleep: 15,
      deepMinutes: 40,
      lightMinutes: 120,
      remMinutes: 50,
      wakeMinutes: 10,
    };
    const result = calculateSleepScore(input);
    // Duration is 0 at 4h, but other factors are decent
    expect(result.score).toBeLessThanOrEqual(75);
    expect(result.score).toBeGreaterThanOrEqual(30);
  });

  test("very short sleep scores very low", () => {
    const input: SleepScoreInput = {
      durationMs: 3 * 3_600_000, // 3 hours (below minimum)
      efficiency: 80,
      minutesToFallAsleep: 30,
      deepMinutes: 20,
      lightMinutes: 100,
      remMinutes: 30,
      wakeMinutes: 30,
    };
    const result = calculateSleepScore(input);
    expect(result.score).toBeLessThanOrEqual(60);
  });

  test("long sleep (11h) scores lower than optimal", () => {
    const input: SleepScoreInput = {
      durationMs: 11 * 3_600_000,
      efficiency: 90,
      minutesToFallAsleep: 15,
      deepMinutes: 90,
      lightMinutes: 400,
      remMinutes: 130,
      wakeMinutes: 20,
    };
    const result = calculateSleepScore(input);
    // Duration subscore is penalized for oversleeping
    expect(result.score).toBeLessThan(90);
  });

  test("classic tracking (no stage data) redistributes weights", () => {
    const input: SleepScoreInput = {
      durationMs: 8 * 3_600_000,
      efficiency: 90,
      minutesToFallAsleep: 15,
      // No stage data
    };
    const result = calculateSleepScore(input);
    expect(result.hasStageData).toBe(false);
    expect(result.breakdown.deepSleep).toBeUndefined();
    expect(result.breakdown.remSleep).toBeUndefined();
    expect(result.score).toBeGreaterThanOrEqual(80);
  });

  test("zero minutesToFallAsleep treated as unknown", () => {
    const input: SleepScoreInput = {
      durationMs: 8 * 3_600_000,
      efficiency: 90,
      minutesToFallAsleep: 0,
      deepMinutes: 80,
      lightMinutes: 270,
      remMinutes: 100,
      wakeMinutes: 15,
    };
    const result = calculateSleepScore(input);
    // Should get neutral latency score (80), not penalized
    expect(result.breakdown.onsetLatency).toBe(80);
  });

  test("very long latency penalizes score", () => {
    const input: SleepScoreInput = {
      durationMs: 8 * 3_600_000,
      efficiency: 90,
      minutesToFallAsleep: 60,
      deepMinutes: 80,
      lightMinutes: 270,
      remMinutes: 100,
      wakeMinutes: 15,
    };
    const result = calculateSleepScore(input);
    expect(result.breakdown.onsetLatency).toBeLessThanOrEqual(40);
  });

  test("poor efficiency reduces score", () => {
    const input: SleepScoreInput = {
      durationMs: 8 * 3_600_000,
      efficiency: 65,
      minutesToFallAsleep: 15,
      deepMinutes: 80,
      lightMinutes: 270,
      remMinutes: 100,
      wakeMinutes: 60,
    };
    const result = calculateSleepScore(input);
    expect(result.breakdown.continuity).toBeLessThanOrEqual(30);
  });

  test("score is always clamped to 0-100", () => {
    // Edge case: all zeros
    const input: SleepScoreInput = {
      durationMs: 0,
      efficiency: 0,
      minutesToFallAsleep: 0,
    };
    const result = calculateSleepScore(input);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  test("all stage data zero treated as no stage data", () => {
    const input: SleepScoreInput = {
      durationMs: 7 * 3_600_000,
      efficiency: 85,
      minutesToFallAsleep: 15,
      deepMinutes: 0,
      lightMinutes: 0,
      remMinutes: 0,
      wakeMinutes: 0,
    };
    const result = calculateSleepScore(input);
    expect(result.hasStageData).toBe(false);
  });

  test("low deep sleep percentage penalizes subscore", () => {
    const input: SleepScoreInput = {
      durationMs: 8 * 3_600_000,
      efficiency: 90,
      minutesToFallAsleep: 15,
      deepMinutes: 10, // ~2% of total — very low
      lightMinutes: 370,
      remMinutes: 100,
      wakeMinutes: 15,
    };
    const result = calculateSleepScore(input);
    expect(result.breakdown.deepSleep!).toBeLessThanOrEqual(30);
  });

  test("low REM percentage penalizes subscore", () => {
    const input: SleepScoreInput = {
      durationMs: 8 * 3_600_000,
      efficiency: 90,
      minutesToFallAsleep: 15,
      deepMinutes: 80,
      lightMinutes: 370,
      remMinutes: 20, // ~4% of total — very low
      wakeMinutes: 15,
    };
    const result = calculateSleepScore(input);
    expect(result.breakdown.remSleep!).toBeLessThanOrEqual(30);
  });
});
