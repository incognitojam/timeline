import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DateSidebar from "./DateSidebar";

const dateActivityMocks = vi.hoisted(() => ({
  dateSource: () => [
    { date: "2026-07-14", eventCount: 4 },
    { date: "2016-02-03", eventCount: 2 },
  ],
  useDateActivityQuery: vi.fn(),
}));

vi.mock("../../lib/dateActivityQueries", () => ({
  useDateActivityQuery: () => {
    dateActivityMocks.useDateActivityQuery();
    return {
      get data() {
        return { dates: dateActivityMocks.dateSource() };
      },
      get isPending() {
        return false;
      },
    };
  },
}));

vi.mock("./DateActivityList", () => ({
  default: () => null,
}));

describe("DateSidebar", () => {
  beforeEach(() => {
    dateActivityMocks.dateSource = () => [
      { date: "2026-07-14", eventCount: 4 },
      { date: "2016-02-03", eventCount: 2 },
    ];
    dateActivityMocks.useDateActivityQuery.mockClear();
  });

  it("shares one complete activity index with the calendar", () => {
    const [activities, setActivities] = createSignal([
      { date: "2026-07-14", eventCount: 4 },
      { date: "2016-02-03", eventCount: 2 },
    ]);
    dateActivityMocks.dateSource = activities;

    const view = render(() => (
      <DateSidebar selectedDate="2026-07-13" onSelectDate={() => undefined} />
    ));

    expect(dateActivityMocks.useDateActivityQuery).toHaveBeenCalledTimes(1);
    expect(view.container.querySelectorAll("span.w-1.h-1.bg-primary")).toHaveLength(
      1,
    );
    expect(view.getByRole("option", { name: "2016" })).toBeInTheDocument();

    setActivities([
      { date: "2026-07-14", eventCount: 4 },
      { date: "2026-07-15", eventCount: 3 },
      { date: "2016-02-03", eventCount: 2 },
    ]);

    expect(view.container.querySelectorAll("span.w-1.h-1.bg-primary")).toHaveLength(
      2,
    );
    view.unmount();
  });
});
