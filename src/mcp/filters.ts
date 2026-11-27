/**
 * Checks for the source, type and date arguments the MCP tools take, so an
 * unknown or misformatted one is an error listing what is valid instead of a
 * reply that quietly matches nothing. Only declared names are consulted, never
 * the data, so an error tells nothing a tool would not.
 */

import { DECLARED_SOURCES } from "../shared/sources";

/** Each source that holds events, with the types it declares (current and legacy). */
const TYPES = new Map(
  DECLARED_SOURCES
    .filter((source) => source.eventTypes)
    .map((source) => [source.id, [...(source.eventTypes ?? []), ...(source.legacyEventTypes ?? [])]]),
);

/** An argument as an error repeats it, kept short. */
const echo = (value: string) => JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value);

const splitList = (value: string) => value.split(",").map((v) => v.trim()).filter(Boolean);

/** Types match as prefixes, so "message" is fine; a declared "reaction:*" takes any "reaction:" type. */
const declares = (source: string, type: string) =>
  (TYPES.get(source) ?? []).some((d) => d.endsWith("*") ? type.startsWith(d.slice(0, -1)) || d.startsWith(type) : d.startsWith(type));

/** An error for the first unknown source in a comma-separated list (or array), else null. */
export function unknownSource(value: string | readonly string[] | undefined, param = "source"): string | null {
  const unknown = (typeof value === "string" ? splitList(value) : value ?? []).find((s) => !TYPES.has(s));
  return unknown === undefined
    ? null
    : `Unknown source ${echo(unknown)}${param === "source" ? "" : ` in ${param}`}. Sources: ${[...TYPES.keys()].join(", ")}.`;
}

/** An error for the first type in a comma-separated list that none of these sources (or no source) declares, else null. */
export function unknownType(value: string | undefined, sources: string | undefined): string | null {
  const named = sources ? splitList(sources).filter((s) => TYPES.has(s)) : [];
  const unknown = splitList(typeFilter(value) ?? "").find((t) => !(named.length > 0 ? named : [...TYPES.keys()]).some((s) => declares(s, t)));
  if (unknown === undefined) return null;
  if (named.length === 0) return `Unknown type ${echo(unknown)}: no source declares it. Pass a source to list its types.`;
  const elsewhere = [...TYPES.keys()].filter((s) => declares(s, unknown));
  return `Unknown type ${echo(unknown)} for ${named.join(", ")}. Its types: ${[...new Set(named.flatMap((s) => TYPES.get(s) ?? []))].join(", ")}.`
    + (elsewhere.length > 0 ? ` Declared by: ${elsewhere.join(", ")}.` : "");
}

/** Types as the queries match them: each a prefix, so a trailing * (as a source declares, "activity:*") adds nothing. */
export function typeFilter<T extends string | undefined>(value: T): T {
  return (value === undefined ? value : splitList(value).map((t) => t.replace(/\*$/, "")).join(",")) as T;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const realDay = (value: string) => {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value.slice(0, 10));
};

/**
 * An error when a date argument does not parse: `day` takes YYYY-MM-DD,
 * `time` a date or an ISO 8601 time.
 */
export function badDate(value: string | undefined, param: string, kind: "day" | "time"): string | null {
  if (value === undefined) return null;
  const valid = kind === "day"
    ? DAY.test(value) && realDay(value)
    : TIME.test(value) && realDay(value) && !Number.isNaN(Date.parse(value));
  if (valid) return null;
  const expected = kind === "day"
    ? "a date as YYYY-MM-DD, e.g. 2026-11-14"
    : "a date as YYYY-MM-DD or an ISO 8601 time, e.g. 2026-11-14 or 2026-11-14T09:30:00Z";
  return `${param} ${echo(value)} is not ${expected}.`;
}

/**
 * A checked date-range bound as stored timestamps compare with it as text: a
 * date stays as it is, a time becomes UTC, so an offset bound still matches.
 */
export function utcBound<T extends string | undefined>(value: T): T {
  if (value === undefined || DAY.test(value)) return value;
  // A time with no zone has always meant UTC here, as it compares as text.
  return new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`).toISOString() as T;
}

/** The first error among the checks, as a tool error result, else null. */
export function filterError(...errors: (string | null)[]) {
  const error = errors.find((e) => e !== null);
  return error ? { isError: true, content: [{ type: "text" as const, text: `Error: ${error}` }] } : null;
}
