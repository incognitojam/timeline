export interface RenderedEvent {
  title: string | null;
  content: string | null;
}

export interface EventRenderer {
  (rawData: Record<string, unknown>): RenderedEvent;
}

export interface RendererRegistration {
  /** Bump to re-render stored events; the render sweep restarts from the first event. */
  version: number;
  render: EventRenderer;
}
