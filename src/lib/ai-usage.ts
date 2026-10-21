/**
 * Token usage extraction and API-rate cost estimation for AI coding session
 * sources. Parsers preserve each assistant message's token accounting in
 * raw_data; this module normalizes the per-source shapes and prices them at
 * pay-as-you-go API rates. Only tokens are persisted (in raw_data) — dollar
 * figures are always computed at read time so historical rate changes can be
 * applied retroactively via the pricing table.
 */

/** Sources whose assistant events carry token usage in raw_data. */
export const AI_USAGE_SOURCES = new Set(["claude-code", "conductor", "amp", "opencode", "codex"]);

/**
 * SQL expression extracting the usage-bearing fields from raw_data in a
 * single JSON parse. Multi-path json_extract returns a JSON array
 * [model, usage, tokens]; feed the result to tokenUsageFromExtract().
 */
export const USAGE_EXTRACT_SQL = "json_extract(raw_data, '$.model', '$.usage', '$.tokens')";

export interface TokenUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** 5-minute-TTL cache writes (the default bucket when the source doesn't split). */
  cacheWrite5mTokens: number;
  /** 1-hour-TTL cache writes. */
  cacheWrite1hTokens: number;
}

// Claude SDK shape (claude-code, conductor raw_data.usage)
interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

// Amp raw_data.usage
interface AmpUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

// Codex raw_data.usage (OpenAI convention: cached ⊆ input, reasoning ⊆ output)
interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

// OpenCode raw_data.tokens
interface OpenCodeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hasTokens(u: TokenUsage): boolean {
  return u.inputTokens > 0 || u.outputTokens > 0 || u.cacheReadTokens > 0
    || u.cacheWrite5mTokens > 0 || u.cacheWrite1hTokens > 0;
}

/**
 * Normalize one assistant event's usage from the values extracted by
 * USAGE_EXTRACT_SQL. Returns null when the event carries no token accounting
 * (user rows, cancelled turns, sources without usage data).
 */
export function tokenUsageFromExtract(source: string, extractJson: string | null): TokenUsage | null {
  if (!extractJson) return null;
  let extracted: unknown;
  try {
    extracted = JSON.parse(extractJson);
  } catch {
    return null;
  }
  if (!Array.isArray(extracted)) return null;
  const [model, usage, tokens] = extracted as [unknown, unknown, unknown];
  return extractTokenUsage(source, {
    model: typeof model === "string" ? model : null,
    usage: usage && typeof usage === "object" ? usage : null,
    tokens: tokens && typeof tokens === "object" ? tokens : null,
  });
}

/** Normalize one assistant event's usage from already-parsed raw_data fields. */
export function extractTokenUsage(
  source: string,
  raw: { model: string | null; usage: object | null; tokens: object | null }
): TokenUsage | null {
  let result: TokenUsage | null = null;

  if (source === "claude-code" || source === "conductor") {
    const usage = raw.usage as SdkUsage | null;
    if (usage) {
      const creation = num(usage.cache_creation_input_tokens);
      const split1h = num(usage.cache_creation?.ephemeral_1h_input_tokens);
      result = {
        model: raw.model,
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: num(usage.cache_read_input_tokens),
        cacheWrite5mTokens: creation - split1h,
        cacheWrite1hTokens: split1h,
      };
    }
  } else if (source === "amp") {
    const usage = raw.usage as AmpUsage | null;
    if (usage) {
      result = {
        model: usage.model ?? raw.model,
        inputTokens: num(usage.inputTokens),
        outputTokens: num(usage.outputTokens),
        cacheReadTokens: num(usage.cacheReadInputTokens),
        cacheWrite5mTokens: num(usage.cacheCreationInputTokens),
        cacheWrite1hTokens: 0,
      };
    }
  } else if (source === "codex") {
    const usage = raw.usage as CodexUsage | null;
    if (usage) {
      const cached = num(usage.cached_input_tokens);
      result = {
        model: raw.model,
        // OpenAI reports cached tokens as a subset of input_tokens; subtract
        // so the buckets stay disjoint for pricing. reasoning_output_tokens
        // is likewise already inside output_tokens.
        inputTokens: num(usage.input_tokens) - cached,
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: cached,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      };
    }
  } else if (source === "opencode") {
    const tokens = raw.tokens as OpenCodeTokens | null;
    if (tokens) {
      result = {
        model: raw.model,
        inputTokens: num(tokens.input),
        // Anthropic bills reasoning tokens as output; OpenCode counts them separately.
        outputTokens: num(tokens.output) + num(tokens.reasoning),
        cacheReadTokens: num(tokens.cache?.read),
        cacheWrite5mTokens: num(tokens.cache?.write),
        cacheWrite1hTokens: 0,
      };
    }
  }

  return result && hasTokens(result) ? result : null;
}

/** USD per million tokens. */
export interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

interface ModelPricing extends ModelRates {
  /** Matched against the model id with any trailing -YYYYMMDD suffix stripped. */
  model: string;
  /**
   * ISO date this rate card took effect; entries without one apply from the
   * beginning. When a model gets repriced, add a new entry with `from` set —
   * lookupModelRates picks the latest entry not after the message timestamp.
   */
  from?: string;
}

function rates(input: number, output: number): ModelRates {
  // Anthropic's standard multipliers: cache read 0.1×, 5m write 1.25×, 1h write 2×.
  return { input, output, cacheRead: input * 0.1, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
}

function openaiRates(input: number, cachedInput: number, output: number): ModelRates {
  // OpenAI's automatic prompt caching has no write charge, and the cached
  // discount varies by model family (10% for gpt-5.x, 25% for o-series),
  // so the cached rate is explicit rather than derived.
  return { input, output, cacheRead: cachedInput, cacheWrite5m: 0, cacheWrite1h: 0 };
}

// Rates from Anthropic's official pricing table
// (https://platform.claude.com/docs/en/about-claude/pricing#model-pricing,
// fetched 2026-07-09); pre-Claude-4 legacy models from their historical
// published rates. Models absent here (e.g. non-Anthropic ids) have their
// tokens counted but excluded from dollar totals (surfaced via costUsd:
// null). Long-context (>200k input) surcharge tiers are not modelled.
const MODEL_PRICING: ModelPricing[] = [
  { model: "claude-fable-5", ...rates(10, 50) },
  // Sonnet 5 introductory pricing runs through 2026-08-31; standard rates
  // take effect 2026-09-01.
  { model: "claude-sonnet-5", ...rates(2, 10) },
  { model: "claude-sonnet-5", from: "2026-09-01", ...rates(3, 15) },
  { model: "claude-opus-4-8", ...rates(5, 25) },
  { model: "claude-opus-4-7", ...rates(5, 25) },
  { model: "claude-opus-4-6", ...rates(5, 25) },
  { model: "claude-opus-4-5", ...rates(5, 25) },
  { model: "claude-opus-4-1", ...rates(15, 75) },
  { model: "claude-opus-4", ...rates(15, 75) },
  { model: "claude-3-opus", ...rates(15, 75) },
  { model: "claude-sonnet-4-6", ...rates(3, 15) },
  { model: "claude-sonnet-4-5", ...rates(3, 15) },
  { model: "claude-sonnet-4", ...rates(3, 15) },
  { model: "claude-3-7-sonnet", ...rates(3, 15) },
  { model: "claude-3-5-sonnet", ...rates(3, 15) },
  { model: "claude-haiku-4-5", ...rates(1, 5) },
  { model: "claude-3-5-haiku", ...rates(0.8, 4) },
  // OpenAI models used by Codex CLI, from developers.openai.com/api/docs/pricing
  // (fetched 2026-07-09; gpt-5.4 cross-checked against models.dev/api.json).
  // gpt-5.5's >272k-input surcharge tier ($10/$1/$45) is not modelled.
  { model: "gpt-5.5", ...openaiRates(5, 0.5, 30) },
  { model: "gpt-5.4", ...openaiRates(2.5, 0.25, 15) },
  { model: "gpt-5.3-codex", ...openaiRates(1.75, 0.175, 14) },
  { model: "gpt-5.2-codex", ...openaiRates(1.75, 0.175, 14) },
  { model: "gpt-5.1-codex", ...openaiRates(1.25, 0.125, 10) },
  { model: "gpt-5.1", ...openaiRates(1.25, 0.125, 10) },
  { model: "gpt-5-codex", ...openaiRates(1.25, 0.125, 10) },
  { model: "gpt-5", ...openaiRates(1.25, 0.125, 10) },
];

/** Strip a trailing snapshot date (e.g. claude-opus-4-5-20251101 → claude-opus-4-5). */
function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/**
 * Rates in effect for a model at a given time. Null for unknown models —
 * callers must surface unpriced tokens rather than silently defaulting.
 */
export function lookupModelRates(model: string, timestamp?: string | null): ModelRates | null {
  const id = normalizeModelId(model);
  // No timestamp means "price it at today's rates", not "latest card ever" —
  // otherwise a future-dated entry would apply before its effective date.
  const at = timestamp ?? new Date().toISOString();
  let best: ModelPricing | null = null;
  for (const entry of MODEL_PRICING) {
    if (entry.model !== id) continue;
    if (entry.from && entry.from > at) continue;
    if (!best || (entry.from ?? "") > (best.from ?? "")) best = entry;
  }
  if (!best) return null;
  const { input, output, cacheRead, cacheWrite5m, cacheWrite1h } = best;
  return { input, output, cacheRead, cacheWrite5m, cacheWrite1h };
}

/**
 * Estimated pay-as-you-go API cost in USD for one usage record, at the rates
 * in effect at `timestamp`. Null when the model is unknown or unpriced.
 */
export function estimateCostUsd(usage: TokenUsage, timestamp?: string | null): number | null {
  if (!usage.model) return null;
  const r = lookupModelRates(usage.model, timestamp);
  if (!r) return null;
  return (
    usage.inputTokens * r.input +
    usage.outputTokens * r.output +
    usage.cacheReadTokens * r.cacheRead +
    usage.cacheWrite5mTokens * r.cacheWrite5m +
    usage.cacheWrite1hTokens * r.cacheWrite1h
  ) / 1_000_000;
}
