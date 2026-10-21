export interface RangeEndpointState {
  startEventId: number | null;
  endEventId: number | null;
}

export function nextRangeEndpointState(
  state: RangeEndpointState,
  clickedEventId: number,
): RangeEndpointState {
  if (state.startEventId === null || state.endEventId !== null) {
    return { startEventId: clickedEventId, endEventId: null };
  }
  return { startEventId: state.startEventId, endEventId: clickedEventId };
}

export function getInclusiveLoadedRangeIds(
  loadedEventIds: number[],
  state: RangeEndpointState,
): Set<number> {
  if (state.startEventId === null || state.endEventId === null) return new Set();
  const startIndex = loadedEventIds.indexOf(state.startEventId);
  const endIndex = loadedEventIds.indexOf(state.endEventId);
  if (startIndex === -1 || endIndex === -1) return new Set();
  const [from, to] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
  return new Set(loadedEventIds.slice(from, to + 1));
}

export type RangeVisualPosition = "single" | "first" | "middle" | "last";

export function getRangeSelectionHighlightClass(position: RangeVisualPosition | undefined): string {
  if (!position) return "";
  const shared =
    "relative isolate my-1 after:pointer-events-none after:absolute after:inset-x-0 after:-z-10 after:bg-accent after:border-x after:border-border";
  if (position === "single") {
    return `${shared} after:inset-y-0 after:rounded-lg after:border-y after:shadow-sm after:shadow-primary/10`;
  }
  if (position === "first") {
    return `${shared} after:top-0 after:-bottom-1 after:rounded-t-lg after:border-t`;
  }
  if (position === "last") {
    return `${shared} after:-top-1 after:bottom-0 after:rounded-b-lg after:border-b`;
  }
  return `${shared} after:-inset-y-1`;
}

export function getRangeVisualPositions(
  loadedEventIds: number[],
  selectedEventIds: Set<number>,
): Map<number, RangeVisualPosition> {
  const selectedLoadedIds = loadedEventIds.filter((id) => selectedEventIds.has(id));
  const positions = new Map<number, RangeVisualPosition>();
  if (selectedLoadedIds.length === 0) return positions;

  if (selectedLoadedIds.length === 1) {
    positions.set(selectedLoadedIds[0], "single");
    return positions;
  }

  const lastIndex = selectedLoadedIds.length - 1;
  selectedLoadedIds.forEach((id, index) => {
    if (index === 0) positions.set(id, "first");
    else if (index === lastIndex) positions.set(id, "last");
    else positions.set(id, "middle");
  });
  return positions;
}
