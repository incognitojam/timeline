import { cleanup, render } from "@solidjs/testing-library";
import { type EChartsOption, getInstanceByDom, init, setPlatformAPI } from "echarts";
import { createMemo, createSignal } from "solid-js";
import { chartSchemes } from "../lib/chart-theme.generated";
import { useChartTheme } from "../lib/echarts-theme";
import type { ColorScheme } from "../lib/theme";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EChartsAutoSize } from "./echarts";
import { DateChart } from "./date-chart";

vi.mock("echarts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("echarts")>();
  return {
    ...actual,
    init: vi.fn<typeof actual.init>((element, theme, options) =>
      actual.init(element, theme, { ...options, renderer: "svg" }),
    ),
  };
});

// jsdom has no canvas text measurement; rendering and updates still use real ECharts.
setPlatformAPI({ measureText: (text) => ({ width: text.length * 6 }) });

let width = 600;
let height = 300;
let notifyResize: () => void;
const disconnect = vi.fn();
const resizeCallbacks = new Set<() => void>();
const schemeListeners = new Set<(event: { matches: boolean }) => void>();
const motionListeners = new Set<(event: { matches: boolean }) => void>();
let reducedMotion = false;
const fontFamily = '"Example UI Font", sans-serif';
const checkFont = vi.fn<FontFaceSet["check"]>();
const loadFont = vi.fn<FontFaceSet["load"]>();

function changeScheme(scheme: ColorScheme) {
  for (const listener of schemeListeners) listener({ matches: scheme === "dark" });
}

function changeMotion(reduced: boolean) {
  reducedMotion = reduced;
  for (const listener of motionListeners) listener({ matches: reduced });
}

function currentChart() {
  const instance = vi.mocked(init).mock.results.at(-1)?.value;
  if (!instance) throw new Error("Expected a mounted chart");
  return instance;
}

function option(title: string): EChartsOption {
  return {
    animation: false,
    title: { text: title },
    series: [{ type: "pie", data: [{ name: "Example", value: 10 }] }],
  };
}

describe("EChartsAutoSize", () => {
  beforeEach(() => {
    document.documentElement.style.setProperty("--font-sans", fontFamily);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { check: checkFont.mockReturnValue(true), load: loadFont.mockResolvedValue([]) },
    });
    width = 600;
    height = 300;
    vi.mocked(init).mockClear();
    disconnect.mockClear();
    resizeCallbacks.clear();
    schemeListeners.clear();
    motionListeners.clear();
    reducedMotion = false;
    vi.stubGlobal("matchMedia", (query: string) => {
      const isMotion = query === "(prefers-reduced-motion: reduce)";
      const listeners = isMotion ? motionListeners : schemeListeners;
      return {
        matches: isMotion ? reducedMotion : true,
        addEventListener: (_event: string, listener: (event: { matches: boolean }) => void) =>
          listeners.add(listener),
        removeEventListener: (_event: string, listener: (event: { matches: boolean }) => void) =>
          listeners.delete(listener),
      };
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: () => void) {
        resizeCallbacks.add(callback);
        notifyResize = () => { for (const notify of resizeCallbacks) notify(); };
      }
      observe() {}
      disconnect() {
        resizeCallbacks.delete(this.callback);
        disconnect();
      }
    });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.style.removeProperty("--font-sans");
    Reflect.deleteProperty(document, "fonts");
    checkFont.mockReset();
    loadFont.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders reactive options without replacing the chart instance", () => {
    const [options, setOptions] = createSignal(option("First chart"));
    const view = render(() => <EChartsAutoSize option={options()} />);

    expect(view.container.querySelector("svg")).not.toBeNull();
    expect(view.getByText("First chart")).toBeInTheDocument();
    expect(currentChart().getWidth()).toBe(600);
    expect(currentChart().getHeight()).toBe(300);
    expect(currentChart().getOption()).toMatchObject({ textStyle: { fontFamily } });
    expect(view.getByText("First chart")).toHaveStyle({ fontFamily });

    setOptions(option("Updated chart"));

    expect(view.queryByText("First chart")).not.toBeInTheDocument();
    expect(view.getByText("Updated chart")).toBeInTheDocument();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("honors motion preferences without resetting zoom or animation choices (responsive: %s)", (responsive) => {
    reducedMotion = true;
    const [title] = createSignal("Chart");
    const input: EChartsOption = {
      xAxis: { data: ["A", "B", "C"] },
      yAxis: {},
      dataZoom: [{ type: "inside", start: 0, end: 100 }],
      series: [
        { id: "animated", type: "line", animation: true, data: [1, 2, 3] },
        { id: "static", type: "line", animation: false, data: [3, 2, 1] },
      ],
    };
    const view = render(() => <EChartsAutoSize option={responsive ? {
      baseOption: { ...input, title: { text: title() } },
      media: [{ query: { maxWidth: 700 }, option: { title: { text: "Responsive chart" } } }],
    } : { ...input, title: { text: title() } }} />);
    const instance = currentChart();
    expect(instance.getOption()).toMatchObject({ animation: false, series: [{ animation: false }, { animation: false }] });
    instance.dispatchAction({ type: "dataZoom", start: 25, end: 75 });

    changeMotion(false);
    expect(instance.getOption()).toMatchObject({
      animation: true,
      series: [{ animation: true }, { animation: false }],
      dataZoom: [{ start: 25, end: 75 }],
    });
    changeMotion(true);
    expect(instance.getOption()).toMatchObject({ animation: false, series: [{ animation: false }, { animation: false }] });
    expect(input.series).toMatchObject([{ animation: true }, { animation: false }]);
    expect(init).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(motionListeners.size).toBe(0);
  });

  it("keeps charts busy until fonts, rendering, and container resizing finish", async () => {
    checkFont.mockReturnValue(false);
    const loading = Promise.withResolvers<FontFace[]>();
    loadFont.mockReturnValue(loading.promise);
    const view = render(() => <EChartsAutoSize option={option("Chart")} />);
    const element = view.container.querySelector("[data-chart]");
    const instance = currentChart();
    instance.getZr().flush();
    expect(element).toHaveAttribute("aria-busy", "true");

    loading.resolve([]);
    await loading.promise;
    instance.getZr().flush();
    expect(element).toHaveAttribute("aria-busy", "false");

    width = 320;
    notifyResize();
    expect(element).toHaveAttribute("aria-busy", "true");
    vi.advanceTimersToNextFrame();
    instance.getZr().flush();
    expect(instance.getWidth()).toBe(320);
    expect(element).toHaveAttribute("aria-busy", "false");
    notifyResize();
    vi.advanceTimersToNextFrame();
    expect(element).toHaveAttribute("aria-busy", "false");
  });

  it("keeps all data while thinning date ticks on narrow canvases", () => {
    width = 700;
    const dates = Array.from({ length: 31 }, (_, index) => `2025-08-${String(index + 1).padStart(2, "0")}`);
    const [view, setView] = createSignal<"week" | "month">("month");
    const [days, setDays] = createSignal(dates);
    const rendered = render(() => <DateChart view={view()} option={{
      animation: false,
      xAxis: { type: "category", data: days() },
      yAxis: { type: "value" },
      series: [{ type: "bar", data: days().map(() => 100) }],
    }} />);
    const instance = currentChart();
    expect(instance.getWidth()).toBe(width);
    for (let day = 1; day <= 31; day++) expect(rendered.getByText(String(day), { selector: 'text[text-anchor="middle"]' })).toBeInTheDocument();
    expect(rendered.getByText("Aug")).toBeInTheDocument();
    expect(rendered.getByRole("region")).not.toHaveAttribute("tabindex");

    width = 320;
    notifyResize();
    vi.advanceTimersToNextFrame();
    expect(instance.getWidth()).toBe(320);
    expect(rendered.getByText("31")).toBeInTheDocument();
    expect(rendered.queryByText("2", { selector: 'text[text-anchor="middle"]' })).not.toBeInTheDocument();
    expect(instance.getOption()).toMatchObject({
      xAxis: [{ data: dates }],
      series: [{ data: dates.map(() => 100) }],
    });
    const ticks = [...rendered.container.querySelectorAll('text[text-anchor="middle"]')].filter(node => /^\d+$/.test(node.textContent ?? ""));
    expect(new Set(ticks.map(node => node.getAttribute("y"))).size).toBe(1);

    width = 1400;
    notifyResize();
    vi.advanceTimersToNextFrame();
    expect(instance.getWidth()).toBe(1400);

    setDays(dates.slice(0, 7));
    setView("week");
    width = 600;
    notifyResize();
    vi.advanceTimersToNextFrame();
    expect(instance.getWidth()).toBe(600);
    expect(rendered.queryByText("31")).not.toBeInTheDocument();
    for (const day of ["Fri", "Sat", "Sun", "Mon", "Tue", "Wed", "Thu"]) {
      expect(rendered.getByText(day)).toBeInTheDocument();
    }
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("uses the measured date layout on its first render when the font is cached", () => {
    width = 320;
    const initialize = vi.mocked(init).getMockImplementation();
    if (!initialize) throw new Error("Missing chart initializer");
    const received: unknown[] = [];
    vi.mocked(init).mockImplementationOnce((...args) => {
      const instance = initialize(...args);
      const setOption = instance.setOption.bind(instance);
      vi.spyOn(instance, "setOption").mockImplementation((option) => {
        received.push(option);
        setOption(option);
      });
      return instance;
    });
    const dates = Array.from({ length: 31 }, (_, index) => `2025-08-${String(index + 1).padStart(2, "0")}`);
    render(() => <DateChart view="month" option={{
      animation: false,
      xAxis: { type: "category", data: dates },
      yAxis: { type: "value" },
      series: [{ type: "bar", data: dates.map(() => 100) }],
    }} />);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ grid: { left: "3%", right: "4%", containLabel: true }, textStyle: { fontFamily } });
  });

  it("applies a changed date layout and canvas size in the same resize notification", () => {
    const dates = Array.from({ length: 31 }, (_, index) => `2025-08-${String(index + 1).padStart(2, "0")}`);
    render(() => <DateChart view="month" option={{
      xAxis: { type: "category", data: dates },
      yAxis: { type: "value" },
      series: [{ type: "bar", data: dates.map(() => 100) }],
    }} />);
    const instance = currentChart();
    const setOption = vi.spyOn(instance, "setOption");
    const resize = vi.spyOn(instance, "resize");
    width = 320;
    notifyResize();
    expect(instance.getWidth()).toBe(320);
    expect(setOption).toHaveBeenCalledWith(expect.objectContaining({ grid: expect.objectContaining({ containLabel: true }) }), { lazyUpdate: true });
    expect(resize).toHaveBeenCalledOnce();
    vi.advanceTimersToNextFrame();
    expect(resize).toHaveBeenCalledOnce();
  });

  it("paints a date chart once with its measured layout and loaded font", async () => {
    width = 320;
    checkFont.mockReturnValue(false);
    const loading = Promise.withResolvers<FontFace[]>();
    loadFont.mockReturnValue(loading.promise);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      const parentHeight = this.parentElement?.style.height;
      return parentHeight?.endsWith("px") ? Number.parseFloat(parentHeight) : height;
    });
    const dates = Array.from({ length: 31 }, (_, index) => `2025-08-${String(index + 1).padStart(2, "0")}`);
    const rendered = render(() => <DateChart view="month" height={192} option={{
      animation: false,
      xAxis: { type: "category", data: dates },
      yAxis: { type: "value" },
      series: [{ type: "bar", data: dates.map(() => 100) }],
    }} />);
    expect(init).not.toHaveBeenCalled();
    expect(rendered.getByRole("region")).toHaveStyle({ height: "192px" });

    // The eventual first paint must use the latest width, even if it changed during font loading.
    width = 600;
    notifyResize();
    vi.advanceTimersToNextFrame();
    expect(init).not.toHaveBeenCalled();
    expect(rendered.getByRole("region")).toHaveStyle({ height: "192px" });
    loading.resolve([]);
    await loading.promise;

    expect(init).toHaveBeenCalledExactlyOnceWith(expect.any(HTMLElement), undefined, { width: 600, height: 192 });
    expect(currentChart().getOption()).toMatchObject({
      textStyle: { fontFamily },
      grid: [{ left: "3%", right: "4%", containLabel: true }],
    });
    const setOption = vi.spyOn(currentChart(), "setOption");
    const resize = vi.spyOn(currentChart(), "resize");
    notifyResize();
    vi.advanceTimersToNextFrame();
    expect(setOption).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
  });

  it("updates colors once per scheme change while keeping current data and legend selection", () => {
    const [value, setValue] = createSignal(10);
    const view = render(() => {
      const chart = useChartTheme();
      const options = createMemo((): EChartsOption => ({
        animation: false,
        title: { text: `Value ${value()}` },
        legend: {},
        series: [{
          type: "pie",
          data: [{ name: "Example", value: value() }, { name: "Other", value: 5 }],
          label: { formatter: "{b}: {c}" },
          itemStyle: { color: chart.palette()[1] },
        }],
      }));
      return <EChartsAutoSize option={chart.option(options())} />;
    });
    setValue(42);
    expect(view.getByText("Value 42")).toBeInTheDocument();
    const instance = currentChart();
    instance.dispatchAction({ type: "legendUnSelect", name: "Other" });
    const updated = vi.fn();
    instance.on("updated", updated);

    for (const scheme of ["light", "dark"] as const) {
      updated.mockClear();
      changeScheme(scheme);
      const colors = chartSchemes[scheme];

      expect(view.getByText("Value 42")).toBeInTheDocument();
      expect(view.getByText("Example: 42")).toBeInTheDocument();
      expect(view.container.querySelector(`path[fill="${colors.palette[1]}"]`)).not.toBeNull();
      expect(instance.getOption()).toMatchObject({
        color: [...colors.palette],
        legend: [{ selected: { Other: false }, textStyle: { color: colors.text } }],
      });
      expect(updated).toHaveBeenCalledTimes(1);
      expect(init).toHaveBeenCalledTimes(1);
    }
    expect(instance.getOption()).not.toHaveProperty("xAxis");
    expect(instance.getOption()).not.toHaveProperty("yAxis");
  });

  it("styles every axis and tooltip while preserving overrides and interactive zoom", () => {
    const formatLabel = (value: string) => `Label ${value}`;
    const input: EChartsOption = {
      animation: false,
      color: ["#123456"],
      textStyle: { fontSize: 13 },
      tooltip: { trigger: "axis", textStyle: { fontSize: 14 } },
      xAxis: {
        type: "category",
        data: ["A", "B", "C", "D"],
        axisLabel: { formatter: formatLabel },
        axisLine: { lineStyle: { width: 2 } },
      },
      yAxis: [
        { type: "value" },
        { type: "value", splitLine: { show: false }, axisLabel: { color: "#654321" } },
      ],
      dataZoom: [{ type: "inside" }],
      series: [{ type: "line", data: [10, 20, 30, 40] }],
    };
    render(() => {
      const chart = useChartTheme();
      return <EChartsAutoSize option={chart.option(input)} />;
    });
    const instance = currentChart();
    instance.dispatchAction({ type: "dataZoom", start: 25, end: 75 });
    const updated = vi.fn();
    instance.on("updated", updated);

    changeScheme("light");
    const colors = chartSchemes.light;
    expect(instance.getOption()).toMatchObject({
      color: ["#123456"],
      textStyle: { color: colors.text, fontSize: 13 },
      xAxis: [{
        axisLine: { lineStyle: { color: colors.axis, width: 2 } },
        axisTick: { lineStyle: { color: colors.axis } },
        axisLabel: { color: colors.text, formatter: formatLabel },
      }],
      yAxis: [
        { axisLabel: { color: colors.text }, splitLine: { lineStyle: { color: colors.split } } },
        { axisLabel: { color: "#654321" }, splitLine: { show: false } },
      ],
      tooltip: [{
        trigger: "axis",
        backgroundColor: colors.tooltipBg,
        borderColor: colors.axis,
        textStyle: { color: colors.tooltipText, fontSize: 14 },
      }],
      dataZoom: [{ start: 25, end: 75 }],
    });
    expect(updated).toHaveBeenCalledTimes(1);
    expect(input).not.toHaveProperty("xAxis.axisLine.lineStyle.color");
    expect(input).not.toHaveProperty("tooltip.backgroundColor");
  });

  it("does not subscribe to signal reads inside ECharts formatters", () => {
    const [caption, setCaption] = createSignal("Initial label");
    const initial: EChartsOption = {
      animation: false,
      series: [{
        type: "pie",
        data: [{ value: 10 }],
        label: { formatter: () => caption() },
      }],
    };
    const [options, setOptions] = createSignal(initial);
    const view = render(() => <EChartsAutoSize option={options()} />);
    expect(view.getByText("Initial label")).toBeInTheDocument();
    const setOption = vi.spyOn(currentChart(), "setOption");

    setCaption("Updated label");
    expect(setOption).not.toHaveBeenCalled();

    setOptions({ ...initial, title: { text: "Updated chart" } });
    expect(view.getByText("Updated label")).toBeInTheDocument();
    expect(setOption).toHaveBeenCalledTimes(1);
  });

  it("coalesces container resizes and reapplies responsive media options", () => {
    const view = render(() => {
      const chart = useChartTheme();
      return <EChartsAutoSize option={chart.option({
        baseOption: option("Wide chart"),
        media: [
          { query: { maxWidth: 480 }, option: { title: { text: "Narrow chart" } } },
          { option: { title: { text: "Wide chart" } } },
        ],
      })} />;
    });
    const instance = currentChart();
    const resize = vi.spyOn(instance, "resize");
    const setOption = vi.spyOn(instance, "setOption");

    width = 390;
    height = 200;
    notifyResize();
    notifyResize();
    vi.advanceTimersToNextFrame();
    instance.getZr().flush();

    expect(resize).toHaveBeenCalledTimes(1);
    expect(instance.getWidth()).toBe(390);
    expect(instance.getHeight()).toBe(200);
    expect(view.getByText("Narrow chart")).toBeInTheDocument();
    expect(setOption).not.toHaveBeenCalled();

    notifyResize();
    vi.advanceTimersToNextFrame();
    expect(resize).toHaveBeenCalledTimes(1);
    changeScheme("light");
    expect(view.getByText("Narrow chart")).toBeInTheDocument();
    expect(instance.getOption()).toMatchObject({ color: [...chartSchemes.light.palette] });
  });

  it("waits for a visible container and initializes with the latest props", () => {
    width = 0;
    const [options, setOptions] = createSignal(option("Hidden chart"));
    const view = render(() => {
      const chart = useChartTheme();
      return <EChartsAutoSize option={chart.option(options())} />;
    });
    expect(init).not.toHaveBeenCalled();

    setOptions(option("Visible chart"));
    changeScheme("light");
    width = 400;
    notifyResize();
    vi.advanceTimersToNextFrame();

    expect(view.getByText("Visible chart")).toBeInTheDocument();
    expect(currentChart().getOption()).toMatchObject({ color: [...chartSchemes.light.palette] });
    expect(init).toHaveBeenCalledTimes(1);

    height = 0;
    notifyResize();
    vi.advanceTimersToNextFrame();
    expect(currentChart().getHeight()).toBe(300);

    height = 250;
    notifyResize();
    vi.advanceTimersToNextFrame();
    expect(currentChart().getHeight()).toBe(250);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("disposes the chart and cancels queued resizing on unmount", () => {
    const view = render(() => <EChartsAutoSize option={option("Chart")} />);
    const instance = currentChart();
    const element = instance.getDom();
    notifyResize();

    view.unmount();

    expect(disconnect).toHaveBeenCalledOnce();
    expect(instance.isDisposed()).toBe(true);
    expect(getInstanceByDom(element)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can unmount before its container becomes visible", () => {
    height = 0;
    const view = render(() => <EChartsAutoSize option={option("Hidden chart")} />);
    notifyResize();
    view.unmount();

    expect(disconnect).toHaveBeenCalledOnce();
    expect(init).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("swaps the font after loading without losing current data or zoom", async () => {
    checkFont.mockReturnValue(false);
    const loading = Promise.withResolvers<FontFace[]>();
    loadFont.mockReturnValue(loading.promise);
    const [options, setOptions] = createSignal<EChartsOption>({
      animation: false,
      xAxis: { data: ["A", "B", "C"] },
      yAxis: {},
      dataZoom: [{ type: "inside", start: 0, end: 100 }],
      series: [{ type: "line", data: [1, 2, 3] }],
    });
    const view = render(() => <EChartsAutoSize option={options()} />);
    const instance = currentChart();
    expect(view.container.querySelector("svg")).not.toBeNull();
    expect(instance.getOption()).toMatchObject({ textStyle: { fontFamily: "sans-serif" } });
    setOptions({ ...options(), series: [{ type: "line", data: [4, 5, 6] }] });
    instance.dispatchAction({ type: "dataZoom", start: 25, end: 75 });

    loading.resolve([]);
    await loading.promise;

    expect(loadFont).toHaveBeenCalledWith(`12px ${fontFamily}`);
    expect(init).toHaveBeenCalledTimes(1);
    expect(instance.getOption()).toMatchObject({
      textStyle: { fontFamily },
      dataZoom: [{ start: 25, end: 75 }],
      series: [{ data: [4, 5, 6] }],
    });
  });

  it("preserves an explicit chart font in responsive options", () => {
    render(() => <EChartsAutoSize option={{ baseOption: {
      ...option("Custom font"), textStyle: { fontFamily: "serif" },
    } }} />);
    expect(currentChart().getOption()).toMatchObject({ textStyle: { fontFamily: "serif" } });
  });

  it("keeps the fallback chart usable when the font fails to load", async () => {
    checkFont.mockReturnValue(false);
    const error = new Error("Font unavailable");
    loadFont.mockRejectedValue(error);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = render(() => <EChartsAutoSize option={option("Fallback chart")} />);
    await Promise.resolve();
    expect(view.getByText("Fallback chart")).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith("Could not load chart font", error);
  });

  it("renders a deferred chart if its font fails to load", async () => {
    checkFont.mockReturnValue(false);
    loadFont.mockRejectedValue(new Error("Font unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = render(() => <EChartsAutoSize option={option("Fallback chart")} waitForFont />);
    expect(init).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(view.getByText("Fallback chart")).toBeInTheDocument();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("does not update a disposed chart when the font finishes loading", async () => {
    checkFont.mockReturnValue(false);
    const loading = Promise.withResolvers<FontFace[]>();
    loadFont.mockReturnValue(loading.promise);
    const view = render(() => <EChartsAutoSize option={option("Chart")} />);
    const instance = currentChart();
    const setOption = vi.spyOn(instance, "setOption");
    view.unmount();
    loading.resolve([]);
    await loading.promise;
    expect(instance.isDisposed()).toBe(true);
    expect(setOption).not.toHaveBeenCalled();
    expect(init).toHaveBeenCalledTimes(1);
  });
});
