import { createMemo, createResource, For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { fetchDayHealth, type MetricWithRange, type RangeStatus } from "../../lib/api";
import {
  formatActiveMinutes,
  formatBreathingRate,
  formatCalories,
  formatEfficiency,
  formatHeartRate,
  formatHRV,
  formatSkinTemp,
  formatSleepDuration,
  formatSpO2,
  formatSteps,
  getRangeStatusColor,
  getRangeStatusIcon,
  getRangeStatusText,
  getSleepScoreColor,
} from "../../lib/health-utils";
import { IconBedtime, IconBolt, IconLocalFireDepartment, IconSteps } from "../../ui/icons";

interface Props {
  date: string;
}

// Inline metric names for the vitals strip
const METRIC_NAMES: Record<string, string> = {
  restingHR: "resting HR",
  hrv: "HRV",
  spo2: "SpO2",
  breathingRate: "breathing",
  skinTempVariation: "skin temp",
};

// Format a metric value
function formatMetricValue(key: string, value: number): string {
  switch (key) {
    case "restingHR": return formatHeartRate(value);
    case "hrv": return formatHRV(value);
    case "spo2": return formatSpO2(value);
    case "breathingRate": return formatBreathingRate(value);
    case "skinTempVariation": return formatSkinTemp(value);
    default: return String(value);
  }
}

// Metric name plus its personal range, e.g. "resting HR · 55–65"
function metricLabel(key: string, metric: MetricWithRange): string {
  const name = METRIC_NAMES[key] ?? key;
  const [low, high] = metric.personalRange;
  if (low === 0 && high === 0) return name;
  return `${name} · ${Math.round(low)}–${Math.round(high)}`;
}

function RangeStatusIcon(props: { status: RangeStatus }) {
  return (
    <Dynamic
      component={getRangeStatusIcon(props.status)}
      class={`h-4 w-4 shrink-0 ${getRangeStatusColor(props.status)}`}
      aria-hidden
    />
  );
}

// One stat in the strip: icon, mono value, muted label
function Stat(props: {
  icon: JSX.Element;
  value: string;
  label: string;
  valueClass?: string;
  title?: string;
}) {
  return (
    <div class="flex items-center gap-1.5" title={props.title}>
      {props.icon}
      <span class={`font-mono text-sm font-semibold tabular-nums ${props.valueClass ?? ""}`}>
        {props.value}
      </span>
      <span class="text-xs text-muted-foreground">{props.label}</span>
    </div>
  );
}

export default function DayHealthPanel(props: Props) {
  const [data] = createResource(
    () => props.date,
    (date) => fetchDayHealth(date)
  );

  // Check if we have anything worth displaying
  const hasContent = createMemo(() => {
    const stats = data();
    if (!stats) return false;
    return !!(stats.activity || stats.sleep || stats.totalMetricCount > 0);
  });

  // Get out-of-range and in-range metrics
  const outOfRangeMetrics = createMemo(() => {
    const stats = data();
    if (!stats) return [];
    const metrics = stats.healthMetrics;
    const result: { key: string; metric: MetricWithRange }[] = [];
    for (const [key, metric] of Object.entries(metrics)) {
      if (metric && metric.status !== "in_range") {
        result.push({ key, metric });
      }
    }
    return result;
  });

  const inRangeMetricNames = createMemo(() => {
    const stats = data();
    if (!stats) return [];
    const metrics = stats.healthMetrics;
    const names: string[] = [];
    for (const [key, metric] of Object.entries(metrics)) {
      if (metric && metric.status === "in_range") {
        names.push(METRIC_NAMES[key] || key);
      }
    }
    return names;
  });

  return (
    <Show when={!data.loading && hasContent()}>
      <section class="mb-6">
        <div class="flex w-full items-center gap-2 py-1">
          <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Vitals
          </span>
          <span class="h-px flex-1 bg-border" />
        </div>
        <div class="flex flex-wrap items-center gap-x-6 gap-y-2 pt-3">
          <Show when={data()?.activity}>
            {(activity) => (
              <>
                <Stat
                  icon={<IconSteps class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                  value={formatSteps(activity().steps)}
                  label="steps"
                />
                <Stat
                  icon={<IconLocalFireDepartment class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                  value={formatCalories(activity().caloriesOut)}
                  label="kcal"
                />
                <Stat
                  icon={<IconBolt class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                  value={formatActiveMinutes(activity().activeMinutes)}
                  label={activity().floors ? `active · ${activity().floors} floors` : "active"}
                />
              </>
            )}
          </Show>
          <Show when={data()?.sleep}>
            {(sleep) => (
              <Show
                when={sleep().score}
                fallback={
                  <Stat
                    icon={<IconBedtime class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                    value={formatSleepDuration(sleep().duration)}
                    label={`sleep · ${formatEfficiency(sleep().efficiency)} eff`}
                  />
                }
              >
                {(score) => (
                  <Stat
                    icon={<IconBedtime class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                    value={`${Math.round(score().score)}`}
                    valueClass={getSleepScoreColor(score().score)}
                    label={`${formatSleepDuration(sleep().duration)} sleep · ${formatEfficiency(sleep().efficiency)} eff`}
                    title="Sleep score"
                  />
                )}
              </Show>
            )}
          </Show>
          <For each={outOfRangeMetrics()}>
            {(item) => (
              <Stat
                icon={<RangeStatusIcon status={item.metric.status} />}
                value={formatMetricValue(item.key, item.metric.value)}
                valueClass={getRangeStatusColor(item.metric.status)}
                label={metricLabel(item.key, item.metric)}
                title={getRangeStatusText(
                  item.metric.status,
                  item.metric.personalRange[0],
                  item.metric.personalRange[1]
                )}
              />
            )}
          </For>
          <Show when={inRangeMetricNames().length > 0}>
            <div class="flex items-center gap-1.5" title={inRangeMetricNames().join(", ")}>
              <RangeStatusIcon status="in_range" />
              <span class="text-xs text-muted-foreground">
                {outOfRangeMetrics().length > 0
                  ? `${inRangeMetricNames().length} in range`
                  : "vitals in range"}
              </span>
            </div>
          </Show>
        </div>
      </section>
    </Show>
  );
}
