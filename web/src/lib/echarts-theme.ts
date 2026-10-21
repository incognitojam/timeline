import { type EChartsOption, util } from "echarts";
import { chartSchemes } from "./chart-theme.generated";
import { type ColorScheme, createColorSchemeSignal } from "./theme";

type ChartScheme = (typeof chartSchemes)[ColorScheme];

function styleComponent<T extends object>(
  option: T | T[] | undefined,
  defaults: object,
): T | T[] | undefined {
  if (option === undefined) return undefined;
  const apply = (item: T): T => util.merge(util.clone(defaults), item, true);
  return Array.isArray(option) ? option.map(apply) : apply(option);
}

function styleOption(option: EChartsOption, s: ChartScheme): EChartsOption {
  if (option.baseOption) {
    return { ...option, baseOption: styleOption(option.baseOption, s) };
  }

  const axis = {
    axisLine: { lineStyle: { color: s.axis } },
    axisTick: { lineStyle: { color: s.axis } },
    axisLabel: { color: s.text },
    splitLine: { lineStyle: { color: s.split } },
  };
  return {
    ...option,
    color: option.color ?? [...s.palette],
    textStyle: { color: s.text, ...option.textStyle },
    xAxis: styleComponent(option.xAxis, axis),
    yAxis: styleComponent(option.yAxis, axis),
    legend: styleComponent(option.legend, { textStyle: { color: s.text } }),
    tooltip: styleComponent(option.tooltip, {
      backgroundColor: s.tooltipBg,
      borderColor: s.axis,
      textStyle: { color: s.tooltipText },
    }),
  };
}

/**
 * Applies the color scheme as option defaults, leaving chart-specific styles intact.
 * `palette` indexes hues for charts that assign colors explicitly (0 primary, 1 tertiary,
 * 2 secondary, 3/4 darker variants, 5 error — for alarming series).
 * Call within a component context (registers a media-query listener).
 */
export function useChartTheme() {
  const scheme = createColorSchemeSignal();
  return {
    option: (option: EChartsOption) => styleOption(option, chartSchemes[scheme()]),
    palette: () => chartSchemes[scheme()].palette,
  };
}
