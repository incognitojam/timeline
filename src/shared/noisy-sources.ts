import { sourceIdsWithTraits } from "./sources";

/**
 * High-volume machine-generated sources that are normally omitted from
 * derived text and search corpora unless explicitly requested.
 */
export const NOISY_MACHINE_SOURCES: readonly string[] = sourceIdsWithTraits((traits) => traits.noisy === true);
