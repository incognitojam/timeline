/**
 * LLM provider abstraction for text generation (day summaries, journal prompts).
 *
 * Providers are configured under `[llm.providers.<name>]` and are one of two
 * kinds: `openrouter` (hosted) or `openai-compatible` (any server exposing the
 * OpenAI REST surface — LM Studio, llama.cpp, vLLM, ...). This module resolves a
 * model reference to a Vercel AI SDK `LanguageModel` and aggregates the model
 * catalogue offered to the picker, so callers never bind to a specific provider.
 *
 * Model reference scheme: the first configured provider is the "default", and
 * its models are addressed by their bare model ID (e.g. "google/gemini-3.1-flash-lite")
 * so existing cached summaries — keyed by that string — keep hitting. Every other
 * provider's models are addressed "<provider>/<modelId>" (e.g. "lmstudio/qwen3-8b").
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import type { LlmConfig, LlmProviderConfig } from "../config/types";

/** A model offered to the picker, spanning all configured providers. */
export interface LlmModel {
  /** Reference used to request this model (bare for the default provider, "<provider>/<id>" otherwise). */
  id: string;
  /** Human-readable name for display. */
  name: string;
  /** Price hint, e.g. "$0.30/M" for hosted models or "local" for self-hosted ones. */
  price: string;
  /** Context window in tokens. */
  contextLength: number;
  /** Configured provider name this model belongs to (for grouping in the UI). */
  provider: string;
}

const DEFAULT_CONTEXT_LENGTH = 131_072;
/**
 * Conservative context floor for an OpenAI-compatible model whose window we
 * can't determine (no LM Studio native metadata and no configured override).
 * Deliberately small: over-sending silently overflows a local model's real
 * window, so we'd rather chunk unnecessarily than exceed it.
 */
const DEFAULT_LOCAL_CONTEXT_LENGTH = 8_192;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Active provider registry, empty until initProviders() installs the configured set. */
let providers: Record<string, LlmProviderConfig> = {};
let providerOrder: string[] = [];

/** Cached aggregated model list (empty until discovery completes). */
let cachedModels: LlmModel[] = [];
/** Resolves when the initial discovery completes (success or failure). */
let modelsReady: Promise<void> | null = null;

/** The default provider is the first configured one; its models use bare IDs. */
function defaultProviderName(): string {
  const name = providerOrder[0];
  if (!name) throw new Error("No LLM providers are configured");
  return name;
}

function validateProvider(name: string, provider: LlmProviderConfig): void {
  if (provider.kind !== "openrouter" && provider.kind !== "openai-compatible") {
    throw new Error(`LLM provider "${name}" has unknown kind "${provider.kind}"`);
  }
  if (provider.kind === "openai-compatible" && !provider.base_url?.trim()) {
    throw new Error(`LLM provider "${name}" is openai-compatible but has no base_url`);
  }
}

/** Injectable dependencies. Tests stub `fetch` so discovery never hits the network. */
export interface LlmDeps {
  fetch?: typeof fetch;
}

/**
 * Install the configured providers and kick off model discovery. There is no
 * baked-in default provider — an empty `config.llm.providers` (no `[llm]`
 * config at all) leaves text generation unavailable until one is configured.
 * Discovery is non-blocking; await {@link waitForModels} for the catalogue.
 */
export function initProviders(config: LlmConfig, deps: LlmDeps = {}): Promise<void> {
  const entries = Object.entries(config.providers);
  for (const [name, provider] of entries) validateProvider(name, provider);
  providers = { ...config.providers };
  providerOrder = entries.map(([name]) => name);
  modelsReady = discoverModels(deps.fetch ?? fetch);
  return modelsReady;
}

/** Returns the cached model list (empty if discovery hasn't run or found nothing). */
export function getModels(): LlmModel[] {
  return cachedModels;
}

/** Waits for the initial discovery to complete, then returns the cached models. */
export async function waitForModels(): Promise<LlmModel[]> {
  if (modelsReady) await modelsReady;
  return cachedModels;
}

/** Model reference chosen when a request omits one — the first available (else first configured) model. */
export function getDefaultModel(): string {
  if (cachedModels.length > 0) return cachedModels[0].id;
  // Discovery hasn't populated yet (or failed): fall back to the first configured model.
  const name = defaultProviderName();
  const first = providers[name]?.models?.[0];
  if (!first) {
    throw new Error(`Default LLM provider "${name}" has no configured models and none were discovered`);
  }
  return modelRefFor(name, first);
}

/** Look up a model's context window, falling back to the provider's configured/default width. */
export function getContextLength(ref: string): number {
  const model = cachedModels.find((m) => m.id === ref);
  if (model) return model.contextLength;
  // Not discovered (e.g. a stale saved reference): use the configured override,
  // else a kind-appropriate default — conservative for local, generous for hosted.
  try {
    const { provider } = resolveProvider(ref);
    if (provider.context_length) return provider.context_length;
    return provider.kind === "openai-compatible" ? DEFAULT_LOCAL_CONTEXT_LENGTH : DEFAULT_CONTEXT_LENGTH;
  } catch {
    return DEFAULT_CONTEXT_LENGTH;
  }
}

/**
 * Resolve a local model's usable context window. The loaded instance's window is
 * ground truth for how much we can send, so it wins; an operator override
 * (config `context_length`) is the fallback for servers that don't report it,
 * then the model's max, then a conservative floor.
 */
export function resolveLocalContextLength(opts: {
  loaded?: number;
  configured?: number;
  max?: number;
}): number {
  return opts.loaded ?? opts.configured ?? opts.max ?? DEFAULT_LOCAL_CONTEXT_LENGTH;
}

/** Resolve a model reference to an AI SDK language model for the owning provider. */
export function resolveLanguageModel(ref: string): LanguageModel {
  const { name, provider, modelId } = resolveProvider(ref);
  const apiKey = provider.api_key_env ? process.env[provider.api_key_env] : undefined;

  if (provider.kind === "openrouter") {
    return createOpenRouter({ apiKey })(modelId);
  }

  if (!provider.base_url) {
    throw new Error(`LLM provider "${name}" is openai-compatible but has no base_url`);
  }
  return createOpenAICompatible({
    name,
    baseURL: provider.base_url,
    apiKey,
    includeUsage: true,
  })(modelId);
}

/** Build the reference for a model: bare for the default provider, "<provider>/<id>" otherwise. */
function modelRefFor(providerName: string, modelId: string): string {
  return providerName === defaultProviderName() ? modelId : `${providerName}/${modelId}`;
}

/** Split a reference into provider + model, resolving the provider config. */
function resolveProviderFromConfig(
  configuredProviders: Record<string, LlmProviderConfig>,
  configuredProviderOrder: string[],
  ref: string,
): { name: string; provider: LlmProviderConfig; modelId: string } {
  const defaultName = configuredProviderOrder[0];
  if (!defaultName) throw new Error("No LLM providers are configured");

  const slash = ref.indexOf("/");
  if (slash > 0) {
    const head = ref.slice(0, slash);
    // A qualified reference only if the head names a non-default provider;
    // bare OpenRouter IDs also contain "/" but belong to the default provider.
    if (head !== defaultName && configuredProviders[head]) {
      return { name: head, provider: configuredProviders[head], modelId: ref.slice(slash + 1) };
    }
  }
  return { name: defaultName, provider: configuredProviders[defaultName], modelId: ref };
}

function resolveProvider(ref: string): { name: string; provider: LlmProviderConfig; modelId: string } {
  return resolveProviderFromConfig(providers, providerOrder, ref);
}

/** Strip provider prefix and "(free)" suffix from an OpenRouter display name. */
function cleanModelName(name: string): string {
  const colonIdx = name.indexOf(": ");
  const stripped = colonIdx >= 0 ? name.slice(colonIdx + 2) : name;
  return stripped.replace(/\s*\(free\)\s*$/i, "").trim();
}

/** Derive a human-readable price string from per-token cost (e.g. "0.0000003" → "$0.30/M"). */
function formatPrice(promptCostPerToken: string): string {
  const cost = parseFloat(promptCostPerToken);
  if (!cost || cost === 0) return "free";
  const perMillion = cost * 1_000_000;
  if (perMillion >= 1) return `$${perMillion.toFixed(0)}/M`;
  if (perMillion >= 0.1) return `$${perMillion.toFixed(1)}/M`;
  return `$${perMillion.toFixed(2)}/M`;
}

interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

interface OpenAIModelsResponse {
  data?: Array<{ id?: unknown }>;
}

/** Per-model metadata from LM Studio's native REST API (richer than OpenAI /v1/models). */
interface NativeModelMeta {
  type?: string;
  loadedContext?: number;
  maxContext?: number;
}

interface LmStudioModelsResponse {
  data?: Array<{
    id?: unknown;
    type?: unknown;
    loaded_context_length?: unknown;
    max_context_length?: unknown;
  }>;
}

export type VisionAvailability = "unavailable" | "not-vision" | "available" | "unknown";

interface LmStudioVisionModelsResponse {
  models?: Array<{ key?: unknown; capabilities?: { vision?: unknown } }>;
}

/**
 * Check LM Studio's current native model state for vision support. This is
 * deliberately uncached: scheduler guards need the answer for this run.
 */
export async function getVisionAvailability(
  config: LlmConfig,
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VisionAvailability> {
  let provider: LlmProviderConfig;
  let modelId: string;
  try {
    ({ provider, modelId } = resolveProviderFromConfig(
      config.providers,
      Object.keys(config.providers),
      ref,
    ));
  } catch {
    return "unknown";
  }
  if (provider.kind !== "openai-compatible" || !provider.base_url) return "unknown";
  let origin: string;
  try { origin = new URL(provider.base_url).origin; } catch { return "unknown"; }
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/v1/models`, { headers: authHeaders(provider), signal: AbortSignal.timeout(3_000) });
  } catch { return "unavailable"; }
  if (!response.ok) return response.status >= 500 && response.status < 600 ? "unavailable" : "unknown";
  let json: LmStudioVisionModelsResponse;
  try { json = await response.json() as LmStudioVisionModelsResponse; } catch { return "unknown"; }
  if (!Array.isArray(json.models)) return "unknown";
  const model = json.models.find((item) => item.key === modelId);
  if (!model) return "not-vision";
  if (!model.capabilities || typeof model.capabilities.vision !== "boolean") return "unknown";
  return model.capabilities.vision ? "available" : "not-vision";
}

/** Bearer auth header for a provider whose api_key_env is set (local servers usually need none). */
function authHeaders(provider: LlmProviderConfig): Record<string, string> {
  const apiKey = provider.api_key_env ? process.env[provider.api_key_env] : undefined;
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Fetch per-model metadata from LM Studio's native endpoint ({origin}/api/v0/models),
 * which — unlike the OpenAI-compatible /v1/models — reports each model's type and the
 * context window of the *loaded* instance. Returns null for servers that don't expose
 * it (llama.cpp, vLLM, ...), so callers fall back to /v1/models + configured context.
 */
async function fetchLmStudioNativeModels(
  provider: LlmProviderConfig,
  fetchImpl: typeof fetch,
): Promise<Map<string, NativeModelMeta> | null> {
  if (!provider.base_url) return null;
  let origin: string;
  try {
    origin = new URL(provider.base_url).origin;
  } catch {
    return null;
  }
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/v0/models`, {
      headers: authHeaders(provider),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null; // unreachable / not an LM Studio server → fall back
  }
  if (!response.ok) return null;
  const json = (await response.json()) as LmStudioModelsResponse;
  if (!Array.isArray(json.data)) return null;
  const meta = new Map<string, NativeModelMeta>();
  for (const m of json.data) {
    if (typeof m.id !== "string") continue;
    meta.set(m.id, {
      type: typeof m.type === "string" ? m.type : undefined,
      loadedContext: typeof m.loaded_context_length === "number" ? m.loaded_context_length : undefined,
      maxContext: typeof m.max_context_length === "number" ? m.max_context_length : undefined,
    });
  }
  return meta;
}

/**
 * Discover the model catalogue across all configured providers. Each provider
 * is best-effort: a provider that can't be reached (or whose API key env var is
 * unset) contributes nothing rather than aborting the whole list, so a working
 * provider still populates the picker.
 */
async function discoverModels(fetchImpl: typeof fetch): Promise<void> {
  const collected: LlmModel[] = [];
  for (const name of providerOrder) {
    const provider = providers[name];
    // A provider whose configured key env var is empty can't authenticate —
    // omit it (its models would only fail on use). Lets an operator drop
    // OPENROUTER_API_KEY to get a clean local-only picker.
    if (provider.api_key_env && !process.env[provider.api_key_env]) continue;
    try {
      const models =
        provider.kind === "openrouter"
          ? await discoverOpenRouterModels(name, provider, fetchImpl)
          : await discoverOpenAICompatibleModels(name, provider, fetchImpl);
      collected.push(...models);
    } catch (error) {
      console.warn(`Failed to discover models for LLM provider "${name}":`, describeError(error));
    }
  }
  cachedModels = collected;
  const summary = providerOrder
    .map((name) => `${name}=${collected.filter((m) => m.provider === name).length}`)
    .join(", ");
  const modelLabel = collected.length === 1 ? "model" : "models";
  console.log(`Discovered ${collected.length} LLM ${modelLabel} [${summary || "none"}]`);
}

async function discoverOpenRouterModels(name: string, provider: LlmProviderConfig, fetchImpl: typeof fetch): Promise<LlmModel[]> {
  const wanted = provider.models;
  if (!wanted || wanted.length === 0) {
    console.warn(`OpenRouter provider "${name}" has no models configured; skipping (its catalogue is too large to list)`);
    return [];
  }
  const response = await fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const json = (await response.json()) as { data: OpenRouterModel[] };
  const byId = new Map(json.data.map((m) => [m.id, m]));
  const models: LlmModel[] = [];
  for (const id of wanted) {
    const m = byId.get(id);
    if (!m) {
      console.warn(`OpenRouter model not found: ${id}`);
      continue;
    }
    models.push({
      id: modelRefFor(name, id),
      name: cleanModelName(m.name),
      price: formatPrice(m.pricing.prompt),
      contextLength: provider.context_length ?? m.context_length,
      provider: name,
    });
  }
  return models;
}

async function discoverOpenAICompatibleModels(name: string, provider: LlmProviderConfig, fetchImpl: typeof fetch): Promise<LlmModel[]> {
  if (!provider.base_url) throw new Error("missing base_url"); // validated at init
  const native = await fetchLmStudioNativeModels(provider, fetchImpl);

  let ids: string[];
  if (provider.models?.length) {
    ids = provider.models;
  } else if (native) {
    // Auto-discovered from LM Studio: drop embedding models — they can't do chat completions.
    ids = [...native.keys()].filter((id) => native.get(id)?.type !== "embeddings");
  } else {
    ids = await fetchOpenAIModelIds(name, provider, fetchImpl);
  }

  return ids.map((id) => {
    const meta = native?.get(id);
    return {
      id: modelRefFor(name, id),
      name: id,
      price: "local",
      contextLength: resolveLocalContextLength({
        loaded: meta?.loadedContext,
        configured: provider.context_length,
        max: meta?.maxContext,
      }),
      provider: name,
    };
  });
}

async function fetchOpenAIModelIds(name: string, provider: LlmProviderConfig, fetchImpl: typeof fetch): Promise<string[]> {
  const base = provider.base_url?.replace(/\/$/, "") ?? "";
  const response = await fetchImpl(`${base}/models`, {
    headers: authHeaders(provider),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${base}/models`);
  const json = (await response.json()) as OpenAIModelsResponse;
  if (!Array.isArray(json.data)) throw new Error(`${base}/models returned no model list`);
  const ids = json.data.map((m) => m.id).filter((id): id is string => typeof id === "string");
  if (ids.length === 0) console.warn(`OpenAI-compatible provider "${name}" returned no models from ${base}/models`);
  return ids;
}

function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "request timed out";
  return error instanceof Error ? error.message : String(error);
}
