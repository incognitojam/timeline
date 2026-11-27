import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visionGuard } from "./index";

describe("vision guard", () => {
  const models = { models: ["sol/preferred/model", "fallback/model"] };
  const previousConfig = process.env.TIMELINE_CONFIG;

  beforeAll(() => {
    const configPath = join(mkdtempSync(join(tmpdir(), "vision-guard-")), "config.toml");
    writeFileSync(configPath, [
      "[llm.providers.lmstudio]",
      'kind = "openai-compatible"',
      'base_url = "http://127.0.0.1:1234/v1"',
      "[llm.providers.sol]",
      'kind = "openai-compatible"',
      'base_url = "http://sol.example.com:1234/v1"',
    ].join("\n"));
    process.env.TIMELINE_CONFIG = configPath;
  });

  afterAll(() => {
    process.env.TIMELINE_CONFIG = previousConfig;
  });

  it("defers attachment descriptions when every configured model is unreachable or unlisted", async () => {
    const availability = { "sol/preferred/model": "not-listed", "fallback/model": "unavailable" } as const;
    expect(await visionGuard("attachment-descriptions", models, async (_config, model) =>
      availability[model as keyof typeof availability])).toEqual({
      guard: "vision",
      reason: "No vision model is available: sol/preferred/model is not listed by provider sol " +
        "(the machine serving it may be offline, or the model id may be wrong); the provider lmstudio for fallback/model is unavailable",
      detail: { vision: { availability: "unavailable" } },
    });
  });

  it("lets the run proceed when a model is reachable or the source is not attachment descriptions", async () => {
    expect(await visionGuard("attachment-descriptions", models, async (_config, model) =>
      model === "fallback/model" ? "not-vision" : "unavailable")).toBeNull();
    expect(await visionGuard("thumbhash", models, async () => "unavailable")).toBeNull();
  });
});
