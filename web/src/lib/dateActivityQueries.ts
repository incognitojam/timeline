import {
  createQuery,
  queryOptions as defineQueryOptions,
} from "@tanstack/solid-query";

export interface DateActivity {
  date: string;
  eventCount: number;
}

export interface DateActivityResponse {
  dates: DateActivity[];
}

const DATE_ACTIVITY_QUERY_KEY = "timeline-date-index";
const DATE_ACTIVITY_STALE_TIME_MS = 30_000;
const DATE_ACTIVITY_GC_TIME_MS = 30 * 60_000;
const DATE_ACTIVITY_REFETCH_INTERVAL_MS = 60_000;

export const dateActivityQueryKey = () => [DATE_ACTIVITY_QUERY_KEY] as const;

async function fetchDateActivityIndex(
  signal: AbortSignal,
): Promise<DateActivityResponse> {
  const response = await fetch("/api/timeline/date-index", { signal });
  if (!response.ok) throw new Error("Failed to fetch date activity index");
  return response.json();
}

export function dateActivityQueryOptions() {
  return defineQueryOptions({
    queryKey: dateActivityQueryKey(),
    queryFn: ({ signal }) => fetchDateActivityIndex(signal),
    staleTime: DATE_ACTIVITY_STALE_TIME_MS,
    gcTime: DATE_ACTIVITY_GC_TIME_MS,
    refetchOnWindowFocus: true,
    refetchInterval: DATE_ACTIVITY_REFETCH_INTERVAL_MS,
  });
}

export function useDateActivityQuery() {
  return createQuery(() => dateActivityQueryOptions());
}
