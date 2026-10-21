export type RouteParamValue = string | string[] | null | undefined;

export function normalizeRouteParam(value: RouteParamValue): string {
  if (!value) return "";
  return Array.isArray(value) ? value[0] ?? "" : value;
}

export function routePageIndex(value: RouteParamValue): number {
  const parsed = parseInt(normalizeRouteParam(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
}

export function routePageOffset(value: RouteParamValue, pageSize: number): number {
  return routePageIndex(value) * pageSize;
}
