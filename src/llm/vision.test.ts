import { describe, expect, it } from "bun:test";
import type { LlmConfig } from "../config/types";
import { getVisionAvailability } from ".";

const config: LlmConfig = {
  providers: {
    local: {
      kind: "openai-compatible",
      base_url: "http://lm.test/v1",
      models: ["model"],
    },
  },
};

function mocked(body: unknown, status = 200): typeof fetch {
  return Object.assign(
    async () => new Response(JSON.stringify(body), { status }),
    { preconnect: (() => {}) as typeof fetch.preconnect },
  ) as typeof fetch;
}

describe("getVisionAvailability", () => {
  it("distinguishes endpoint and model capability states", async () => {
    const unreachable = Object.assign(
      async () => {
        throw new Error("offline");
      },
      { preconnect: (() => {}) as typeof fetch.preconnect },
    ) as typeof fetch;
    expect(await getVisionAvailability(config, "model", unreachable)).toBe("unavailable");
    expect(await getVisionAvailability(config, "model", mocked({ models: [] }))).toBe("not-vision");
    expect(await getVisionAvailability(config, "model", mocked({ models: [{ key: "model", capabilities: { vision: false } }] }))).toBe("not-vision");
    expect(await getVisionAvailability(config, "model", mocked({ models: [{ key: "model", capabilities: { vision: true } }] }))).toBe("available");
    expect(await getVisionAvailability(config, "model", mocked({ models: [{ key: "model" }] }))).toBe("unknown");
  });

  it("defers for a server error but proceeds when the endpoint is absent", async () => {
    expect(await getVisionAvailability(config, "model", mocked({}, 503))).toBe("unavailable");
    expect(await getVisionAvailability(config, "model", mocked({}, 404))).toBe("unknown");
  });
});
