import { describe, expect, it } from "bun:test";
import { visionGuardDecision } from "./index";

describe("vision guard", () => {
  it("skips only when every configured attachment description provider is unavailable", () => {
    expect(visionGuardDecision(
      "attachment-descriptions",
      { models: ["preferred/model", "fallback/model"] },
      ["unavailable", "unavailable"],
    )).toMatchObject({ guard: "vision" });
    expect(visionGuardDecision(
      "attachment-descriptions",
      { models: ["preferred/model", "fallback/model"] },
      ["unavailable", "not-vision"],
    )).toBeNull();
    expect(visionGuardDecision(
      "attachment-descriptions",
      { model: "local/model" },
      ["unavailable"],
    )).toMatchObject({ guard: "vision" });
    expect(visionGuardDecision("thumbhash", { model: "local/model" }, ["unavailable"])).toBeNull();
  });
});
