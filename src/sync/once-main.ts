/**
 * Child half of `bun run sync:once`; once-cli.ts starts it inside the sandbox.
 * Usage errors exit with EXIT_USAGE, a refused or failed sync with 1.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { configureBunSqliteForSqliteVec } from "../embeddings/sqlite-vec";
import { EXIT_USAGE, isInside } from "./once-cli";
import type { SourceRunReport } from "./once";

interface OnceRequest {
  source: string;
  set: string[];
  state?: Record<string, unknown>;
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  callerDir: string;
}

const SECRET_KEY = /token|secret|password|api_?key|cookie/i;

/** Masks credential-looking values for display; the database keeps the real ones. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) && entry !== null && typeof entry !== "object" ? "[redacted]" : redact(entry),
    ]),
  );
}

function truncate(text: string | null, width: number): string {
  if (text === null) return "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

function formatOutcome(report: SourceRunReport, config: unknown): string[] {
  const lines = [`Source:  ${report.source}${report.dryRun ? " (dry run)" : ""}`, `Config:  ${JSON.stringify(config)}`];
  if (report.cannotSync !== null) lines.push(`canSync: refused: ${report.cannotSync}`);
  else if (report.dryRun) lines.push("canSync: ok (sync not run)");
  const result = report.result;
  if (result && report.cannotSync === null) {
    const status = result.success ? (result.skipped ? "skipped" : "success") : "FAILED";
    lines.push(`Result:  ${status}  added=${result.eventsAdded} updated=${result.eventsUpdated}  ${result.durationMs}ms`);
    if (result.error) lines.push(`Error:   ${result.error}`);
    if (result.metadata) lines.push(`Metadata: ${JSON.stringify(result.metadata)}`);
  }
  const log = report.syncLog;
  if (log) {
    const error = log.error ? ` error=${log.error}` : "";
    lines.push(
      `sync_log #${log.id}: success=${log.success} skipped=${log.skipped} added=${log.events_added} updated=${log.events_updated}${error}`,
    );
  }
  return lines;
}

function formatChanges(report: SourceRunReport, state: unknown): string[] {
  if (report.dryRun) return [];
  const lines: string[] = [];
  for (const [label, changes] of [
    ["inserted", report.events.inserted],
    ["updated", report.events.updated],
  ] as const) {
    lines.push(`Events ${label}: ${changes.count}`);
    for (const [type, count] of Object.entries(changes.byType)) lines.push(`  ${type.padEnd(40)} ${count}`);
    for (const sample of changes.samples) {
      lines.push(
        `    #${sample.id} ${sample.timestamp ?? "-"} ${sample.type} [${sample.source_account ?? "-"}] ${truncate(sample.title, 60)}`,
      );
    }
  }
  lines.push(`Events deleted: ${report.events.deleted}`);
  const stateEntries = Object.entries(state as Record<string, unknown>);
  lines.push(`sync_state: ${stateEntries.length === 0 ? "(empty)" : ""}`);
  for (const [key, value] of stateEntries) lines.push(`  ${key}: ${truncate(JSON.stringify(value), 200)}`);
  return lines;
}

/** TIMELINE_INBOX_PATH covers the base path only; --config can still name others for rclone to write. */
async function inboxPathsOutsideSandbox(): Promise<string[]> {
  const { loadConfig, resolveSourcePath } = await import("../config");
  const config = await loadConfig();
  const sandbox = dirname(config.inbox.base_path);
  const paths = Object.values(config.inbox.sources).map((source) => resolveSourcePath(config, source));
  if (config.inbox.archive_path) paths.push(config.inbox.archive_path);
  return paths.filter((path) => !isInside(resolve(path), sandbox));
}

async function main(request: OnceRequest): Promise<number> {
  // sqlite-vec must pick its SQLite library before any database opens, as in src/service.ts.
  configureBunSqliteForSqliteVec();
  const { findSyncSource, parseSettingAssignments, resolveSourceSettings, runSourceOnce, SourceRunError } = await import(
    "./once"
  );

  // Sources log progress with console.log; keep stdout for the JSON report alone.
  if (request.json) console.log = console.info = console.error;

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort("Interrupted"));

  let report: SourceRunReport;
  try {
    const source = findSyncSource(request.source);
    const config = parseSettingAssignments(source, request.set, request.callerDir);
    resolveSourceSettings(source, config);
    const outside = await inboxPathsOutsideSandbox();
    if (outside.length > 0) throw new SourceRunError(`--config names inbox paths outside the sandbox: ${outside.join(", ")}`);
    // Only now, so a rejected request creates nothing beside a caller's --db.
    const dbPath = process.env.TIMELINE_DB_PATH;
    if (!dbPath) throw new Error("once-main.ts needs TIMELINE_DB_PATH from once-cli.ts");
    mkdirSync(dirname(dbPath), { recursive: true });
    report = await runSourceOnce(source, {
      config,
      state: request.state,
      dryRun: request.dryRun,
      verbose: request.verbose,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof SourceRunError) {
      console.error(`sync:once: ${error.message}`);
      return EXIT_USAGE;
    }
    throw error;
  }

  const ok = report.cannotSync === null && (report.result?.success ?? true);
  const shown = { ...report, config: redact(report.config), state: redact(report.state) };
  if (request.json) {
    // Bun.write resolves once the pipe has taken it all; process.exit would drop what had not.
    await Bun.write(Bun.stdout, `${JSON.stringify(shown, null, 2)}\n`);
    return ok ? 0 : 1;
  }

  await Bun.write(Bun.stdout, `${[...formatOutcome(report, shown.config), ...formatChanges(report, shown.state)].join("\n")}\n`);
  return ok ? 0 : 1;
}

const raw = process.argv[2];
if (!raw) {
  console.error("once-main.ts is started by once-cli.ts; run `bun run sync:once --help`");
  process.exit(EXIT_USAGE);
}
main(JSON.parse(raw) as OnceRequest).then((code) => process.exit(code));
