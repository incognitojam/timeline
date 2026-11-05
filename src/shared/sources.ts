import { PLATFORM_METAS } from "../platforms/metas";
import type { PlatformMeta, PlatformSource, SourceTraits } from "../platforms/types";
import { SYSTEM_SOURCES, type SystemSource } from "./system-sources";

export interface SourceDefinition {
  id: string;
  label: string;
  color: string;
}

export const DEFAULT_SOURCE_COLOR = "#9ca3af";

const PLATFORMS: readonly PlatformMeta[] = PLATFORM_METAS;

/** Every declared source, including the facts only the service needs. */
export const DECLARED_SOURCES: readonly PlatformSource[] = [
  ...PLATFORMS.flatMap((meta) => meta.sources),
  ...SYSTEM_SOURCES,
];

type DeclaredPlatformSource = (typeof PLATFORM_METAS)[number]["sources"][number];

/** Ids of the sources with a given conversation trait, as a literal union. */
export type ConversationSourceId<Kind extends SourceTraits["conversation"]> = Extract<
  DeclaredPlatformSource,
  { traits: { conversation: Kind } }
>["id"];

/** Ids of declared sources whose traits match, in `PLATFORM_METAS` order. */
export function sourceIdsWithTraits(matches: (traits: SourceTraits) => boolean): string[] {
  return DECLARED_SOURCES.filter((source) => source.traits && matches(source.traits)).map((source) => source.id);
}

/** Sources hidden until the user chooses to show them. */
export const DEFAULT_HIDDEN_SOURCES: readonly string[] = sourceIdsWithTraits((traits) => traits.defaultHidden === true);

/**
 * Source metadata shared by the service and web app. IDs are persisted in the
 * database and used in URLs; labels are presentation-only.
 */
export function buildSourceRegistry(
  metas: readonly PlatformMeta[],
  system: readonly SystemSource[],
): readonly SourceDefinition[] {
  const byId = new Map<string, SourceDefinition>();
  const add = (source: PlatformSource, color: string) => {
    if (byId.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
    byId.set(source.id, { id: source.id, label: source.label, color });
  };

  for (const meta of metas) {
    for (const source of meta.sources) add(source, source.color ?? meta.color);
  }
  for (const source of system) add(source, source.color);
  return [...byId.values()];
}

export const SOURCE_REGISTRY = buildSourceRegistry(PLATFORMS, SYSTEM_SOURCES);
const SOURCES_BY_ID = new Map(SOURCE_REGISTRY.map((source) => [source.id, source]));

export function getSourceDefinition(id: string): SourceDefinition | undefined {
  return SOURCES_BY_ID.get(id);
}

/** Unknown IDs stay visible so newly imported sources fail loudly in the UI. */
export function sourceLabel(id: string): string {
  return getSourceDefinition(id)?.label ?? id;
}

export function sourceColor(id: string): string {
  return getSourceDefinition(id)?.color ?? DEFAULT_SOURCE_COLOR;
}

export function isRegisteredSource(id: string): boolean {
  return SOURCES_BY_ID.has(id);
}
