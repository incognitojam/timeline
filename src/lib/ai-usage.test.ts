import { describe, expect, test } from "bun:test";
import { estimateCostUsd, extractTokenUsage, lookupModelRates, tokenUsageFromExtract } from "./ai-usage";

// Mirrors USAGE_EXTRACT_SQL output: json_extract(raw_data, '$.model', '$.usage', '$.tokens')
function extractJson(raw: { model?: unknown; usage?: unknown; tokens?: unknown }): string {
  return JSON.stringify([raw.model ?? null, raw.usage ?? null, raw.tokens ?? null]);
}

describe("tokenUsageFromExtract", () => {
  test("claude-code SDK usage with cache_creation split", () => {
    const usage = tokenUsageFromExtract("claude-code", extractJson({
      model: "claude-opus-4-5-20251101",
      usage: {
        input_tokens: 10,
        output_tokens: 200,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      },
    }));
    expect(usage).toEqual({
      model: "claude-opus-4-5-20251101",
      inputTokens: 10,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheWrite5mTokens: 100,
      cacheWrite1hTokens: 200,
    });
  });

  test("conductor SDK usage without cache_creation split defaults writes to 5m", () => {
    const usage = tokenUsageFromExtract("conductor", extractJson({
      model: "claude-opus-4-8",
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    }));
    expect(usage?.cacheWrite5mTokens).toBe(4);
    expect(usage?.cacheWrite1hTokens).toBe(0);
  });

  test("amp camelCase usage with model inside usage", () => {
    const usage = tokenUsageFromExtract("amp", extractJson({
      model: "claude-sonnet-4-5-20250929",
      usage: {
        model: "claude-sonnet-4-5-20250929",
        inputTokens: 9,
        outputTokens: 159,
        cacheCreationInputTokens: 1532,
        cacheReadInputTokens: 14862,
      },
    }));
    expect(usage).toEqual({
      model: "claude-sonnet-4-5-20250929",
      inputTokens: 9,
      outputTokens: 159,
      cacheReadTokens: 14862,
      cacheWrite5mTokens: 1532,
      cacheWrite1hTokens: 0,
    });
  });

  test("opencode tokens shape folds reasoning into output", () => {
    const usage = tokenUsageFromExtract("opencode", extractJson({
      model: "claude-opus-4-1-20250805",
      tokens: { input: 5, output: 116, reasoning: 10, cache: { read: 31541, write: 243 } },
    }));
    expect(usage).toEqual({
      model: "claude-opus-4-1-20250805",
      inputTokens: 5,
      outputTokens: 126,
      cacheReadTokens: 31541,
      cacheWrite5mTokens: 243,
      cacheWrite1hTokens: 0,
    });
  });

  test("codex usage subtracts cached from input, keeps output as-is", () => {
    const usage = tokenUsageFromExtract("codex", extractJson({
      model: "gpt-5.5",
      usage: {
        input_tokens: 20497,
        cached_input_tokens: 11136,
        output_tokens: 598,
        reasoning_output_tokens: 309,
      },
    }));
    expect(usage).toEqual({
      model: "gpt-5.5",
      inputTokens: 9361,   // 20497 - 11136: cached is a subset of input
      outputTokens: 598,   // reasoning already included, not re-added
      cacheReadTokens: 11136,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    });
  });

  test("returns null for user rows, zero usage, and non-AI sources", () => {
    expect(tokenUsageFromExtract("claude-code", extractJson({}))).toBeNull();
    expect(tokenUsageFromExtract("claude-code", extractJson({
      model: "<synthetic>",
      usage: { input_tokens: 0, output_tokens: 0 },
    }))).toBeNull();
    expect(tokenUsageFromExtract("discord", extractJson({ usage: { input_tokens: 5 } }))).toBeNull();
    expect(tokenUsageFromExtract("claude-code", null)).toBeNull();
    expect(tokenUsageFromExtract("claude-code", "not json")).toBeNull();
  });
});

describe("lookupModelRates", () => {
  test("strips snapshot date suffixes", () => {
    const dated = lookupModelRates("claude-opus-4-5-20251101");
    const bare = lookupModelRates("claude-opus-4-5");
    expect(dated).toEqual(bare);
    expect(dated?.input).toBe(5);
    expect(dated?.output).toBe(25);
  });

  test("applies standard cache multipliers", () => {
    const r = lookupModelRates("claude-haiku-4-5-20251001");
    expect(r).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 });
  });

  test("unknown models return null", () => {
    expect(lookupModelRates("some-future-model")).toBeNull();
  });

  test("openai models have no cache-write rates", () => {
    expect(lookupModelRates("gpt-5.5")).toEqual({
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    });
    expect(lookupModelRates("gpt-5.2-codex")?.input).toBe(1.75);
  });

  test("effective-dated entries apply from their date", () => {
    // Sonnet 5: $2/$10 introductory through 2026-08-31, $3/$15 from 2026-09-01
    expect(lookupModelRates("claude-sonnet-5", "2026-07-15T12:00:00Z")?.input).toBe(2);
    expect(lookupModelRates("claude-sonnet-5", "2026-09-01T00:00:00Z")?.input).toBe(3);
    expect(lookupModelRates("claude-sonnet-5", "2027-01-01T00:00:00Z")?.output).toBe(15);
  });

  test("fable-5 priced from the official table", () => {
    expect(lookupModelRates("claude-fable-5")).toEqual({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite5m: 12.5,
      cacheWrite1h: 20,
    });
  });
});

describe("estimateCostUsd", () => {
  test("prices each token bucket at its own rate", () => {
    // opus-4-5: $5 in, $25 out, $0.50 read, $6.25 write-5m, $10 write-1h per MTok
    const cost = estimateCostUsd({
      model: "claude-opus-4-5-20251101",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5 + 25 + 0.5 + 6.25 + 10, 10);
  });

  test("null for unpriced or missing model", () => {
    const usage = {
      model: "some-future-model",
      inputTokens: 100,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    };
    expect(estimateCostUsd(usage)).toBeNull();
    expect(estimateCostUsd({ ...usage, model: null })).toBeNull();
  });
});

describe("extractTokenUsage", () => {
  test("accepts already-parsed raw_data fields", () => {
    const usage = extractTokenUsage("claude-code", {
      model: "claude-opus-4-8",
      usage: { input_tokens: 7, output_tokens: 11 },
      tokens: null,
    });
    expect(usage?.inputTokens).toBe(7);
    expect(usage?.outputTokens).toBe(11);
  });
});
