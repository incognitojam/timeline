import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DateActivity } from "../../lib/dateActivityQueries";
import DateActivityList from "./DateActivityList";

const AUGUST_DATES: DateActivity[] = [
  { date: "2026-08-10", eventCount: 40 },
  { date: "2026-08-04", eventCount: 12 },
  { date: "2026-07-31", eventCount: 6 },
];

function renderList(
  selectedDate = "2026-08-10",
  initialDates: DateActivity[] = AUGUST_DATES,
) {
  const [date, setDate] = createSignal(selectedDate);
  const [dates, setDates] = createSignal(initialDates);
  const view = render(() => (
    <div class="relative">
      <DateActivityList
        dates={dates()}
        isLoading={false}
        selectedDate={date()}
        onSelectDate={() => undefined}
      />
    </div>
  ));

  return { view, setDate, setDates };
}

describe("DateActivityList", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(Element.prototype, "scrollTo");
  });

  it("labels every month the dates run through", () => {
    const { view } = renderList();

    expect(view.getByText("August 2026")).toBeInTheDocument();
    expect(view.getByText("July 2026")).toBeInTheDocument();
  });

  it("still lists each active date", () => {
    const { view } = renderList();

    expect(view.container.querySelectorAll("button[data-date]")).toHaveLength(3);
    expect(
      view.container.querySelector("button[data-date='2026-08-10']"),
    ).toHaveTextContent("40");
  });

  it("scales bars to busy days in their month without flattening ordinary days", () => {
    const dates: DateActivity[] = Array.from({ length: 12 }, (_, index) => ({
      date: `2026-08-${String(20 - index).padStart(2, "0")}`,
      eventCount: index === 11 ? 500_000 : index === 1 ? 2_500 : 5_000,
    }));
    const { view } = renderList("2026-08-20", dates);
    const barFor = (date: string) => {
      const row = view.container.querySelector(`button[data-date='${date}']`);
      if (!row) throw new Error(`No row for ${date}`);
      const bar = row.querySelector(".bg-primary");
      if (!(bar instanceof HTMLElement)) throw new Error(`No bar for ${date}`);
      return bar;
    };

    expect(barFor("2026-08-20").style.width).toBe("100%");
    expect(barFor("2026-08-19").style.width).toBe("50%");
    expect(barFor("2026-08-09").style.width).toBe("100%");
  });

  it("keeps each month divider as the same heading while scrolling", () => {
    const { view } = renderList();
    const august = view.getByText("August 2026");
    const july = view.getByText("July 2026");
    const scroller = view.container.querySelector(".overflow-auto");
    if (!(scroller instanceof HTMLElement)) throw new Error("no scroll container");

    scroller.scrollTop = 80;
    scroller.dispatchEvent(new Event("scroll"));
    expect(view.getByText("August 2026")).toBe(august);
    expect(view.getByText("July 2026")).toBe(july);

    scroller.scrollTop = 96;
    scroller.dispatchEvent(new Event("scroll"));
    expect(view.queryByText("August 2026")).not.toBeInTheDocument();
    expect(view.getByText("July 2026")).toBe(july);

    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    expect(view.getByText("August 2026")).toBeInTheDocument();
  });

  it("clears month dividers when the index becomes empty", () => {
    const { view, setDates } = renderList();
    setDates([]);
    expect(view.queryByText("August 2026")).not.toBeInTheDocument();
    expect(view.queryByText("July 2026")).not.toBeInTheDocument();
  });

  it("virtualizes a complete multi-year index without fetching on scroll", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const dates: DateActivity[] = [];
    const day = new Date("2026-08-10T12:00:00Z");
    for (let index = 0; index < 4_000; index += 1) {
      dates.push({
        date: day.toISOString().slice(0, 10),
        eventCount: index + 1,
      });
      day.setUTCDate(day.getUTCDate() - 1);
    }
    const { view } = renderList("2026-08-10", dates);
    const scroller = view.container.querySelector(".overflow-auto");
    if (!(scroller instanceof HTMLElement)) throw new Error("no scroll container");

    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      value: 80_000,
    });
    scroller.dispatchEvent(new Event("scroll"));

    expect(view.container.querySelectorAll("button[data-date]").length).toBeLessThan(
      40,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

function installScrolling() {
  const scrollTops = new WeakMap<Element, number>();
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      scrollTops.set(this, value);
      this.dispatchEvent(new Event("scroll"));
    },
  });
  Element.prototype.scrollTo = vi.fn(function (
    this: Element,
    options: ScrollToOptions,
  ) {
    this.scrollTop = options.top ?? 0;
  }) as typeof Element.prototype.scrollTo;
}

function uninstallScrolling() {
  Reflect.deleteProperty(Element.prototype, "scrollTop");
  Reflect.deleteProperty(Element.prototype, "scrollTo");
}

describe("DateActivityList centring", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    installScrolling();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    uninstallScrolling();
  });

  function renderedDates(
    view: ReturnType<typeof renderList>["view"],
  ): string[] {
    return [...view.container.querySelectorAll("button[data-date]")].map(
      (button) => button.getAttribute("data-date") ?? "",
    );
  }

  function listHeight(view: ReturnType<typeof renderList>["view"]): number {
    const spacer = view.container.querySelector<HTMLElement>(
      ".overflow-auto > div",
    );
    if (!spacer) throw new Error("no list spacer");
    return Number.parseInt(spacer.style.height, 10);
  }

  it("centres a deep-linked date when the complete index arrives", () => {
    const { view, setDates } = renderList("2016-08-09", []);
    expect(renderedDates(view)).toEqual([]);

    setDates([
      { date: "2026-08-10", eventCount: 5 },
      { date: "2016-08-09", eventCount: 5 },
      { date: "2006-08-08", eventCount: 5 },
    ]);

    expect(renderedDates(view)).toContain("2016-08-09");
  });

  it("follows the selection to another year without loading another page", () => {
    const { view, setDate } = renderList("2016-08-09", [
      { date: "2026-08-10", eventCount: 5 },
      { date: "2016-08-09", eventCount: 5 },
      { date: "2006-08-08", eventCount: 5 },
    ]);

    setDate("2026-08-10");

    expect(renderedDates(view)).toContain("2026-08-10");
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled();
  });

  it("holds the visible day in place when a refresh prepends a new date", () => {
    const { view, setDates } = renderList("2016-08-09", [
      { date: "2016-08-09", eventCount: 5 },
      { date: "2016-08-08", eventCount: 5 },
    ]);
    const scroller = view.container.querySelector(".overflow-auto");
    if (!(scroller instanceof HTMLElement)) throw new Error("no scroll container");
    const before = { top: scroller.scrollTop, height: listHeight(view) };

    setDates([
      { date: "2016-09-01", eventCount: 5 },
      { date: "2016-08-09", eventCount: 5 },
      { date: "2016-08-08", eventCount: 5 },
    ]);

    const prepended = (listHeight(view) - before.height) / 32;
    expect(prepended).toBe(2);
    expect(scroller.scrollTop).toBe(before.top + prepended * 32);
    expect(renderedDates(view)).toContain("2016-08-09");
  });
});
