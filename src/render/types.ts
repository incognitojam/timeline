export interface RenderedEvent {
  title: string | null;
  content: string | null;
}

export interface EventRenderer {
  (rawData: Record<string, unknown>): RenderedEvent;
}
