import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../lib/types";
import SleepCard from "./SleepCard";

function makeSleepEvent(raw: unknown, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 7,
    source: "google-health",
    source_id: "sleep:7",
    source_account: "user",
    type: "sleep",
    timestamp: "2026-01-14T23:00:00Z",
    end_timestamp: "2026-01-15T07:00:00Z",
    duration_ms: 28_800_000,
    title: "Sleep: 8h (94% efficiency)",
    content: "Deep: 120m, Light: 240m, REM: 90m, Awake: 30m\nTime in bed: 480m",
    latitude: null,
    longitude: null,
    location_name: null,
    people: null,
    tags: null,
    raw_data: JSON.stringify(raw),
    imported_at: "2026-01-15T08:00:00.000Z",
    import_batch: null,
    conversation_id: null,
    ...overrides,
  };
}

const stagedNight = {
  sleep: {
    summary: {
      minutesInSleepPeriod: "480",
      minutesAsleep: "450",
      stagesSummary: [
        { type: "AWAKE", minutes: "30" },
        { type: "LIGHT", minutes: "240" },
        { type: "DEEP", minutes: "120" },
        { type: "REM", minutes: "90" },
      ],
    },
  },
};

describe("SleepCard", () => {
  it("leads with time asleep and its qualifiers", () => {
    const { getByText } = render(() => <SleepCard event={makeSleepEvent(stagedNight)} />);
    expect(getByText("7h 30m")).toBeTruthy();
    expect(getByText("asleep")).toBeTruthy();
    expect(getByText("94%")).toBeTruthy();
    expect(getByText("8h")).toBeTruthy();
  });

  it("lists the stage breakdown lightest sleep first", () => {
    const { getByText } = render(() => <SleepCard event={makeSleepEvent(stagedNight)} />);
    for (const [stage, duration] of [["Awake", "30m"], ["REM", "1h 30m"], ["Light", "4h"], ["Deep", "2h"]]) {
      expect(getByText(stage)).toBeTruthy();
      expect(getByText(duration)).toBeTruthy();
    }
  });

  it("draws the stage composition as one donut arc per stage", () => {
    const { container } = render(() => <SleepCard event={makeSleepEvent(stagedNight)} />);
    const arcs = container.querySelectorAll("svg circle");
    expect(arcs.length).toBe(4);
    expect(arcs[0].querySelector("title")?.textContent).toBe("Awake 30m · 6%");
    // Arcs run in legend order, each starting where the previous one ended.
    const offsets = [...arcs].map((arc) => Number(arc.getAttribute("stroke-dashoffset")));
    expect(offsets[0]).toBe(0);
    expect(offsets.every((offset, i) => i === 0 || offset < offsets[i - 1])).toBe(true);
  });

  it("labels a nap and drops totals that only restate the headline", () => {
    const nap = {
      sleep: {
        summary: {
          minutesInSleepPeriod: "45",
          minutesAsleep: "45",
          stagesSummary: [{ type: "LIGHT", minutes: "45" }],
        },
      },
    };
    const { getByText, queryByText, container } = render(() => (
      <SleepCard event={makeSleepEvent(nap, { type: "sleep:nap", duration_ms: 2_700_000 })} />
    ));
    expect(getByText("nap")).toBeTruthy();
    expect(getByText("45m")).toBeTruthy();
    expect(queryByText("in bed")).toBeNull();
    expect(queryByText("Light")).toBeNull();
    expect(container.querySelectorAll("svg circle").length).toBe(0);
  });

  it("falls back to the recorded period when no time asleep is reported", () => {
    const { getByText } = render(() => <SleepCard event={makeSleepEvent({ sleep: {} })} />);
    expect(getByText("8h")).toBeTruthy();
    expect(getByText("in bed")).toBeTruthy();
  });
});
