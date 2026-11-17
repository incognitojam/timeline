/**
 * When a source counts as quiet: its newest event is older than it normally
 * goes without one. Shared by the status page, `/api/status`, and the sync view.
 */
export const QUIET_RULE = {
  /** The gaps between this many most recent days with events set what is normal. */
  historyDays: 30,
  /** With fewer days with events there is no normal yet. */
  minActiveDays: 10,
  gapMultiple: 1.5,
  minQuietDays: 3,
  /**
   * An import-only source is fed, rather than a one-off export, when its newest
   * event and the event this far before it were imported on different days.
   */
  importProbeDays: 90,
  /** An import-only source quiet for longer than this counts as finished. */
  importRetireDays: 180,
} as const;

export const QUIET_RULE_SUMMARY =
  `A source is quiet when its newest event is older than ${QUIET_RULE.gapMultiple}× the longest it went without ` +
  `new events across its last ${QUIET_RULE.historyDays} days with events (for an import-only source, until the ` +
  `next import brought them), and at least ${QUIET_RULE.minQuietDays} days old. ` +
  "Only sources still being fed are checked: those with an enabled sync, and import-only sources that arrived " +
  `in more than one import and had an event in the last ${QUIET_RULE.importRetireDays} days.`;

/** How new events reach a checked source. */
export type SourceFeed = "sync" | "imports";

/** Why a source with dated events is not checked. */
export type UncheckedReason = "sync-off" | "one-off" | "finished" | "retired";

/** A checked source with enough history to judge. */
interface JudgedFreshness {
  source: string;
  newestAt: string;
  feed: SourceFeed;
  /** Whole days since the newest event. */
  quietDays: number;
  /** Longest the source recently went without new events, in days. */
  usualGapDays: number;
}

export type SourceFreshness =
  | { source: string; status: "undated" }
  /** A sampled timestamp isn't a valid time, so the source can't be judged. */
  | { source: string; status: "unreadable"; timestamp: string }
  | { source: string; status: "unchecked"; newestAt: string; reason: UncheckedReason }
  | { source: string; status: "new"; newestAt: string; feed: SourceFeed; activeDays: number }
  | (JudgedFreshness & { status: "ok" })
  | (JudgedFreshness & { status: "quiet" });

export type QuietSourceFreshness = Extract<SourceFreshness, { status: "quiet" }>;

export const UNCHECKED_REASON_LABEL: Record<UncheckedReason, string> = {
  retired: "source retired",
  "sync-off": "sync turned off",
  "one-off": "imported once",
  finished: `import-only, quiet over ${QUIET_RULE.importRetireDays} days`,
};

/** "quiet 82d, usually at most 29d without new events" */
export function describeQuiet(entry: { quietDays: number; usualGapDays: number }): string {
  return `quiet ${entry.quietDays}d, usually at most ${entry.usualGapDays}d without new events`;
}
