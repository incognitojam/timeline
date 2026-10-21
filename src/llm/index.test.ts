import { afterAll, describe, test, expect } from "bun:test";
import type { LlmConfig } from "../config/types";
import {
  getContextLength,
  getDefaultModel,
  getModels,
  initProviders,
  resolveLanguageModel,
  resolveLocalContextLength,
} from "./index";

/**
 * A fetch stub so tests never touch the network or a local LM Studio. Returns a
 * JSON body for the first URL substring that matches, else 404.
 */
function stubFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, body] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

/** Discovery stub that returns no models — for tests that don't assert on the catalogue. */
const noModels = stubFetch({ models: { data: [] } });

// These tests mutate the process-wide provider registry (the "no providers" case
// empties it). bun shares module state across test files, so restore a working
// default afterward to match test/setup.ts and avoid poisoning later files.
afterAll(async () => {
  await initProviders(
    { providers: { test: { kind: "openai-compatible", base_url: "http://llm.test/v1", models: ["test-model"] } } },
    { fetch: noModels },
  );
});

/** A resolved AI SDK model exposes its provider + model id — enough to assert routing. */
function routed(ref: string): { provider: string; modelId: string } {
  const model = resolveLanguageModel(ref) as unknown as { provider: string; modelId: string };
  return { provider: model.provider, modelId: model.modelId };
}

describe("no baked-in default provider", () => {
  test("getDefaultModel throws when no [llm.providers] are configured", async () => {
    await initProviders({ providers: {} }, { fetch: noModels });
    expect(() => getDefaultModel()).toThrow(/No LLM providers are configured/);
  });
});

describe("initProviders validation", () => {
  test("rejects an openai-compatible provider without a base_url", () => {
    const bad: LlmConfig = { providers: { local: { kind: "openai-compatible" } } };
    expect(() => initProviders(bad, { fetch: noModels })).toThrow(/base_url/);
  });
});

describe("model reference resolution", () => {
  // Default provider = first configured. Its models use bare ids; others are "<provider>/<id>".
  const config: LlmConfig = {
    providers: {
      openrouter: {
        kind: "openrouter",
        api_key_env: "OPENROUTER_API_KEY",
        models: ["google/gemini-3.1-flash-lite"],
      },
      lmstudio: {
        kind: "openai-compatible",
        base_url: "http://127.0.0.1:1234/v1",
        models: ["qwen3-8b"],
        context_length: 8192,
      },
    },
  };

  test("a bare OpenRouter id routes to the default provider (its '/' is not a provider split)", async () => {
    await initProviders(config, { fetch: noModels });
    const { provider, modelId } = routed("google/gemini-3.1-flash-lite");
    expect(provider).toBe("openrouter");
    expect(modelId).toBe("google/gemini-3.1-flash-lite");
  });

  test("a '<provider>/<id>' ref routes to the named openai-compatible provider", async () => {
    await initProviders(config, { fetch: noModels });
    const { provider, modelId } = routed("lmstudio/qwen3-8b");
    expect(provider).toContain("lmstudio");
    expect(modelId).toBe("qwen3-8b");
  });

  test("getContextLength uses the provider's configured window for local models", async () => {
    await initProviders(config, { fetch: noModels });
    expect(getContextLength("lmstudio/qwen3-8b")).toBe(8192);
  });
});

describe("getDefaultModel", () => {
  test("returns the first configured model of the default provider, addressed bare", async () => {
    // lmstudio first => default provider => its models are bare.
    const config: LlmConfig = {
      providers: {
        lmstudio: {
          kind: "openai-compatible",
          base_url: "http://127.0.0.1:1234/v1",
          models: ["qwen3-8b", "llama-3.1-8b"],
        },
      },
    };
    await initProviders(config, { fetch: noModels });
    expect(getDefaultModel()).toBe("qwen3-8b");
  });
});

describe("openai-compatible discovery via LM Studio native metadata", () => {
  test("excludes embedding models and uses each model's loaded context window", async () => {
    const config: LlmConfig = {
      providers: {
        lmstudio: { kind: "openai-compatible", base_url: "http://lmstudio.test/v1" },
      },
    };
    const fetchStub = stubFetch({
      "/api/v0/models": {
        data: [
          { id: "gemma-chat", type: "vlm", loaded_context_length: 24576, max_context_length: 262144 },
          { id: "bge-embed", type: "embeddings", max_context_length: 8192 },
        ],
      },
    });

    await initProviders(config, { fetch: fetchStub });
    const models = getModels();

    // Embedding model dropped; lmstudio is the only (default) provider, so ids are bare.
    expect(models.map((m) => m.id)).toEqual(["gemma-chat"]);
    // The loaded window wins, not max_context_length.
    expect(models[0].contextLength).toBe(24576);
  });
});

describe("resolveLocalContextLength", () => {
  test("the loaded instance's window wins over config, max, and default", () => {
    expect(resolveLocalContextLength({ loaded: 24576, configured: 8192, max: 262144 })).toBe(24576);
  });

  test("falls back to configured, then max, then a conservative floor", () => {
    expect(resolveLocalContextLength({ configured: 16384, max: 262144 })).toBe(16384);
    expect(resolveLocalContextLength({ max: 262144 })).toBe(262144);
    expect(resolveLocalContextLength({})).toBe(8192);
  });
});
