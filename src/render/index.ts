import { renderDiscordEvent } from "../platforms/discord/render";
import type { EventRenderer } from "./types";

export interface RendererRegistration {
  version: number;
  render: EventRenderer;
}

const renderers: ReadonlyMap<string, RendererRegistration> = new Map([
  ["discord", { version: 1, render: renderDiscordEvent }],
]);

export function getRenderer(source: string): EventRenderer | undefined {
  return renderers.get(source)?.render;
}

export function getRegisteredRenderers(): ReadonlyMap<string, RendererRegistration> {
  return renderers;
}
