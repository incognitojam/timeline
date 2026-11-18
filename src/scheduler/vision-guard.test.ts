import { describe, expect, it } from "bun:test";
import { visionGuard } from "./index";

describe("vision guard", () => {
  const models = { models: ["preferred/model", "fallback/model"] };

  it("defers attachment descriptions when every configured model is unreachable or unlisted", async () => {
    const availability = { "preferred/model": "not-listed", "fallback/model": "unavailable" } as const;
    expect(await visionGuard("attachment-descriptions", models, async (_config, model) =>
      availability[model as keyof typeof availability])).toEqual({
      guard: "vision",
      reason: "No vision model is available: preferred/model is not listed by its provider " +
        "(the machine serving it may be offline, or the model id may be wrong); the provider for fallback/model is unavailable",
      detail: { vision: { availability: "unavailable" } },
    });
  });

  it("lets the run proceed when a model is reachable or the source is not attachment descriptions", async () => {
    expect(await visionGuard("attachment-descriptions", models, async (_config, model) =>
      model === "fallback/model" ? "not-vision" : "unavailable")).toBeNull();
    expect(await visionGuard("thumbhash", models, async () => "unavailable")).toBeNull();
  });
});
