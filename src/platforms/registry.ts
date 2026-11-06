import type { RendererRegistration } from "../render/types";
import type { SeedSource } from "../seed/context";
import type { SyncSource } from "../sync/types";
import type { PlatformMeta } from "./types";

/** What one platform contributes to the service. See `metas.ts` for the web-safe half. */
export interface PlatformModule {
  meta: PlatformMeta;
  syncSources?: readonly SyncSource[];
  /** Keyed by the source id whose stored events the renderer rewrites. */
  renderers?: Readonly<Record<string, RendererRegistration>>;
  /**
   * Loaded on demand: the seed's generators and story data must not be
   * evaluated by the service, which imports every platform at startup.
   */
  loadSeeds?: () => Promise<readonly SeedSource[]>;
}

function assertUnique(kind: string, names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`Duplicate ${kind}: ${name}`);
    seen.add(name);
  }
}

export function collectSyncSources(
  platforms: readonly PlatformModule[],
  systemJobs: readonly SyncSource[],
): SyncSource[] {
  const sources = [...platforms.flatMap((platform) => platform.syncSources ?? []), ...systemJobs];
  assertUnique("sync source", sources.map((source) => source.name));
  return sources;
}

export function collectRenderers(
  platforms: readonly PlatformModule[],
): ReadonlyMap<string, RendererRegistration> {
  const entries = platforms.flatMap((platform) => Object.entries(platform.renderers ?? {}));
  assertUnique("renderer", entries.map(([source]) => source));
  return new Map(entries);
}

export async function collectSeedSources(
  platforms: readonly PlatformModule[],
): Promise<readonly SeedSource[]> {
  const loaded = await Promise.all(platforms.map((platform) => platform.loadSeeds?.() ?? []));
  const seeds = loaded.flat();
  assertUnique("seed generator", seeds.map((seed) => seed.name));
  return seeds;
}
