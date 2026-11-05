import type { PlatformMeta } from "../types";

export const minecraftMeta = {
  id: "minecraft",
  color: "#62B047",
  sources: [
    {
      id: "minecraft",
      label: "Minecraft",
      eventTypes: [
        "minecraft:chat",
        "minecraft:join",
        "minecraft:leave",
        "minecraft:advancement",
        "minecraft:death",
      ],
    },
  ],
} as const satisfies PlatformMeta;
