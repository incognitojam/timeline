import { expect, test } from "bun:test";
import { getRegisteredRenderers, getRenderer } from "./index";
import { renderDiscordEvent } from "../platforms/discord/render";

test("registers Discord's versioned event renderer", () => {
  expect(getRenderer("discord")).toBe(renderDiscordEvent);
  expect(getRegisteredRenderers().get("discord")).toEqual({
    version: 1,
    render: renderDiscordEvent,
  });
});
