import type { TimelineEvent } from "./types";

/**
 * Sleep stages as google-health reports them. Older records (and short naps)
 * report fewer stages, so every total is optional.
 */
export type SleepStage = "awake" | "rem" | "light" | "deep";

/** Display order, lightest sleep first. */
const STAGE_ORDER: SleepStage[] = ["awake", "rem", "light", "deep"];

export const SLEEP_STAGE_LABELS: Record<SleepStage, string> = {
  awake: "Awake",
  rem: "REM",
  light: "Light",
  deep: "Deep",
};

export interface SleepStageTotal {
  stage: SleepStage;
  durationMs: number;
}

export interface SleepDetails {
  /** Per-stage time in STAGE_ORDER; empty when the record has no breakdown. */
  stageTotals: SleepStageTotal[];
  asleepMs: number | null;
  inBedMs: number | null;
  /** Percentage of the sleep period actually spent asleep. */
  efficiency: number | null;
}

/**
 * google-health is the canonical sleep source; fitbit's own sleep events are
 * either superseded by it or predate it, and keep the generic event card.
 */
export function isSleepEvent(event: { source: string; type: string }): boolean {
  return (
    event.source === "google-health" && (event.type === "sleep" || event.type === "sleep:nap")
  );
}

const STAGES: Record<string, SleepStage> = {
  AWAKE: "awake",
  REM: "rem",
  LIGHT: "light",
  DEEP: "deep",
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseStageTotals(stagesSummary: unknown): SleepStageTotal[] {
  if (!Array.isArray(stagesSummary)) return [];
  const minutes = new Map<SleepStage, number>();
  for (const entry of stagesSummary) {
    if (typeof entry !== "object" || entry === null) continue;
    const { type, minutes: reported } = entry as Record<string, unknown>;
    const stage = typeof type === "string" ? STAGES[type] : undefined;
    const value = toNumber(reported);
    if (!stage || value === null || value <= 0) continue;
    minutes.set(stage, value);
  }
  return STAGE_ORDER.flatMap((stage) => {
    const value = minutes.get(stage);
    return value === undefined ? [] : [{ stage, durationMs: value * 60000 }];
  });
}

const EMPTY: SleepDetails = { stageTotals: [], asleepMs: null, inBedMs: null, efficiency: null };

/**
 * Read the stage breakdown out of a sleep event's preserved google-health
 * payload (`{ sleep: { summary } }`). Records that carry no summary yield
 * nothing, leaving the card with the event's own duration.
 */
export function parseSleepEvent(event: TimelineEvent): SleepDetails {
  let raw: unknown;
  try {
    raw = JSON.parse(event.raw_data);
  } catch {
    return EMPTY;
  }
  const sleep = (raw as { sleep?: unknown } | null)?.sleep;
  if (typeof sleep !== "object" || sleep === null) return EMPTY;
  const summary = (sleep as { summary?: unknown }).summary;
  if (typeof summary !== "object" || summary === null) return EMPTY;

  const { minutesAsleep, minutesInSleepPeriod, stagesSummary } = summary as Record<string, unknown>;
  const asleep = toNumber(minutesAsleep);
  const inBed = toNumber(minutesInSleepPeriod);

  return {
    stageTotals: parseStageTotals(stagesSummary),
    asleepMs: asleep !== null ? asleep * 60000 : null,
    inBedMs: inBed !== null ? inBed * 60000 : null,
    efficiency: asleep !== null && inBed !== null && inBed > 0 ? Math.round((asleep / inBed) * 100) : null,
  };
}
