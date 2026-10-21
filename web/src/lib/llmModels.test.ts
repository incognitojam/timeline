import { describe, it, expect } from "vitest";
import { formatContextLength, groupModelsByProvider, type ModelOption } from "./llmModels";

function model(id: string, provider: string, contextLength = 8192): ModelOption {
  return { id, name: id, price: "local", contextLength, provider };
}

describe("formatContextLength", () => {
  it("renders power-of-two windows in binary-k so 131072 reads as 128k", () => {
    expect(formatContextLength(8192)).toBe("8k");
    expect(formatContextLength(24576)).toBe("24k");
    expect(formatContextLength(131072)).toBe("128k");
    expect(formatContextLength(262144)).toBe("256k");
  });

  it("renders non-power-of-two windows in decimal-k and scales to M", () => {
    expect(formatContextLength(200000)).toBe("200k");
    expect(formatContextLength(1000000)).toBe("1M");
    expect(formatContextLength(1500000)).toBe("1.5M");
  });
});

describe("groupModelsByProvider", () => {
  it("groups by provider preserving first-seen order", () => {
    const groups = groupModelsByProvider([
      model("google/gemini", "openrouter"),
      model("qwen3-8b", "lmstudio"),
      model("openai/gpt", "openrouter"),
    ]);
    expect(groups.map((g) => g.provider)).toEqual(["openrouter", "lmstudio"]);
    expect(groups[0].models.map((m) => m.id)).toEqual(["google/gemini", "openai/gpt"]);
    expect(groups[1].models.map((m) => m.id)).toEqual(["qwen3-8b"]);
  });

  it("returns an empty array for no models", () => {
    expect(groupModelsByProvider([])).toEqual([]);
  });
});
