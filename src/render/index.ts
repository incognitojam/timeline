import { PLATFORMS } from "../platforms";
import { collectRenderers } from "../platforms/registry";
import type { EventRenderer, RendererRegistration } from "./types";

export type { RendererRegistration } from "./types";

const renderers = collectRenderers(PLATFORMS);

export function getRenderer(source: string): EventRenderer | undefined {
  return renderers.get(source)?.render;
}

export function getRegisteredRenderers(): ReadonlyMap<string, RendererRegistration> {
  return renderers;
}
