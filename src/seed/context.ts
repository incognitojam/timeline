import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import type { PersonKey } from "./persona";
import { TIME_ZONE } from "./persona";
import { Rng } from "./rng";

/**
 * One generator per data source. A generator writes a synthetic export in the
 * source's real format under `ctx.stage(name)` (or builds the same API payloads
 * a sync would receive) and feeds it through the source's real importer, so
 * the seed follows the parsers whenever their formats or schemas change.
 */
export interface SeedSource {
  name: string;
  /**
   * Every (events.source → events.type) pair this generator must produce. The
   * runner fails the seed if any is missing, so a parser change that silently
   * drops a type is caught here rather than as an empty page.
   */
  produces: Readonly<Record<string, readonly string[]>>;
  seed(ctx: SeedContext): Promise<void>;
}

export interface SeedDay {
  /** YYYY-MM-DD in Alex's local time zone. */
  date: string;
  /** 0 for the first day of the range. */
  index: number;
  /** Days before the anchor (0 = anchor day). */
  daysAgo: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  isWeekend: boolean;
}

export interface SeedImageOptions {
  width: number;
  height: number;
  /** Base hue in degrees; a second hue is derived for the gradient. */
  hue: number;
  /** Distinguishes otherwise-identical images (and their content hashes). */
  variant?: number;
  format?: "png" | "jpeg";
}

export class SeedContext {
  /** First local date of the generated range. */
  readonly startDate: string;
  readonly days: readonly SeedDay[];
  private readonly identities = new Map<PersonKey, Set<string>>();

  constructor(
    readonly db: Database,
    readonly dbPath: string,
    readonly mediaRoot: string,
    readonly stagingRoot: string,
    /** Last local date of the generated range (normally today). */
    readonly anchorDate: string,
    readonly years: number,
  ) {
    const anchor = parseDate(anchorDate);
    const start = new Date(anchor);
    start.setUTCFullYear(start.getUTCFullYear() - years);
    start.setUTCDate(start.getUTCDate() + 1);
    this.startDate = formatDate(start);

    const days: SeedDay[] = [];
    const total = Math.round((anchor.getTime() - start.getTime()) / 86_400_000) + 1;
    for (let index = 0; index < total; index++) {
      const day = new Date(start.getTime() + index * 86_400_000);
      const weekday = day.getUTCDay();
      days.push({
        date: formatDate(day),
        index,
        daysAgo: total - 1 - index,
        weekday,
        isWeekend: weekday === 0 || weekday === 6,
      });
    }
    this.days = days;
  }

  /** Independent deterministic stream for a label (use the source name). */
  rng(label: string): Rng {
    return new Rng(`timeline-seed:${label}`);
  }

  /** Fresh directory for a source's synthetic export files. */
  stage(name: string): string {
    const dir = join(this.stagingRoot, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Write a staged file (creating parent directories) and return its path. */
  writeStaged(name: string, relativePath: string, content: string | Uint8Array): string {
    const path = join(this.stage(name), relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  /** The most recent `count` days (all days when count exceeds the range). */
  recentDays(count: number): readonly SeedDay[] {
    return this.days.slice(Math.max(0, this.days.length - count));
  }

  /**
   * ISO UTC timestamp (with milliseconds and Z) for a wall-clock time in
   * Alex's time zone. Minutes/seconds past 59 roll over naturally.
   */
  localIso(date: string, hour: number, minute = 0, second = 0): string {
    return this.localDate(date, hour, minute, second).toISOString();
  }

  /** Same as localIso, as a Date. */
  localDate(date: string, hour: number, minute = 0, second = 0): Date {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const guess = Date.UTC(y, m - 1, d, hour, minute, second);
    const offset = zoneOffsetMs(guess);
    const corrected = guess - offset;
    // Re-evaluate at the corrected instant so DST transition days stay right.
    return new Date(guess - zoneOffsetMs(corrected));
  }

  /** UTC offset (e.g. "-07:00") of Alex's zone at an instant. */
  localOffset(at: Date): string {
    const minutes = Math.round(zoneOffsetMs(at.getTime()) / 60_000);
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  }

  /**
   * Record that `identifier` (platform:id, as the importer writes it to
   * events.people) belongs to a persona member, so the contacts step can link
   * it once every importer has upserted its identities.
   */
  identify(person: PersonKey, identifier: string): void {
    let set = this.identities.get(person);
    if (!set) {
      set = new Set();
      this.identities.set(person, set);
    }
    set.add(identifier);
  }

  identifiedPeople(): ReadonlyMap<PersonKey, ReadonlySet<string>> {
    return this.identities;
  }

  /**
   * Small generated image (gradient + shapes, no text so output does not
   * depend on installed fonts). Deterministic for the same options.
   */
  async image(options: SeedImageOptions): Promise<Buffer> {
    const { width, height, hue, variant = 0, format = "jpeg" } = options;
    const second = (hue + 40 + (variant % 7) * 23) % 360;
    const cx = Math.round(width * (0.3 + ((variant * 37) % 40) / 100));
    const cy = Math.round(height * (0.35 + ((variant * 53) % 30) / 100));
    const r = Math.round(Math.min(width, height) * (0.12 + ((variant * 17) % 15) / 100));
    const ridge = Math.round(height * (0.6 + ((variant * 29) % 20) / 100));
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="hsl(${hue},65%,62%)"/><stop offset="1" stop-color="hsl(${second},55%,32%)"/>` +
      `</linearGradient></defs>` +
      `<rect width="${width}" height="${height}" fill="url(#g)"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsla(${(hue + 180) % 360},80%,85%,0.75)"/>` +
      `<path d="M0 ${height} L0 ${ridge} L${Math.round(width * 0.35)} ${Math.round(ridge - height * 0.18)} ` +
      `L${Math.round(width * 0.6)} ${Math.round(ridge - height * 0.05)} L${width} ${Math.round(ridge - height * 0.22)} ` +
      `L${width} ${height} Z" fill="hsla(${second},40%,18%,0.8)"/>` +
      `</svg>`;
    const pipeline = sharp(Buffer.from(svg));
    return format === "png"
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
      : await pipeline.jpeg({ quality: 70 }).toBuffer();
  }

  /**
   * Run an in-process importer inside one transaction. Many importers commit
   * row by row, which suits real exports but slows thousands of seeded events;
   * their own db.transaction() calls nest as savepoints. Not for runParserCli:
   * the subprocess would wait on this connection's write lock.
   */
  async inTransaction<T>(run: () => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const result = await run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Run a parser that only exposes a CLI (`bun run src/platforms/<platform>/parser.ts ...`). */
  async runParserCli(script: string, args: readonly string[], env: Record<string, string> = {}): Promise<void> {
    const path = resolve(import.meta.dir, "..", script);
    // Fold the WAL into the database from this fsync-free connection first, so
    // the subprocess's commits don't pay for checkpointing earlier generators.
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const proc = Bun.spawn([process.execPath, "run", path, ...args], {
      env: { ...process.env, ...env, TIMELINE_DB_PATH: this.dbPath, TIMELINE_MEDIA_PATH: this.mediaRoot },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (code !== 0) {
      throw new Error(`${script} exited with ${code}\n${stdout}\n${stderr}`);
    }
  }
}

const zoneFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Offset of TIME_ZONE from UTC at an instant, in ms (negative west of UTC). */
function zoneOffsetMs(utcMs: number): number {
  const parts = Object.fromEntries(
    zoneFormatter.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Parse a YYYY-MM-DD calendar date, rejecting impossible ones like 2026-02-30. */
export function parseDate(date: string): Date {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || formatDate(parsed) !== date) {
    throw new Error(`Expected a real calendar date as YYYY-MM-DD, got ${date}`);
  }
  return parsed;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today's date in Alex's time zone. */
export function todayInSeedZone(): string {
  const parts = Object.fromEntries(
    zoneFormatter.formatToParts(new Date()).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return `${parts.year}-${parts.month}-${parts.day}`;
}
