import type { Database } from "bun:sqlite";
import type { SeedSource } from "../seed/context";
import { DECLARED_SOURCES } from "../shared/sources";
import type { PlatformSource } from "./types";

export interface EventPair {
  source: string;
  type: string;
  count: number;
}

function matchesDeclaration(declared: string, type: string): boolean {
  return declared.endsWith("*") ? type.startsWith(declared.slice(0, -1)) : declared === type;
}

function isDeclared(declared: readonly string[] | undefined, type: string): boolean {
  return declared?.some((entry) => matchesDeclaration(entry, type)) ?? false;
}

function eventPairs(db: Database): EventPair[] {
  return db
    .query<EventPair, []>(
      "SELECT source, type, COUNT(*) AS count FROM events GROUP BY source, type ORDER BY source, type",
    )
    .all();
}

/** Stored (source, type) pairs that no source declares, in either current or legacy types. */
export function undeclaredEventPairs(
  db: Database,
  sources: readonly PlatformSource[] = DECLARED_SOURCES,
): EventPair[] {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return eventPairs(db).filter(({ source, type }) => {
    const declared = byId.get(source);
    return !isDeclared(declared?.eventTypes, type) && !isDeclared(declared?.legacyEventTypes, type);
  });
}

/** Declarations with no stored events. Expected for many, but this is how stale ones surface. */
export function unusedDeclarations(
  db: Database,
  sources: readonly PlatformSource[] = DECLARED_SOURCES,
): { source: string; type: string; legacy: boolean }[] {
  const pairs = eventPairs(db);
  const unused = (source: string, entries: readonly string[] | undefined, legacy: boolean) =>
    (entries ?? [])
      .filter((entry) => !pairs.some((pair) => pair.source === source && matchesDeclaration(entry, pair.type)))
      .map((type) => ({ source, type, legacy }));
  return sources.flatMap((source) => [
    ...unused(source.id, source.eventTypes, false),
    ...unused(source.id, source.legacyEventTypes, true),
  ]);
}

/** Pairs a seed generator promises that its source doesn't declare as written today. */
export function undeclaredSeedPairs(
  seeds: readonly SeedSource[],
  sources: readonly PlatformSource[] = DECLARED_SOURCES,
): string[] {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return seeds.flatMap((seed) =>
    Object.entries(seed.produces).flatMap(([source, types]) =>
      types
        .filter((type) => !isDeclared(byId.get(source)?.eventTypes, type))
        .map((type) => `${seed.name}: ${source}/${type}`),
    ),
  );
}
