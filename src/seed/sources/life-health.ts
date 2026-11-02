/**
 * Shared physiology for the Fitbit and Google Health generators: one plausible
 * night of sleep and one day of vitals per date. Fitbit covers the older years
 * and Google Health (its replacement) the most recent year, so both draw from
 * the same model and the charts read as one continuous person.
 */
import type { SeedContext, SeedDay } from "../context";
import type { Rng } from "../rng";

/** Most recent days, recorded by Google Health; Fitbit covers everything older. */
export const GOOGLE_HEALTH_DAYS = 365;

export type SleepLevel = "wake" | "light" | "deep" | "rem";

export interface SleepSegment {
  level: SleepLevel;
  /** Seconds since the start of the sleep period. */
  offset: number;
  seconds: number;
}

export interface SleepPeriod {
  /** Wall-clock minutes after midnight of the day before the wake date (may exceed 1440). */
  startMin: number;
  /** Minutes in bed from start to end. */
  inBedMin: number;
  latencyMin: number;
  segments: SleepSegment[];
  minutes: Record<SleepLevel, number>;
  counts: Record<SleepLevel, number>;
  asleepMin: number;
  /** Naps on Fitbit are logged without stages. */
  staged: boolean;
}

export interface HealthDay {
  date: string;
  night: SleepPeriod;
  nap: SleepPeriod | null;
  restingHr: number;
  rmssd: number;
  deepRmssd: number;
  spo2: number;
  spo2Low: number;
  spo2High: number;
  breathing: number;
  /** Nightly skin temperature and the personal baseline (°C). */
  temperature: number;
  baselineTemperature: number;
  steps: number;
  floors: number;
  calories: number;
  activeMinutes: { light: number; moderate: number; vigorous: number };
  sedentaryMin: number;
  azm: { fatBurn: number; cardio: number; peak: number };
  stress: number;
  readiness: number;
  weightKg: number;
  hiked: boolean;
}

function buildSegments(rng: Rng, asleepTarget: number, latency: number): SleepSegment[] {
  const segments: SleepSegment[] = [];
  let offset = 0;
  const push = (level: SleepLevel, minutes: number) => {
    const seconds = Math.max(30, Math.round((minutes * 60) / 30) * 30);
    const last = segments.at(-1);
    if (last && last.level === level) last.seconds += seconds;
    else segments.push({ level, offset, seconds });
    offset += seconds;
  };
  push("wake", latency);
  let asleep = 0;
  const deepShare = [0.26, 0.18, 0.1, 0.04, 0.02, 0];
  const remShare = [0.12, 0.2, 0.27, 0.32, 0.35, 0.36];
  for (let cycle = 0; asleep < asleepTarget; cycle++) {
    const length = Math.min(rng.int(82, 108), asleepTarget - asleep + 1);
    const deep = length * (deepShare[cycle] ?? 0) * rng.float(0.7, 1.3);
    const rem = length * (remShare[cycle] ?? 0.35) * rng.float(0.75, 1.25);
    const light = Math.max(5, length - deep - rem);
    push("light", light * 0.55);
    if (deep >= 1) push("deep", deep);
    push("light", light * 0.45);
    if (rem >= 1) push("rem", rem);
    asleep += light + deep + rem;
    if (rng.chance(0.55)) push("wake", rng.float(0.5, 4));
  }
  if (rng.chance(0.6)) push("wake", rng.float(1, 6));
  return segments;
}

function summarise(segments: SleepSegment[], startMin: number, latency: number, staged: boolean): SleepPeriod {
  const minutes: Record<SleepLevel, number> = { wake: 0, light: 0, deep: 0, rem: 0 };
  const counts: Record<SleepLevel, number> = { wake: 0, light: 0, deep: 0, rem: 0 };
  for (const s of segments) {
    minutes[s.level] += s.seconds / 60;
    counts[s.level]++;
  }
  for (const level of Object.keys(minutes) as SleepLevel[]) minutes[level] = Math.round(minutes[level]);
  const total = segments.reduce((sum, s) => sum + s.seconds, 0) / 60;
  return {
    startMin,
    inBedMin: Math.round(total),
    latencyMin: latency,
    segments,
    minutes,
    counts,
    asleepMin: minutes.light + minutes.deep + minutes.rem,
    staged,
  };
}

/** Steps and active minutes: a long day on the trail, or a desk day with the odd run. */
function movement(rng: Rng, day: SeedDay, hiked: boolean) {
  if (hiked) {
    const steps = Math.max(1800, Math.round(rng.normal(23_000, 3500)));
    return {
      steps,
      light: Math.max(60, Math.round(rng.normal(210, 40) + steps / 200)),
      moderate: Math.max(0, Math.round(rng.normal(70, 15))),
      vigorous: Math.max(0, Math.round(rng.normal(85, 20))),
    };
  }
  const steps = Math.max(1800, Math.round(rng.normal(day.isWeekend ? 9500 : 8200, 2600)));
  return {
    steps,
    light: Math.max(60, Math.round(rng.normal(210, 40) + steps / 200)),
    moderate: Math.max(0, Math.round(rng.normal(18, 10))),
    vigorous: Math.max(0, Math.round(rng.chance(0.35) ? rng.normal(30, 10) : rng.normal(4, 4))),
  };
}

/**
 * The health picture for one date: the night that ended that morning, an
 * occasional afternoon nap, and the day's vitals and activity.
 */
export function healthDay(ctx: SeedContext, day: SeedDay): HealthDay {
  // Keyed by date so Fitbit and Google Health agree about any given day.
  const rng = ctx.rng(`health:${day.date}`);
  const progress = day.index / Math.max(1, ctx.days.length - 1);
  const friSat = day.weekday === 6 || day.weekday === 0; // woke on Sat/Sun after a late night
  const hiked = day.weekday === 6 && rng.chance(0.38);

  // Night: bed on the previous evening, later before weekends.
  const bed = (friSat ? 23 * 60 + 50 : 23 * 60 + 5) + Math.round(rng.normal(0, 28)) - (hiked ? 75 : 0);
  const asleepTarget = Math.round(Math.max(300, Math.min(560, rng.normal(friSat ? 470 : 425, 32))));
  const latency = rng.int(4, 22);
  const night = summarise(buildSegments(rng, asleepTarget, latency), bed, latency, true);

  let nap: SleepPeriod | null = null;
  if (rng.chance(day.isWeekend ? 0.12 : 0.03)) {
    const napLength = rng.int(20, 70);
    const segments: SleepSegment[] = [
      { level: "wake", offset: 0, seconds: 180 },
      { level: "light", offset: 180, seconds: napLength * 60 },
      { level: "wake", offset: 180 + napLength * 60, seconds: 120 },
    ];
    // Starts 13:30–16:00 on the wake date, i.e. a day after the night's reference.
    nap = summarise(segments, 1440 + 13 * 60 + 30 + rng.int(0, 150), 3, false);
  }

  const shortNight = night.asleepMin < 390;
  const restingHr = Math.round(59 - 3.5 * progress + rng.normal(0, 1.3) + (shortNight ? 2 : 0) + (hiked ? -1 : 0));
  const rmssd = Math.max(18, 41 + 7 * progress + rng.normal(0, 5) - (shortNight ? 6 : 0));
  const spo2 = Math.min(99, 95.6 + rng.normal(0, 0.6));
  const temperatureDelta = rng.normal(0, 0.25) + (rng.chance(0.02) ? 0.9 : 0);

  const { steps, light, moderate, vigorous } = movement(rng, day, hiked);
  const fatBurn = moderate + Math.round(vigorous * 0.4);
  const cardio = Math.round(vigorous * 0.5);
  const peak = Math.round(vigorous * 0.1);

  const sleepPoints = Math.min(30, Math.round(night.asleepMin / 16));
  const stress = Math.max(40, Math.min(95, Math.round(70 + (sleepPoints - 25) + rng.normal(0, 6) - (day.isWeekend ? -4 : 3))));
  const readiness = Math.max(20, Math.min(98, Math.round(70 + (rmssd - 44) * 0.9 - (restingHr - 57) * 2 + rng.normal(0, 6))));

  return {
    date: day.date,
    night,
    nap,
    restingHr,
    rmssd: Math.round(rmssd * 10) / 10,
    deepRmssd: Math.round((rmssd + rng.normal(6, 3)) * 10) / 10,
    spo2: Math.round(spo2 * 10) / 10,
    spo2Low: Math.round((spo2 - rng.float(1.5, 3)) * 10) / 10,
    spo2High: Math.round(Math.min(100, spo2 + rng.float(1, 2.5)) * 10) / 10,
    breathing: Math.round((14.6 + rng.normal(0, 0.5)) * 10) / 10,
    temperature: Math.round((33.9 + temperatureDelta) * 100) / 100,
    baselineTemperature: 33.9,
    steps,
    floors: Math.max(0, Math.round(hiked ? rng.normal(180, 40) : rng.normal(9, 4))),
    calories: Math.round(1850 + steps * 0.045 + vigorous * 6 + rng.normal(0, 60)),
    activeMinutes: { light, moderate, vigorous },
    sedentaryMin: Math.max(300, Math.round(rng.normal(day.isWeekend ? 560 : 640, 60) - (hiked ? 200 : 0))),
    azm: { fatBurn, cardio, peak },
    stress,
    readiness,
    weightKg: Math.round((74.2 - 2.4 * progress + 0.4 * Math.sin(day.index / 45) + rng.normal(0, 0.3)) * 10) / 10,
    hiked,
  };
}

/** Wall-clock "YYYY-MM-DDTHH:MM:SS.000" for minutes after midnight of the day before `wakeDate`. */
export function wallClock(wakeDate: string, minutes: number, seconds = 0): string {
  const base = Date.parse(`${wakeDate}T00:00:00Z`) - 86_400_000;
  return new Date(base + minutes * 60_000 + seconds * 1000).toISOString().slice(0, 23);
}
