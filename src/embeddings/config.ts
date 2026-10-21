import { type EmbeddingsConfig, legacyEmbeddingEnvVarsSet } from "../config";
import { OpenAIEmbeddingClient } from "./client";
import type { ModelProfile } from "./db";

/**
 * The resolved embedding model: the model-profile record (minus the DB-assigned
 * id) plus the query prefix, which shapes only query vectors and so is not part
 * of the stored profile. The name is the stable handle a profile id is minted
 * from. Shared by the index CLI, the API, the semantic_search MCP tool, and the
 * eval script so all of them bind to the same profile and embed the same way.
 */
export type EmbeddingProfileConfig = Omit<ModelProfile, "id"> & { query_prefix: string; timeout_ms: number };

/** Protocol recorded on every profile; `[embeddings]` only speaks OpenAI-compatible. */
const EMBEDDING_PROVIDER = "openai-compatible";

const DEFAULT_TIMEOUT_SECONDS = 60;

export function notConfiguredMessage(): string {
  const legacy = legacyEmbeddingEnvVarsSet();
  const legacyNote = legacy.length > 0 ? ` ${legacy.join(", ")} ${legacy.length === 1 ? "is" : "are"} no longer read.` : "";
  return `Semantic search is not configured: add an [embeddings] section to config.toml (see docs/embeddings.md).${legacyNote}`;
}

export function resolveEmbeddingProfile(config: EmbeddingsConfig | undefined): EmbeddingProfileConfig {
  if (!config) throw new Error(notConfiguredMessage());
  return {
    name: config.profile || `${config.model}:${config.dimensions}`,
    provider: EMBEDDING_PROVIDER,
    endpoint: `${config.base_url.replace(/\/+$/, "")}/embeddings`,
    model: config.model,
    dimensions: config.dimensions,
    api_key_env: config.api_key_env ?? null,
    document_prefix: config.document_prefix ?? "",
    query_prefix: config.query_prefix ?? "",
    timeout_ms: (config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
  };
}

export function createEmbeddingClient(profile: EmbeddingProfileConfig): OpenAIEmbeddingClient {
  return new OpenAIEmbeddingClient({
    provider: profile.provider,
    endpoint: profile.endpoint,
    model: profile.model,
    dimensions: profile.dimensions,
    apiKeyEnv: profile.api_key_env ?? undefined,
    documentPrefix: profile.document_prefix,
    queryPrefix: profile.query_prefix,
    timeoutMs: profile.timeout_ms,
  });
}
