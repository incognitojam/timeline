/** Rewrites the AGENTS.md data sources table from platform metadata. */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PLATFORM_METAS } from "../src/platforms/metas";
import type { PlatformMeta, PlatformSource } from "../src/platforms/types";
import { SYSTEM_SOURCES } from "../src/shared/system-sources";

const START = "<!-- sources:start -->";
const END = "<!-- sources:end -->";

export const AGENTS_PATH = resolve(import.meta.dir, "../AGENTS.md");

function row(owner: string, source: PlatformSource): string[] {
  if (!source.eventTypes) return [];
  const types = source.eventTypes.map((type) => `\`${type}\``).join(", ");
  return [`| ${owner} | \`${source.id}\` | ${types} |`];
}

export function renderSourcesTable(
  metas: readonly PlatformMeta[] = PLATFORM_METAS,
  system: readonly PlatformSource[] = SYSTEM_SOURCES,
): string {
  const sorted = [...metas].sort((a, b) => a.id.localeCompare(b.id));
  return [
    "| Platform | Source | Event types |",
    "|----------|--------|-------------|",
    ...sorted.flatMap((meta) => meta.sources.flatMap((source) => row(meta.id, source))),
    ...system.flatMap((source) => row("(built in)", source)),
  ].join("\n");
}

export function withSourcesTable(markdown: string, table: string): string {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start === -1 || end < start) throw new Error(`AGENTS.md is missing the ${START} / ${END} markers`);
  return `${markdown.slice(0, start + START.length)}\n${table}\n${markdown.slice(end)}`;
}

if (import.meta.main) {
  writeFileSync(AGENTS_PATH, withSourcesTable(readFileSync(AGENTS_PATH, "utf8"), renderSourcesTable()));
}
