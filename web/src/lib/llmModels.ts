/** A summary/journal model option, as returned by GET /api/summary/models. */
export interface ModelOption {
  id: string;
  name: string;
  price: string;
  contextLength: number;
  provider: string;
}

export function fetchModels(): Promise<ModelOption[]> {
  return fetch("/api/summary/models")
    .then((r) => r.json())
    .then((j) => j.models as ModelOption[]);
}

/** Group models by provider, preserving server order, for <optgroup> rendering. */
export function groupModelsByProvider(models: ModelOption[]): { provider: string; models: ModelOption[] }[] {
  const groups: { provider: string; models: ModelOption[] }[] = [];
  for (const model of models) {
    const existing = groups.find((g) => g.provider === model.provider);
    if (existing) existing.models.push(model);
    else groups.push({ provider: model.provider, models: [model] });
  }
  return groups;
}

/**
 * Compact context-window label for the picker, e.g. 24576 → "24k", 131072 →
 * "128k", 1_000_000 → "1M". Divides by 1024 for power-of-two windows (the common
 * case, so 131072 reads as "128k" not "131k") and by 1000 otherwise.
 */
export function formatContextLength(tokens: number): string {
  const k = tokens % 1024 === 0 ? tokens / 1024 : Math.round(tokens / 1000);
  if (k >= 1000) {
    const m = k / 1000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  return `${k}k`;
}
