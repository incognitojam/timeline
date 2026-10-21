#!/usr/bin/env bun
/**
 * Read-only probe for Discord/Facebook message reactions.
 *
 * Usage:
 *   bun run src/scripts/verify-message-reactions.ts
 *   bun run src/scripts/verify-message-reactions.ts --source=discord
 *   bun run src/scripts/verify-message-reactions.ts --sample-limit=10 --no-fail
 */

import { Database } from "bun:sqlite";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { getTimelineDbPath } from "../db/paths";
import { openReadonlyDbAtPath } from "../db/readonly";
import { getReactionSummary, type ReactionSummary } from "../lib/format";

const SOURCES = ["discord", "facebook"] as const;

type ReactionSource = (typeof SOURCES)[number];

interface ReactionEventRow {
  id: number;
  source: ReactionSource;
  raw_data: string;
}

interface SourceStats {
  candidateEvents: number;
  eventsWithReactionEntries: number;
  eventsWithSummaries: number;
  eventsWithSkippedEntries: number;
  abortedEvents: number;
  reactionEntries: number;
  summarizedEntries: number;
  skippedEntries: number;
  skippedEventIds: number[];
  abortedEventIds: number[];
}

interface VerificationReport {
  dbPath: string;
  sampleLimit: number;
  sources: Record<ReactionSource, SourceStats>;
}

interface CliOptions {
  source: ReactionSource | "all";
  sampleLimit: number;
  json: boolean;
  noFail: boolean;
}

function createSourceStats(): SourceStats {
  return {
    candidateEvents: 0,
    eventsWithReactionEntries: 0,
    eventsWithSummaries: 0,
    eventsWithSkippedEntries: 0,
    abortedEvents: 0,
    reactionEntries: 0,
    summarizedEntries: 0,
    skippedEntries: 0,
    skippedEventIds: [],
    abortedEventIds: [],
  };
}

function createReport(dbPath: string, sampleLimit: number): VerificationReport {
  return {
    dbPath,
    sampleLimit,
    sources: {
      discord: createSourceStats(),
      facebook: createSourceStats(),
    },
  };
}

function addSample(samples: number[], eventId: number, limit: number): void {
  if (samples.length < limit) samples.push(eventId);
}

function addSummary(
  report: VerificationReport,
  row: ReactionEventRow,
  summary: ReactionSummary,
): void {
  const stats = report.sources[row.source];
  stats.candidateEvents++;
  stats.reactionEntries += summary.reactionEntries;
  stats.summarizedEntries += summary.summarizedEntries;
  stats.skippedEntries += summary.skippedEntries;

  if (summary.reactionEntries > 0) stats.eventsWithReactionEntries++;
  if (summary.description) stats.eventsWithSummaries++;
  if (summary.skippedEntries > 0) {
    stats.eventsWithSkippedEntries++;
    addSample(stats.skippedEventIds, row.id, report.sampleLimit);
  }
  if (summary.abortsCurrentConsumer) {
    stats.abortedEvents++;
    addSample(stats.abortedEventIds, row.id, report.sampleLimit);
  }
}

function parseCliOptions(): CliOptions {
  const parseArgsConfig = {
    args: process.argv.slice(2),
    options: {
      source: { type: "string", default: "all" },
      "sample-limit": { type: "string", default: "5" },
      json: { type: "boolean", default: false },
      "no-fail": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  } as const satisfies ParseArgsConfig;

  let values: ReturnType<typeof parseArgs<typeof parseArgsConfig>>["values"];
  try {
    ({ values } = parseArgs(parseArgsConfig));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    console.error("Run with --help for usage information.");
    process.exit(1);
  }

  if (values.help) {
    console.log(`Usage: bun run src/scripts/verify-message-reactions.ts [options]

Scans Discord/Facebook events whose raw_data text mentions "reactions" and
reports how the current formatter handles those stored reaction arrays.

Options:
  --source=all|discord|facebook  Limit scan to one source (default: all)
  --sample-limit=N               Event IDs to show per issue (default: 5)
  --json                         Print machine-readable JSON
  --no-fail                      Always exit 0 after printing the report`);
    process.exit(0);
  }

  const source = values.source;
  if (source !== "all" && source !== "discord" && source !== "facebook") {
    console.error(`Error: --source must be all, discord, or facebook; got '${source}'`);
    process.exit(1);
  }

  const sampleLimit = Number(values["sample-limit"]);
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0) {
    console.error(`Error: --sample-limit must be a non-negative integer; got '${values["sample-limit"]}'`);
    process.exit(1);
  }

  return {
    source,
    sampleLimit,
    json: values.json,
    noFail: values["no-fail"],
  };
}

function selectedSources(source: CliOptions["source"]): ReactionSource[] {
  return source === "all" ? [...SOURCES] : [source];
}

function scanDatabase(db: Database, dbPath: string, options: CliOptions): VerificationReport {
  const report = createReport(dbPath, options.sampleLimit);
  const sources = selectedSources(options.source);
  const placeholders = sources.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, source, raw_data
       FROM events
       WHERE source IN (${placeholders})
         AND raw_data IS NOT NULL
         AND raw_data LIKE '%"reactions"%'`,
    )
    .iterate(...sources) as IterableIterator<ReactionEventRow>;

  for (const row of rows) {
    addSummary(report, row, getReactionSummary(row));
  }

  return report;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function sampleText(samples: number[]): string {
  return samples.length > 0 ? samples.join(", ") : "(none)";
}

function totalSkippedEntries(report: VerificationReport): number {
  return Object.values(report.sources).reduce((sum, source) => sum + source.skippedEntries, 0);
}

function totalAbortedEvents(report: VerificationReport): number {
  return Object.values(report.sources).reduce((sum, source) => sum + source.abortedEvents, 0);
}

function printSourceStats(source: ReactionSource, stats: SourceStats): void {
  console.log(`\n${source}`);
  console.log("-".repeat(40));
  console.log(`  Candidate events scanned:       ${formatCount(stats.candidateEvents)}`);
  console.log(`  Events with reaction entries:   ${formatCount(stats.eventsWithReactionEntries)}`);
  console.log(`  Events with reaction summaries: ${formatCount(stats.eventsWithSummaries)}`);
  console.log(`  Reaction entries:               ${formatCount(stats.reactionEntries)}`);
  console.log(`  Entries summarized today:       ${formatCount(stats.summarizedEntries)}`);
  console.log(`  Skipped entries:                ${formatCount(stats.skippedEntries)}`);
  console.log(`  Events with skipped entries:    ${formatCount(stats.eventsWithSkippedEntries)}`);
  console.log(`  Aborted events:                 ${formatCount(stats.abortedEvents)}`);
  console.log(`  Skipped-entry samples:          ${sampleText(stats.skippedEventIds)}`);
  console.log(`  Abort samples:                  ${sampleText(stats.abortedEventIds)}`);
}

function printTextReport(report: VerificationReport): void {
  console.log("Discord/Facebook Reaction Probe");
  console.log("=".repeat(60));
  console.log(`Database: ${report.dbPath}`);
  console.log(`Date: ${new Date().toISOString()}`);

  for (const source of SOURCES) {
    printSourceStats(source, report.sources[source]);
  }

  console.log("\nSummary");
  console.log("-".repeat(40));
  console.log(`  Total skipped entries: ${formatCount(totalSkippedEntries(report))}`);
  console.log(`  Total aborted events:  ${formatCount(totalAbortedEvents(report))}`);
}

function main(): void {
  const options = parseCliOptions();
  const dbPath = getTimelineDbPath();
  const db = openReadonlyDbAtPath(dbPath);

  try {
    const report = scanDatabase(db, dbPath, options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printTextReport(report);
    }

    if ((totalSkippedEntries(report) > 0 || totalAbortedEvents(report) > 0) && !options.noFail) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main();
}
